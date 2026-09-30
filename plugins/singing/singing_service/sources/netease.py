"""The NetEase source: search, audio URL, lyrics and the download, through an API server the operator runs.

The API server is a third-party project (an "api-enhanced" build of the NetEase cloud music API); only its HTTP
behaviour matters here. The rules the legacy service had are kept, because the account is what is at risk:

  * every request, the download included, goes through one queue, this far apart, across processes;
  * a risk-control answer (-460, 301, ...) trips a breaker that stops every request until a person lifts it;
  * a session may download only so many new songs;
  * no proxy is ever used, whatever the environment says (NetEase must be reached directly).

What changed is how a failure is told apart: only "this song cannot be downloaded" is a rejection (SongRejected).
A breaker, the cap, a network blip or a truncated file is SourceUnavailable, which never marks the song.
The optional cookie (a logged-in web session, for a membership account) comes from the environment the
orchestrator gives the process; it is sent only in the request header and never logged.
"""

from __future__ import annotations

import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from ..control import Cancel, Deadline
from ..errors import SongRejected, SourceUnavailable
from ..locks import FileLock
from ..util import read_json, write_json_atomic
from .base import SongSource
from .matching import Song

# Risk-control or expired-login answers. 301 means "log in", which a dead cookie produces.
HALT_CODES = {-460, -461, -462, 301, 405}
HALT_WORDS = ('风控', '安全验证', '网络太拥挤', '操作频繁', 'cheating', 'risk')
MAX_BODY = 4 << 20
DOWNLOAD_CHUNK = 1 << 16


def brief(raw: dict[str, Any]) -> Song:
    return {
        'id': str(raw.get('id')),
        'name': raw.get('name') or '',
        'artists': [a.get('name') or '' for a in (raw.get('ar') or [])],
        'album': (raw.get('al') or {}).get('name') or '',
        'duration': (raw.get('dt') or 0) / 1000.0,
        'fee': raw.get('fee'),
    }


class NetEaseSource(SongSource):
    kind = 'netease'

    def __init__(
        self,
        base_url: str,
        cookie: str,
        state_dir: str,
        *,
        min_interval: float = 3.0,
        timeout: float = 20.0,
        level: str = 'exhigh',
        search_limit: int = 10,
        max_new_downloads: int = 30,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.base = base_url.rstrip('/')
        self._cookie = cookie.strip()
        self.min_interval = float(min_interval)
        self.timeout = float(timeout)
        self.level = level
        self.search_limit = search_limit
        self.max_new_downloads = max_new_downloads
        self.new_downloads = 0
        self.request_count = 0
        self._clock = clock
        self._lock = FileLock(os.path.join(state_dir, 'locks', 'ncm.lock'))
        self._last_path = os.path.join(state_dir, 'ncm_last')
        self.halt_path = os.path.join(state_dir, 'ncm_halted.json')
        # An empty proxy table: neither the environment nor the system's proxy settings are read.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    # ─────────────────────────────── state ───────────────────────────────

    def halted(self) -> dict[str, Any] | None:
        info = read_json(self.halt_path, None)
        return info if isinstance(info, dict) else None

    def resume(self) -> None:
        try:
            os.remove(self.halt_path)
        except FileNotFoundError:
            pass

    def status(self) -> dict[str, Any]:
        return {
            'kind': 'netease',
            'halted': self.halted(),
            'requests': self.request_count,
            'new_downloads': self.new_downloads,
            'max_new_downloads': self.max_new_downloads,
            'cookie_set': bool(self._cookie),
        }

    def _halt(self, reason: str) -> SourceUnavailable:
        """Trips the breaker (once) and returns the error to raise."""
        if not self.halted():
            write_json_atomic(self.halt_path, {'reason': reason, 'time': time.strftime('%Y-%m-%d %H:%M:%S')})
        return self._halted_error()

    @staticmethod
    def _halted_error() -> SourceUnavailable:
        return SourceUnavailable('the NetEase circuit breaker is tripped', code='source_halted')

    # ─────────────────────────────── requests ───────────────────────────────

    def _wait_turn(self, deadline: Deadline, cancel: Cancel | None) -> None:
        """Called with the lock held: refuses while the breaker is tripped, then waits out the gap since the last
        request of any process."""
        if self.halted():
            raise self._halted_error()
        try:
            with open(self._last_path, encoding='utf-8') as handle:
                last = float(handle.read().strip() or 0)
        except (OSError, ValueError):
            last = 0.0
        wait = last + self.min_interval - self._clock()
        if wait <= 0:
            return
        wait = min(wait, self.min_interval)  # a clock that jumped backwards must not park the queue for hours
        if wait > deadline.remaining():
            raise SourceUnavailable('the request would have to wait longer than it may', code='source_busy', auto_retry=True)
        if cancel is not None:
            cancel.wait(wait)
            cancel.check()
        else:
            time.sleep(wait)

    def _mark(self) -> None:
        try:
            with open(self._last_path, 'w', encoding='utf-8') as handle:
                handle.write(str(self._clock()))
        except OSError:
            pass

    def _busy(self) -> SourceUnavailable:
        return SourceUnavailable('another request kept the NetEase queue too long', code='source_busy', auto_retry=True)

    def _headers(self) -> dict[str, str]:
        return {'Cookie': self._cookie} if self._cookie else {}

    def _get(self, url: str, timeout: float) -> tuple[int, bytes]:
        request = urllib.request.Request(url, headers=self._headers())
        try:
            with self._opener.open(request, timeout=max(0.1, timeout)) as response:
                return response.status, response.read(MAX_BODY)
        except urllib.error.HTTPError as error:
            try:
                body = error.read(MAX_BODY)
            except OSError:
                body = b''
            finally:
                error.close()
            return error.code, body
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as error:
            raise SourceUnavailable(
                f'cannot reach the NetEase API server at {self.base} ({type(error).__name__})',
                code='source_down',
                auto_retry=True,
            ) from None

    def _api(self, path: str, params: dict[str, Any], deadline: Deadline, cancel: Cancel | None) -> dict[str, Any]:
        url = f'{self.base}{path}?{urllib.parse.urlencode(params)}'
        with self._lock.hold(deadline.remaining(), cancel, self._busy):
            self._wait_turn(deadline, cancel)
            try:
                self.request_count += 1
                status, data = self._get(url, deadline.cap(self.timeout))
            finally:
                self._mark()
        try:
            body = json.loads(data.decode('utf-8', 'replace'))
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise SourceUnavailable(
                f'the API server did not answer with JSON (HTTP {status})', code='source_error', auto_retry=status >= 500 or status == 200
            )
        code = body.get('code', status)
        message = str(body.get('message') or body.get('msg') or '')
        if code in HALT_CODES or any(word in message for word in HALT_WORDS):
            raise self._halt(f'{path} answered code={code} {message}'.strip())
        if code != 200:
            raise SourceUnavailable(f'the API server answered code={code} {message}'.strip(), code='source_error', auto_retry=status >= 500)
        return body

    # ─────────────────────────────── the interface ───────────────────────────────

    def search(self, keyword: str, deadline: Deadline, cancel: Cancel | None = None) -> list[Song]:
        body = self._api('/cloudsearch', {'keywords': keyword, 'type': 1, 'limit': self.search_limit}, deadline, cancel)
        songs = (body.get('result') or {}).get('songs') or []
        return [brief(s) for s in songs if isinstance(s, dict)]

    def details(self, song_ids: list[str], deadline: Deadline) -> list[Song]:
        found: list[Song] = []
        for song_id in song_ids:
            body = self._api('/song/detail', {'ids': str(song_id)}, deadline, None)
            songs = body.get('songs') or []
            if not songs:
                raise SongRejected(f'no song {song_id} on NetEase', code='not_found')
            found.append(brief(songs[0]))
        return found

    def playlist(self, playlist_id: str, deadline: Deadline) -> list[Song]:
        body = self._api('/playlist/track/all', {'id': str(playlist_id), 'limit': 1000, 'offset': 0}, deadline, None)
        return [brief(s) for s in body.get('songs') or [] if isinstance(s, dict)]

    def precheck(self, song: Song) -> tuple[str, str] | None:
        """Without a membership cookie the search result already says which songs are paid: fee 1 is a VIP song and
        fee 4 belongs to a paid album (0 and 8 are free). With a cookie the audio request decides."""
        if self._cookie:
            return None
        if song.get('fee') == 1:
            return 'vip_only', 'fee=1 and no membership cookie is set'
        if song.get('fee') == 4:
            return 'paid_album', 'fee=4 and no membership cookie is set'
        return None

    def audio_url(self, song_id: str, deadline: Deadline, cancel: Cancel | None) -> tuple[str, str]:
        body = self._api('/song/url/v1', {'id': str(song_id), 'level': self.level}, deadline, cancel)
        data = (body.get('data') or [{}])[0] or {}
        if data.get('freeTrialInfo'):
            raise SongRejected('only a 30 second trial is available', code='vip_only')
        url = data.get('url')
        if not url:
            if data.get('fee') == 4:
                raise SongRejected('the song is in a paid album', code='paid_album')
            raise SongRejected('the API returned no audio URL', code='no_audio')
        ext = str(data.get('type') or url.rsplit('.', 1)[-1].split('?')[0] or 'mp3').lower()
        return url, ext if ext.isalnum() and len(ext) <= 5 else 'mp3'

    def lyric(self, song_id: str, deadline: Deadline, cancel: Cancel | None) -> str:
        body = self._api('/lyric', {'id': str(song_id)}, deadline, cancel)
        return str(((body.get('lrc') or {}).get('lyric')) or '').strip()

    def download(self, url: str, dest: str, cancel: Cancel, timeout: float) -> None:
        """Fetches the file from the CDN, under the same queue and limits as any other request."""
        if self.new_downloads >= self.max_new_downloads:
            raise SourceUnavailable(
                f'{self.max_new_downloads} new songs were downloaded this session', code='download_cap', max=self.max_new_downloads
            )
        deadline = Deadline(timeout)
        part = dest + '.part'
        try:
            with self._lock.hold(deadline.remaining(), cancel, self._busy):
                self._wait_turn(deadline, cancel)
                try:
                    self.request_count += 1
                    self._stream(url, part, cancel, deadline)
                finally:
                    self._mark()
            os.replace(part, dest)
            self.new_downloads += 1
        finally:
            if os.path.exists(part):
                try:
                    os.remove(part)
                except OSError:
                    pass

    def _stream(self, url: str, part: str, cancel: Cancel, deadline: Deadline) -> None:
        try:
            with self._opener.open(urllib.request.Request(url), timeout=max(0.1, deadline.cap(self.timeout))) as response:
                if response.status != 200:
                    raise SourceUnavailable(f'the CDN answered HTTP {response.status}', code='source_error')
                expected = response.headers.get('Content-Length')
                written = 0
                with open(part, 'wb') as out:
                    while True:
                        cancel.check()
                        if deadline.expired():
                            raise SourceUnavailable('the download took too long', code='source_down', auto_retry=True)
                        chunk = response.read(DOWNLOAD_CHUNK)
                        if not chunk:
                            break
                        out.write(chunk)
                        written += len(chunk)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in (404, 410):
                raise SongRejected(f'the CDN no longer has the file (HTTP {error.code})', code='no_audio') from None
            raise SourceUnavailable(f'the CDN answered HTTP {error.code}', code='source_error', auto_retry=error.code >= 500) from None
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as error:
            raise SourceUnavailable(f'the download failed ({type(error).__name__})', code='source_down', auto_retry=True) from None
        if written == 0 or (expected is not None and expected.isdigit() and int(expected) != written):
            raise SourceUnavailable('the download ended early', code='source_down', auto_retry=True)

    def fetch(self, song: Song, dest_dir: str, cancel: Cancel, timeout: float) -> None:
        deadline = Deadline(timeout)
        os.makedirs(dest_dir, exist_ok=True)
        url, ext = self.audio_url(song['id'], deadline, cancel)
        self.download(url, os.path.join(dest_dir, f'orig.{ext}'), cancel, timeout)
        text = ''
        try:
            text = self.lyric(song['id'], Deadline(min(timeout, self.timeout * 2)), cancel)
        except SourceUnavailable:
            text = ''  # lyrics are a nicety: the song is sung without them
        with open(os.path.join(dest_dir, 'lyric.lrc'), 'w', encoding='utf-8') as handle:
            handle.write(text)
