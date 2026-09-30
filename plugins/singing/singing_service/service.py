"""The queue: song requests in, prepared songs out, one song prepared at a time.

The rules that matter on a live stream, and the mistakes of the legacy service they replace:

  * The per-user and queue limits are checked again, and the entry inserted, under one hold of the lock, after the
    (slow) search. Two requests from one viewer that were both past the early check cannot both get in.
  * A request has an id. The same id twice answers the same thing (never two entries), and a request whose caller
    gave up (its time ran out, or it said so with `abandon`) is never queued afterwards: no ghost entries.
  * Removing, cancelling or skipping an entry cancels the job working on it: the pipeline looks before every step and
    a running tool is killed. A removed song does not finish preparing in the background.
  * A failure of the source (a blip, the breaker, the download cap) is not a rejection of the song. Blips are retried a
    few times with a delay; the rest mark the entry failed and retryable.
  * After a restart only requests newer than `restore_within_min` come back.

Everything the outside asks goes through the public methods; each takes the lock and returns plain JSON-able data.
"""

from __future__ import annotations

import collections
import logging
import math
import os
import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

from . import __version__, library
from .control import Cancel, Deadline
from .errors import Abandoned, SingingError, SourceUnavailable, StepFailed
from .lyrics import parse_lrc
from .messages import DEFAULT_MESSAGES, message
from .pipeline import Pipeline
from .settings import Config
from .sources.base import SongSource
from .sources.matching import Song, best_match
from .util import check_song_id, fmt_duration, read_json, write_json_atomic

WAITING = ('queued', 'downloading', 'processing', 'ready')
OUTCOMES = ('done', 'skipped', 'stopped', 'interrupted', 'failed', 'released')
MAX_KEYWORD = 200
KEEP_REQUESTS = 500
#: A song that nobody reports on is taken to be over after its length and this much more.
CURRENT_GRACE_SEC = 120.0


class _Job:
    """The work being done for one entry: what to tell it when the entry is removed."""

    def __init__(self, qid: int) -> None:
        self.qid = qid
        self.cancel = Cancel()


class _Request:
    """What the service remembers of a request id, so that asking twice is not asking twice."""

    def __init__(self, request_id: str) -> None:
        self.id = request_id
        self.state = 'pending'  # pending | done
        self.result: dict[str, Any] | None = None
        self.abandoned = False
        self.event = threading.Event()


def _song_view(song: Song) -> dict[str, Any]:
    return {
        'id': str(song['id']),
        'title': song.get('name', ''),
        'artists': list(song.get('artists', [])),
        'duration': float(song.get('duration') or 0),
    }


def _public(it: dict[str, Any]) -> dict[str, Any]:
    keys = (
        'qid', 'song_id', 'artists', 'duration', 'requester_uid', 'requester_name', 'state', 'cached', 'reason',
        'code', 'retryable', 'error', 'warnings', 'transpose', 'requested_at', 'started_at', 'failed_at', 'attempts',
    )
    view = {k: it[k] for k in keys if k in it}
    view['title'] = it.get('name', '')
    return view


class SingingService:
    def __init__(
        self,
        config: Config,
        source: SongSource,
        pipeline: Pipeline,
        *,
        clock: Callable[[], float] = time.time,
        mono: Callable[[], float] = time.monotonic,
        autostart: bool = True,
        log: logging.Logger | None = None,
    ) -> None:
        self.config = config
        self.s = config.settings
        self.source = source
        self.pipeline = pipeline
        self._clock = clock
        self._mono = mono
        self.log = log or logging.getLogger('singing.service')
        self._lock = threading.RLock()
        self._wake = threading.Condition(self._lock)
        self._closing = threading.Event()
        self.items: list[dict[str, Any]] = []  # waiting entries, and failed ones for a while
        self.current: dict[str, Any] | None = None
        self.next_qid = 1
        self.worker_state: dict[str, Any] = {'state': 'idle'}
        self._jobs: dict[int, _Job] = {}
        self._requests: collections.OrderedDict[str, _Request] = collections.OrderedDict()
        self._queue_path = os.path.join(config.state_dir, 'queue.json')
        self._played_path = os.path.join(config.state_dir, 'played.json')
        self.played: dict[str, float] = {}
        self.pipeline.progress = self._progress
        self._load()
        self._thread: threading.Thread | None = None
        if autostart:
            self._thread = threading.Thread(target=self._worker_loop, name='singing-worker', daemon=True)
            self._thread.start()

    # ─────────────────────────────── persistence ───────────────────────────────

    def _load(self) -> None:
        """The queue as it was, but only what was asked recently: the last show's queue must not start singing when
        this one begins."""
        stored = read_json(self._queue_path, {})
        stored = stored if isinstance(stored, dict) else {}
        raw_items = stored.get('items') if isinstance(stored.get('items'), list) else []
        keep_sec = self.s.queue.restore_within_min * 60
        now = self._clock()
        dropped: list[str] = []
        highest = 0
        for raw in raw_items:
            it = self._valid_entry(raw)
            if it is None:
                continue
            highest = max(highest, it['qid'])
            if now - it['requested_at'] >= keep_sec:
                dropped.append(it.get('name', ''))
                continue
            if it['state'] in ('downloading', 'processing'):
                it['state'] = 'queued'  # it was being worked on when the service stopped
            if it['state'] in WAITING:
                self.items.append(it)
        declared = stored.get('next_qid')
        self.next_qid = max(declared if isinstance(declared, int) and declared >= 1 else 1, highest + 1)
        played = read_json(self._played_path, {})
        if isinstance(played, dict):
            horizon = now - self.s.queue.repeat_cooldown_min * 60
            self.played = {
                str(k): float(v)
                for k, v in played.items()
                if isinstance(v, (int, float)) and not isinstance(v, bool) and v > horizon
            }
        if dropped:
            self.log.info('dropped requests from before the restart window: %s', ', '.join(dropped))
        if dropped or raw_items:
            self._save()

    @staticmethod
    def _valid_entry(raw: Any) -> dict[str, Any] | None:
        """A stored entry with the fields the service relies on, or None: the file is edited by hand now and then."""
        if not isinstance(raw, dict):
            return None
        try:
            qid = raw['qid']
            song = raw['song']
            if isinstance(qid, bool) or not isinstance(qid, int) or qid < 1 or not isinstance(song, dict):
                return None
            check_song_id(raw['song_id'])
            requested_at = raw['requested_at']
            if isinstance(requested_at, bool) or not isinstance(requested_at, (int, float)):
                return None
            if not isinstance(raw['state'], str) or not isinstance(song.get('name'), str):
                return None
            artists = [str(a) for a in raw.get('artists', []) if isinstance(a, (str, int))]
            return {
                **{k: v for k, v in raw.items() if k != 'removed'},
                'qid': qid,
                'song_id': str(raw['song_id']),
                'name': str(raw.get('name', song['name'])),
                'artists': artists,
                'requester_uid': str(raw.get('requester_uid', '')),
                'requester_name': str(raw.get('requester_name', '')),
                'requested_at': float(requested_at),
            }
        except (KeyError, ValueError, TypeError):
            return None

    def _save(self) -> None:
        with self._lock:
            try:
                write_json_atomic(
                    self._queue_path,
                    {'version': 1, 'next_qid': self.next_qid, 'items': [{k: v for k, v in it.items() if k != 'removed'} for it in self.items]},
                )
            except OSError as error:
                self.log.error('the queue could not be saved: %s', error)

    def _save_played(self) -> None:
        try:
            write_json_atomic(self._played_path, self.played)
        except OSError as error:
            self.log.error('the play log could not be saved: %s', error)

    # ─────────────────────────────── rules ───────────────────────────────

    def _text(self, code: str, **fields: Any) -> str:
        if code not in DEFAULT_MESSAGES and code not in self.s.messages:
            code = 'step_failed'
        return message(self.s.messages, code, **fields)

    def _viewer_text(self, error: SingingError) -> str:
        return self._text(error.code, **{'detail': error.reason, **error.fields})

    def _reject(self, code: str, song: Song | None = None, **fields: Any) -> dict[str, Any]:
        result: dict[str, Any] = {'status': 'rejected', 'code': code, 'reason': self._text(code, **fields)}
        if song is not None:
            result['song'] = _song_view(song)
        return result

    def _blacklisted(self, *texts: str, song_id: str | None = None) -> bool:
        q = self.s.queue
        if song_id is not None and str(song_id) in {str(x) for x in q.blacklist_ids}:
            return True
        words = [w.lower() for w in q.blacklist_keywords if w]
        return any(w in (t or '').lower() for t in texts for w in words)

    def _cooldown_left(self, song_id: str) -> float:
        started = self.played.get(str(song_id))
        if not started:
            return 0.0
        return max(0.0, started + self.s.queue.repeat_cooldown_min * 60 - self._clock())

    def _waiting(self) -> list[dict[str, Any]]:
        return [it for it in self.items if it['state'] in WAITING]

    def _limit_rejection_locked(self, uid: object, texts: list[str], song: Song | None) -> dict[str, Any] | None:
        """The limits every request must pass, both before the search (to spare it) and at the insert."""
        q = self.s.queue
        if self._blacklisted(*texts, song_id=song['id'] if song else None):
            return self._reject('blacklisted', song)
        waiting = self._waiting()
        mine = [it for it in waiting if str(it['requester_uid']) == str(uid)]
        if len(mine) >= q.max_per_user:
            return self._reject('per_user_limit', song, title=mine[0]['name'], max=q.max_per_user)
        if len(waiting) >= q.max_len:
            return self._reject('queue_full', song, max=q.max_len)
        return None

    def _rejection_from_meta(self, meta: dict[str, Any] | None, song: Song) -> dict[str, Any] | None:
        """A song a check refused once stays refused, unless the check would pass today."""
        if not meta or meta.get('status') != 'rejected':
            return None
        code = meta.get('reject_code')
        if code == 'instrumental':
            ratio = ((meta.get('steps') or {}).get('separate') or {}).get('vocal_ratio')
            if isinstance(ratio, (int, float)) and ratio >= self.s.qc.min_vocal_ratio:
                return None  # the operator lowered the bar since
            return self._reject('instrumental', song)
        return self._reject('rejected_before', song, detail=str(meta.get('reject_reason') or ''))

    # ─────────────────────────────── requests ───────────────────────────────

    def request(
        self,
        keyword: str,
        uid: object,
        name: str,
        request_id: str | None = None,
        wait_s: float | None = None,
    ) -> dict[str, Any]:
        """A viewer asks for a song. Returns `{'status': 'queued', ...}` or `{'status': 'rejected', 'code', 'reason'}`;
        raises SourceUnavailable when the source cannot say (nothing was queued then). The same `request_id` gets the
        same answer again, and once the caller's time (`wait_s`) is up, or `abandon` was called, nothing is queued."""
        keyword = (keyword or '').strip()[:MAX_KEYWORD]
        rid = str(request_id) if request_id else uuid.uuid4().hex
        wait = max(0.1, min(float(wait_s) if wait_s else self.s.queue.request_timeout_sec, 120.0))
        deadline = Deadline(wait, self._mono)
        with self._lock:
            known = self._requests.get(rid)
            if known is not None and known.abandoned:
                return self._reject('abandoned')
            if known is not None and known.state == 'done' and known.result is not None:
                return {**known.result, 'duplicate': True}
            joined = known if known is not None and known.state == 'pending' else None
            if joined is None:
                known = _Request(rid)
                self._requests[rid] = known
                self._trim_requests()
        if joined is not None:  # the same request is being worked on by another call: wait for its answer
            joined.event.wait(deadline.remaining())
            with self._lock:
                if joined.state == 'done' and joined.result is not None:
                    return {**joined.result, 'duplicate': True}
            raise SourceUnavailable('the same request is still being worked on', code='source_busy', auto_retry=True)
        assert known is not None
        try:
            result = self._request_new(known, keyword, uid, name, deadline)
        except BaseException:
            with self._lock:
                self._requests.pop(rid, None)  # nothing was decided: asking again with this id starts over
                known.event.set()
            raise
        with self._lock:
            known.result, known.state = result, 'done'
            known.event.set()
        return result

    def _trim_requests(self) -> None:
        while len(self._requests) > KEEP_REQUESTS:
            oldest = next(iter(self._requests))
            if self._requests[oldest].state == 'pending':
                break
            del self._requests[oldest]

    def _request_new(self, rec: _Request, keyword: str, uid: object, name: str, deadline: Deadline) -> dict[str, Any]:
        if not keyword:
            return self._reject('empty_keyword')
        with self._lock:
            self._expire_locked()
            early = self._limit_rejection_locked(uid, [keyword], None)
        if early is not None:
            return early
        songs = self.source.search(keyword, deadline, None)  # the slow part: the lock is not held
        if not songs:
            return self._reject('not_found', keyword=keyword)
        song = best_match(keyword, songs)
        with self._lock:
            return self._insert_locked(rec, song, uid, name, deadline)

    def _insert_locked(self, rec: _Request, song: Song, uid: object, name: str, deadline: Deadline) -> dict[str, Any]:
        """Every check and the insert, under one hold of the lock."""
        if rec.abandoned:
            return self._reject('abandoned', song)
        if deadline.expired():
            return self._reject('request_timeout', song)
        rejected = self._limit_rejection_locked(uid, [song['name'], *song.get('artists', [])], song)
        if rejected is not None:
            return rejected
        song_id = str(song['id'])
        try:
            meta = library.read_meta(self.config.songs_dir, song_id)
        except ValueError:
            return self._reject('not_found', song, keyword=song.get('name', ''))
        precheck = self.source.precheck(song)
        if precheck and not library.is_ready(meta):  # a song prepared before can still be sung
            return self._reject(precheck[0], song)
        if self.current is not None and self.current['song_id'] == song_id:
            return self._reject('playing_now', song, title=song['name'])
        if any(it['song_id'] == song_id for it in self._waiting()):
            return self._reject('already_queued', song, title=song['name'])
        left = self._cooldown_left(song_id)
        if left > 0:
            return self._reject('cooldown', song, title=song['name'], minutes=max(1, math.ceil(left / 60)))
        limit = self.s.qc.max_duration_sec
        if song.get('duration', 0) > limit:
            return self._reject(
                'too_long', song, title=song['name'], duration=fmt_duration(song['duration']), max_duration=fmt_duration(limit)
            )
        rejected = self._rejection_from_meta(meta, song)
        if rejected is not None:
            return rejected
        it = {
            'qid': self.next_qid,
            'request_id': rec.id,
            'song_id': song_id,
            'name': song['name'],
            'artists': list(song.get('artists', [])),
            'duration': float(song.get('duration') or 0),
            'song': song,
            'requester_uid': str(uid),
            'requester_name': name,
            'requested_at': self._clock(),
            'state': 'queued',
            'cached': library.is_current(meta, self.s.rvc),
            'attempts': 0,
        }
        self.next_qid += 1
        self.items.append(it)
        self._save()
        self._wake.notify_all()
        position = len(self._waiting()) + (1 if self.current else 0)
        self.log.info('request #%s "%s" (%s) from %s', it['qid'], it['name'], '/'.join(it['artists']), name)
        return {'status': 'queued', 'qid': it['qid'], 'song': _song_view(song), 'position': position, 'cached': it['cached']}

    def abandon(self, request_id: str) -> dict[str, Any]:
        """The caller of a request gave up. If it is still being worked on it will not be queued; if it was queued
        already and has not started, the entry is removed."""
        with self._lock:
            rec = self._requests.get(str(request_id))
            if rec is None:
                rec = _Request(str(request_id))  # a tombstone: a late arrival of this id is refused
                rec.state, rec.result = 'done', self._reject('abandoned')
                self._requests[rec.id] = rec
            rec.abandoned = True
            removed = False
            if rec.result and rec.result.get('status') == 'queued':
                removed = self._remove_locked(int(rec.result['qid'])) is not None
            return {'ok': True, 'removed': removed}

    # ─────────────────────────────── the queue's own operations ───────────────────────────────

    def _remove_locked(self, qid: int) -> dict[str, Any] | None:
        for it in self.items:
            if it['qid'] == qid:
                it['removed'] = True  # the worker looks at this, and at its job's cancel, before each step
                job = self._jobs.get(qid)
                if job is not None:
                    job.cancel.set('the entry was removed')
                self.items.remove(it)
                self._save()
                return it
        return None

    def remove(self, qid: int) -> dict[str, Any]:
        with self._lock:
            if self.current is not None and self.current['qid'] == qid:
                return {'ok': False, 'code': 'playing_now', 'reason': self._text('playing_now', title=self.current['name'])}
            it = self._remove_locked(qid)
            if it is None:
                return {'ok': False, 'code': 'not_in_queue', 'reason': self._text('not_in_queue')}
            self.log.info('removed #%s "%s"', qid, it['name'])
            return {'ok': True, 'item': _public(it)}

    def cancel(self, uid: object = None, position: int | None = None) -> dict[str, Any]:
        """Takes a song off the queue. With `position` (counted from 1: for the streamer and moderators, whom the
        caller has checked) that entry; otherwise the requester's own latest one, and if they have none waiting but
        their song is being sung, that one (the caller stops the stage: `was_playing`)."""
        with self._lock:
            waiting = self._waiting()
            if position is not None:
                if not 1 <= position <= len(waiting):
                    return {'ok': False, 'code': 'no_such_position', 'reason': self._text('no_such_position', position=position)}
                target = waiting[position - 1]
            else:
                mine = [it for it in waiting if str(it['requester_uid']) == str(uid)]
                if mine:
                    target = mine[-1]
                elif self.current is not None and str(self.current['requester_uid']) == str(uid):
                    current = self._finish_locked(self.current, 'skipped')
                    return {'ok': True, 'item': _public(current), 'was_playing': True}
                else:
                    return {'ok': False, 'code': 'nothing_to_cancel', 'reason': self._text('nothing_to_cancel')}
            removed = self._remove_locked(target['qid'])
            assert removed is not None
            self.log.info('cancelled #%s "%s"', removed['qid'], removed['name'])
            return {'ok': True, 'item': _public(removed), 'was_playing': False}

    def skip(self) -> dict[str, Any]:
        with self._lock:
            if self.current is None:
                return {'ok': False, 'code': 'nothing_playing', 'reason': self._text('nothing_playing')}
            return {'ok': True, 'item': _public(self._finish_locked(self.current, 'skipped'))}

    def resume_source(self) -> dict[str, Any]:
        self.source.resume()
        return {'ok': True}

    # ─────────────────────────────── playing ───────────────────────────────

    def claim(self, claim_id: str) -> dict[str, Any]:
        """Takes the first ready song to be sung. The same `claim_id` again returns the same song (a retry after a
        lost answer); a different one first ends whatever an earlier claimant left unfinished."""
        with self._lock:
            self._expire_locked()
            current = self.current
            if current is not None and current.get('claim_id') == claim_id:
                return self._claim_payload(current)
            if current is not None:
                self._finish_locked(current, 'interrupted')
            while True:
                ready = next((it for it in self.items if it['state'] == 'ready'), None)
                if ready is None:
                    return {'item': None, 'pending': len(self._waiting())}
                directory = library.song_dir(self.config.songs_dir, ready['song_id'])
                if library.final_files_present(directory):
                    break
                # the files were deleted behind the service's back: prepare the song again instead of sending nothing
                self.log.warning('#%s "%s" has no final files any more; preparing it again', ready['qid'], ready['name'])
                library.invalidate(self.config.songs_dir, ready['song_id'])
                ready.update(state='queued', cached=False)
                self._save()
                self._wake.notify_all()
            self.items.remove(ready)
            now = self._clock()
            ready.update(state='playing', started_at=now, claim_id=claim_id)
            self.current = ready
            self.played[ready['song_id']] = now
            self._save_played()
            self._save()
            return self._claim_payload(ready)

    def _claim_payload(self, it: dict[str, Any]) -> dict[str, Any]:
        directory = library.song_dir(self.config.songs_dir, it['song_id'])
        meta = library.read_meta(self.config.songs_dir, it['song_id']) or {}
        return {
            'item': _public(it),
            'files': {'dir': it['song_id'], 'vocals': library.VOCALS_FINAL, 'inst': library.INST_FINAL},
            'lyrics': parse_lrc(library.read_lyric_text(directory)),
            'duration': float(meta.get('duration') or it.get('duration') or 0),
            'transpose': meta.get('transpose'),
            'warnings': list(meta.get('warnings') or []),
        }

    def done(self, qid: int | None, outcome: str, reason: str = '') -> dict[str, Any]:
        """The caller reports how the song it claimed ended: sung to the end (`done`), cut by a viewer (`skipped`) or
        the operator (`stopped`), lost with the stage (`interrupted`), never played (`failed`), or never started through
        nobody's fault (`released`: it goes back to the front of the queue)."""
        if outcome not in OUTCOMES:
            raise ValueError(f'outcome must be one of {", ".join(OUTCOMES)}')
        with self._lock:
            current = self.current
            if current is None or (qid is not None and current['qid'] != qid):
                return {'ok': False, 'code': 'nothing_playing', 'reason': self._text('nothing_playing')}
            finished = self._finish_locked(current, outcome, reason)
            return {'ok': True, 'item': _public(finished)}

    def _finish_locked(self, it: dict[str, Any], outcome: str, reason: str = '') -> dict[str, Any]:
        self.current = None
        it['ended_at'] = self._clock()
        self.log.info('#%s "%s": %s%s', it['qid'], it['name'], outcome, f' ({reason})' if reason else '')
        if outcome in ('failed', 'released'):
            # it never sounded, so it does not count as sung
            self.played.pop(it['song_id'], None)
            self._save_played()
        if outcome == 'failed':
            # the failure stays in the queue view for a while
            it.update(
                state='failed', code='playback_failed', retryable=True, failed_at=self._clock(),
                reason=self._text('step_failed'), error=(reason or 'the song could not be played')[:500],
            )
            self.items.append(it)
            self._save()
        elif outcome == 'released':
            # nobody is to blame (the operator stopped while it was loading): back to the front, ready to be claimed
            for key in ('claim_id', 'started_at', 'ended_at'):
                it.pop(key, None)
            it['state'] = 'ready'
            self.items.insert(0, it)
            self._save()
            self._wake.notify_all()
        return it

    def _expire_locked(self) -> None:
        """Forgets failed entries that were shown long enough, and ends a song nobody has reported on for far longer
        than it lasts (its caller died)."""
        now = self._clock()
        keep = self.s.queue.failed_keep_sec
        kept = [it for it in self.items if not (it['state'] == 'failed' and now - it.get('failed_at', now) > keep)]
        if len(kept) != len(self.items):
            self.items = kept
        current = self.current
        if current is not None:
            allowed = max(float(current.get('duration') or 0), 60.0) + CURRENT_GRACE_SEC
            if now - current.get('started_at', now) > allowed:
                self._finish_locked(current, 'interrupted', 'nobody reported the end of the song')

    # ─────────────────────────────── views ───────────────────────────────

    def queue(self) -> dict[str, Any]:
        source = self.source.status()  # may read a file: not under the lock
        with self._lock:
            self._expire_locked()
            return {
                'current': _public(self.current) if self.current else None,
                'items': [_public(it) for it in self._waiting()],
                'failed': [_public(it) for it in self.items if it['state'] == 'failed'],
                'worker': dict(self.worker_state),
                'source': source,
                'songs_dir': self.config.songs_dir,
                'limits': {'max_per_user': self.s.queue.max_per_user, 'max_len': self.s.queue.max_len},
            }

    def health(self) -> dict[str, Any]:
        problems = self.config.problems()
        with self._lock:
            waiting = self._waiting()
            config = {
                **self.config.summary(),
                'queue': len(waiting),
                'ready': sum(1 for it in waiting if it['state'] == 'ready'),
                'worker': self.worker_state.get('state', 'idle'),
            }
        return {
            'ok': not problems,
            'ready': True,
            'service': 'singing',
            'version': __version__,
            'config': config,
            **({'detail': '; '.join(problems)[:190]} if problems else {}),
        }

    # ─────────────────────────────── the worker ───────────────────────────────

    def _progress(self, step: str) -> None:
        with self._lock:
            if self.worker_state.get('state') == 'working':
                self.worker_state['step'] = step

    def _pick_locked(self) -> dict[str, Any] | None:
        now = self._clock()
        return next(
            (it for it in self.items if it['state'] == 'queued' and it.get('not_before', 0) <= now),
            None,
        )

    def _idle_wait_locked(self) -> float:
        """How long the worker may sleep: until the next retry is due, at most a few seconds."""
        now = self._clock()
        due = [it.get('not_before', 0) - now for it in self.items if it['state'] == 'queued']
        return max(0.05, min([5.0, *due]))

    def _worker_loop(self) -> None:
        while not self._closing.is_set():
            try:
                worked = self.process_next()
            except Exception:  # noqa: BLE001 - a bug must not end the worker
                self.log.exception('the worker met an unexpected error')
                worked = False
            if not worked:
                with self._wake:
                    if not self._closing.is_set():
                        self._wake.wait(timeout=self._idle_wait_locked())

    def process_next(self) -> bool:
        """Prepares the first entry that is due. True when there was one (whatever came of it)."""
        with self._lock:
            it = self._pick_locked()
            if it is None:
                self.worker_state = {'state': 'idle'}
                return False
            it['state'] = 'downloading'
            job = _Job(it['qid'])
            self._jobs[it['qid']] = job
            self.worker_state = {'state': 'working', 'qid': it['qid'], 'title': it['name'], 'step': 'download'}
            self._save()
        try:
            self._prepare(it, job)
        except Abandoned:
            self.log.info('#%s "%s": work stopped, the entry is gone', it['qid'], it['name'])
        except SourceUnavailable as error:
            self._source_failed(it, error)
        except SingingError as error:
            self._fail(it, error)
        except Exception as error:  # noqa: BLE001
            self.log.exception('#%s "%s": unexpected error', it['qid'], it['name'])
            self._fail(it, StepFailed('unexpected', 'an unexpected error', f'{type(error).__name__}: {error}'))
        finally:
            with self._lock:
                self._jobs.pop(it['qid'], None)
                self.worker_state = {'state': 'idle'}
        return True

    def _prepare(self, it: dict[str, Any], job: _Job) -> None:
        songs = self.config.songs_dir
        meta = library.read_meta(songs, it['song_id'])
        if not library.is_current(meta, self.s.rvc):
            requester = {'uid': it['requester_uid'], 'name': it['requester_name']}
            self.pipeline.fetch(it['song'], requester, job.cancel)
            self._set(it, state='processing')
            self._progress('process')
            meta = self.pipeline.process(it['song_id'], job.cancel)
        job.cancel.check()
        with self._lock:
            if it.get('removed'):
                raise Abandoned('the entry was removed')
            it.update(state='ready', warnings=list((meta or {}).get('warnings') or []), transpose=(meta or {}).get('transpose'))
            self._save()
            self._wake.notify_all()
        self.log.info('#%s "%s" is ready', it['qid'], it['name'])

    def _set(self, it: dict[str, Any], **changes: Any) -> None:
        with self._lock:
            if it.get('removed'):
                raise Abandoned('the entry was removed')
            it.update(changes)
            self._save()

    def _fail(self, it: dict[str, Any], error: SingingError) -> None:
        detail = error.reason + (f': {error.detail}' if isinstance(error, StepFailed) and error.detail else '')
        with self._lock:
            if it.get('removed'):
                return
            it.update(
                state='failed', code=error.code, retryable=error.retryable, reason=self._viewer_text(error),
                error=detail[:500], failed_at=self._clock(),
            )
            self._save()
        self.log.warning('#%s "%s" failed (%s): %s', it['qid'], it['name'], error.code, error.reason)

    def _source_failed(self, it: dict[str, Any], error: SourceUnavailable) -> None:
        """A blip is tried again after a pause; a tripped breaker or a spent cap is not tried again by the worker."""
        retry = self.s.retry
        attempts = it.get('attempts', 0) + 1
        if error.auto_retry and attempts < retry.max_attempts:
            delay = retry.backoff_sec[min(attempts - 1, len(retry.backoff_sec) - 1)] if retry.backoff_sec else 0.0
            with self._lock:
                if it.get('removed'):
                    return
                it.update(state='queued', attempts=attempts, not_before=self._clock() + delay, error=error.reason[:500])
                self._save()
            self.log.warning('#%s "%s": %s; trying again in %g s', it['qid'], it['name'], error.reason, delay)
            return
        self._fail(it, error)

    # ─────────────────────────────── shutdown ───────────────────────────────

    def close(self) -> None:
        """Stops the worker and whatever tool it is running (the GPU must not stay busy behind a stopped service)."""
        self._closing.set()
        with self._lock:
            for job in self._jobs.values():
                job.cancel.set('the service is closing')
            self._wake.notify_all()
        if self._thread is not None:
            self._thread.join(15)
        self._save()
