"""One song through the pipeline: fetch, separate, find the pitch, convert the voice, mix.

Each step that needs a model runs as a subprocess (runner.py) with a timeout, and the job is checked for
cancellation before every step, so a removed song stops being worked on at the next step and a running one is killed.
The GPU lock is held across the steps of one song, with a bounded wait. Steps whose output is already there (and was
made with the settings in force) are skipped, so a song comes back to `ready` cheaply after a change of voice
settings: only the conversion and the mix run again.

A failure of the source is never turned into a rejection of the song: `SongRejected` is raised only for what is true of
the song (too long, no vocals, no rights to it) and the source itself decides the last.
"""

from __future__ import annotations

import bisect
import logging
import math
import os
import shutil
import sys
import time
from collections.abc import Callable
from typing import Any

from . import library
from .control import Cancel
from .errors import GpuBusy, NotConfigured, SingingError, SongRejected, StepFailed
from .locks import FileLock
from .runner import Runner, last_json
from .settings import Config
from .sources.base import SongSource
from .sources.matching import Song
from .util import fmt_duration, read_json

STEPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'steps')
STEP_SEPARATE = os.path.join(STEPS_DIR, 'step_separate.py')
STEP_F0 = os.path.join(STEPS_DIR, 'step_f0.py')
STEP_MIX = os.path.join(STEPS_DIR, 'step_mix.py')


def pick_transpose(config: Config, song_id: str, source_median_hz: float | None) -> tuple[int, float | None, str]:
    """How many semitones to move the song so the voice can sing it: (semitones, the unrounded value, why).

    The song's median pitch is compared with the voice's; the difference is limited to `max_abs` and rounded to
    the nearest of `allowed` (whole octaves, or a few semitones, so a song does not land in an odd key).
    A song listed under `overrides` uses that value."""
    t = config.settings.transpose
    if str(song_id) in t.overrides:
        return int(t.overrides[str(song_id)]), None, 'override'
    voice = config.settings.voice.f0_median_hz
    if not voice or not source_median_hz:
        return 0, None, 'no-f0'
    raw = 12 * math.log2(voice / source_median_hz)
    raw = max(-t.max_abs, min(t.max_abs, raw))
    best = min(t.allowed, key=lambda a: (abs(a - raw), abs(a))) if t.allowed else 0
    return int(best), round(raw, 2), 'auto'


def out_of_range_ratio(quantiles: list[float] | None, shift: int, low_hz: float, high_hz: float) -> float:
    """The share of a song's voiced frames that land outside [low, high] after moving `shift` semitones, worked out
    from the 0th..100th percentiles of its pitch (linear between them: the error is under one percent)."""
    if not quantiles or len(quantiles) < 2 or not (high_hz > low_hz > 0):
        return 0.0
    scale = 2 ** (shift / 12)

    def below(hz: float) -> float:
        """The share of frames with a pitch under `hz`."""
        if hz <= quantiles[0]:
            return 0.0
        if hz >= quantiles[-1]:
            return 1.0
        i = bisect.bisect_right(quantiles, hz) - 1
        span = quantiles[i + 1] - quantiles[i]
        inside = (hz - quantiles[i]) / span if span > 0 else 0.0
        return (i + inside) / (len(quantiles) - 1)

    return max(0.0, min(1.0, below(low_hz / scale) + 1.0 - below(high_hz / scale)))


class Pipeline:
    def __init__(
        self,
        config: Config,
        source: SongSource,
        runner: Runner,
        gpu_lock: FileLock,
        *,
        python: str | None = None,
        log: logging.Logger | None = None,
    ) -> None:
        self.cfg = config
        self.source = source
        self.runner = runner
        self.gpu_lock = gpu_lock
        #: The interpreter of the separation and the mix (the one this service runs in, unless told otherwise).
        self.python = python or sys.executable
        self.log = log or logging.getLogger('singing.pipeline')
        #: Told the name of each step as it begins (the service shows it as what the worker is doing).
        self.progress: Callable[[str], None] = lambda step: None

    # ─────────────────────────────── helpers ───────────────────────────────

    def _begin(self, meta: dict[str, Any], step: str) -> None:
        library.set_step(self._songs(), meta, step, 'running')
        self.progress(step)

    def preflight(self) -> None:
        """Refuses to start a song the settings cannot carry to the end (before it costs a download)."""
        problems = self.cfg.problems(pipeline=True)
        if problems:
            raise NotConfigured('; '.join(problems)[:300], detail=problems[0])

    def _env(self) -> dict[str, str]:
        env = dict(os.environ)
        env['PYTHONIOENCODING'] = 'utf-8'
        env.pop('NCM_COOKIE', None)  # no tool of the pipeline needs the account
        ffmpeg_dir = os.path.dirname(self.cfg.ffmpeg)
        env['PATH'] = os.pathsep.join(p for p in (os.path.dirname(self.python), ffmpeg_dir, env.get('PATH', '')) if p)
        return env

    def _run(self, cmd: list[str], what: str, timeout: float, cancel: Cancel, cwd: str | None = None) -> dict[str, Any]:
        """Runs one tool; its result is the last JSON line it printed, and how long it took."""
        result = self.runner.run(cmd, cwd=cwd, env=self._env(), timeout=timeout, cancel=cancel, what=what)
        return {**last_json(result.stdout), '_sec': result.seconds}

    def _songs(self) -> str:
        return self.cfg.songs_dir

    # ─────────────────────────────── fetch ───────────────────────────────

    def fetch(self, song: Song, requester: dict[str, Any] | None, cancel: Cancel) -> dict[str, Any]:
        """Makes sure the song's original and lyrics are in the library. Returns its meta."""
        self.preflight()  # a setup that cannot finish the song should not start it by downloading
        s = self.cfg.settings
        songs = self._songs()
        meta = library.read_meta(songs, song['id']) or library.new_meta(song)
        if requester:
            meta['requests'] = (meta.get('requests', []) + [{**requester, 'time': time.strftime('%Y-%m-%d %H:%M:%S')}])[-20:]
        self._check_duration(song.get('duration') or 0, song.get('name', ''))
        directory = library.song_dir(songs, song['id'])
        cancel.check()
        if not library.orig_file(directory):
            found = self.source.precheck(song)
            if found:
                # what a song needs depends on the account, so this is not written down as a property of the song
                raise SongRejected(found[1], code=found[0])
            os.makedirs(directory, exist_ok=True)
            self._begin(meta, 'download')
            try:
                self.source.fetch(song, directory, cancel, s.timeouts.download_sec)
            except SingingError as error:
                library.set_step(songs, meta, 'download', 'failed', code=error.code, reason=error.reason)
                raise
            except BaseException:
                library.set_step(songs, meta, 'download', 'cancelled')
                raise
            if not library.orig_file(directory):
                raise StepFailed('download', 'the source finished but left no file')
        lyric = os.path.join(directory, library.LYRIC_FILE)
        if not os.path.isfile(lyric):
            with open(lyric, 'w', encoding='utf-8') as handle:
                handle.write('')
        library.set_step(songs, meta, 'download', 'done', file=os.path.basename(library.orig_file(directory) or ''))
        if meta.get('status') in ('new', 'rejected'):
            meta['status'] = 'downloaded'
            for key in ('reject_reason', 'reject_code'):
                meta.pop(key, None)
        library.write_meta(songs, meta)
        return meta

    def _check_duration(self, seconds: float, title: str) -> None:
        limit = self.cfg.settings.qc.max_duration_sec
        if seconds and seconds > limit:
            # not written to the song's meta: it is settled by the limit, which the operator may change
            raise SongRejected(
                f'{seconds:.0f} s is longer than the limit of {limit:.0f} s',
                code='too_long',
                title=title,
                duration=fmt_duration(seconds),
                max_duration=fmt_duration(limit),
            )

    # ─────────────────────────────── process ───────────────────────────────

    def process(self, song_id: str, cancel: Cancel, force: bool = False) -> dict[str, Any]:
        """Runs the steps that are left for a downloaded song. Returns its meta; raises SongRejected for a song that
        fails the checks, GpuBusy when the GPU stayed taken, StepFailed / StepTimeout for a tool, Abandoned when the
        job was cancelled."""
        songs = self._songs()
        self.preflight()
        directory = library.song_dir(songs, song_id)
        meta = library.read_meta(songs, song_id)
        if not meta or not library.orig_file(directory):
            raise StepFailed('process', 'the original file is missing', '')
        wait = self.cfg.settings.timeouts.gpu_lock_wait_sec
        with self.gpu_lock.hold(
            wait, cancel, lambda: GpuBusy(f'the GPU lock stayed taken for {wait:g} s', code='gpu_busy')
        ):
            return self._process_locked(meta, directory, cancel, force)

    def _process_locked(self, meta: dict[str, Any], d: str, cancel: Cancel, force: bool) -> dict[str, Any]:
        cfg, s = self.cfg, self.cfg.settings
        songs = self._songs()
        song_id = str(meta['id'])
        applio = s.paths.applio
        meta['status'] = 'processing'
        meta.pop('warnings', None)
        library.write_meta(songs, meta)

        def have(*names: str) -> bool:
            return not force and all(os.path.isfile(os.path.join(d, n)) for n in names)

        # 1. separation: the lead vocal, and the band with the backing vocals in it
        cancel.check()
        sep = meta.setdefault('steps', {}).get('separate') or {}
        if not have('vocals.wav', 'inst.wav') or sep.get('status') not in ('done', 'rejected'):
            self._begin(meta, 'separate')
            cmd = [
                self.python, STEP_SEPARATE, d,
                '--models-dir', cfg.models_dir,
                '--ffmpeg', cfg.ffmpeg,
                '--vocal-model', s.separation.vocal_model,
                '--dereverb-model', s.separation.dereverb_model,
            ]
            if s.separation.split_backing:
                cmd += ['--karaoke-model', s.separation.karaoke_model]
            else:
                cmd.append('--no-split-backing')
            out = self._run(cmd, 'the vocal separation', s.timeouts.separate_sec, cancel)
            library.set_step(songs, meta, 'separate', 'done', **out)
            sep = meta['steps']['separate']
            if not s.keep_intermediate:
                # vocals.wav and inst.wav are what the later steps use; the rest is about 250 MB a song
                shutil.rmtree(os.path.join(d, 'sep'), ignore_errors=True)
        self._check_duration(sep.get('duration') or meta.get('duration') or 0, meta.get('name', ''))
        if sep.get('vocal_ratio', 1) < s.qc.min_vocal_ratio:
            meta['status'] = 'rejected'
            meta['reject_code'] = 'instrumental'
            meta['reject_reason'] = f'vocal energy is {sep.get("vocal_ratio")} of the whole (under {s.qc.min_vocal_ratio})'
            # what the separation measured stays: a later, lower threshold is judged by it without separating again
            measured = {k: v for k, v in sep.items() if k not in ('status', 'time')}
            library.set_step(songs, meta, 'separate', 'rejected', **{**measured, 'reason': meta['reject_reason']})
            raise SongRejected(meta['reject_reason'], code='instrumental')

        # 2. the song's pitch, and from it how far to move it
        cancel.check()
        stats_file = os.path.join(d, 'f0_src.json')
        if not have('f0_src.json'):
            self._begin(meta, 'analyze')
            self._run(
                [cfg.applio_python, STEP_F0, '--applio', applio, '--out', stats_file, os.path.join(d, 'vocals.wav')],
                'the pitch analysis', s.timeouts.analyze_sec, cancel,
            )
        stats = read_json(stats_file, None)
        if not isinstance(stats, dict):
            raise StepFailed('analyze', 'the pitch analysis left no readable f0_src.json')
        shift, raw, how = pick_transpose(cfg, song_id, stats.get('median_hz'))
        inst_shift = shift - 12 * round(shift / 12) if s.transpose.shift_instrumental else 0
        low, high = s.voice.comfort_low_hz, s.voice.comfort_high_hz
        out_ratio = out_of_range_ratio(stats.get('quantiles_hz'), shift, low, high)
        library.set_step(
            songs, meta, 'analyze', 'done',
            src_median_hz=stats.get('median_hz'), transpose=shift, transpose_raw=raw, transpose_source=how,
            inst_shift=inst_shift, out_of_range_ratio=round(out_ratio, 3),
        )
        meta['transpose'] = shift
        if out_ratio > s.qc.out_of_range_warn_ratio:
            meta.setdefault('warnings', []).append(
                f'{out_ratio:.0%} of the notes fall outside the voice\'s comfortable range ({low:.0f}-{high:.0f} Hz) '
                'after the transposition; it may sound strained'
            )

        # 3. the voice conversion (Applio's command line)
        cancel.check()
        previous = meta['steps'].get('convert', {})
        signature = library.rvc_signature(s.rvc)
        if not have('vocals_rvc.wav') or previous.get('transpose') != shift or previous.get('rvc') != signature:
            self._begin(meta, 'convert')
            cmd = [
                cfg.applio_python, 'core.py', 'infer',
                '--input-path', os.path.join(d, 'vocals.wav'),
                '--output-path', os.path.join(d, 'vocals_rvc.wav'),
                '--pth-path', s.rvc.model_pth,
                '--pitch', str(shift),
                '--f0-method', s.rvc.f0_method,
                '--index-rate', str(s.rvc.index_rate),
                '--protect', str(s.rvc.protect),
                '--volume-envelope', str(s.rvc.volume_envelope),
                '--embedder-model', s.rvc.embedder,
                '--export-format', 'WAV',
            ]
            if s.rvc.index:
                cmd += ['--index-path', s.rvc.index]
            out = self._run(cmd, 'the voice conversion', s.timeouts.convert_sec, cancel, cwd=applio)
            if not os.path.isfile(os.path.join(d, 'vocals_rvc.wav')):
                raise StepFailed('convert', 'the voice conversion left no vocals_rvc.wav')
            library.set_step(songs, meta, 'convert', 'done', transpose=shift, model=signature['model'], rvc=signature, _sec=out.get('_sec'))

        # 4. the mix (always: it is quick, and it is what the stage plays)
        cancel.check()
        self._begin(meta, 'mix')
        m = s.mix
        cmd = [
            self.python, STEP_MIX, d,
            '--shift', str(inst_shift),
            '--target-lufs', str(m.target_lufs),
            '--vocal-offset-db', str(m.vocal_offset_db),
            '--inst-offset-db', str(m.inst_offset_db),
            '--peak-limit-dbfs', str(m.peak_limit_dbfs),
            '--ffmpeg', cfg.ffmpeg,
            '--mp3-bitrate', m.mp3_bitrate,
        ]
        if m.reverb.enabled:
            cmd += ['--reverb', str(m.reverb.room_size), str(m.reverb.wet_level), str(m.reverb.dry_level)]
        if not m.preview_mp3:
            cmd.append('--no-preview')
        info = self._run(cmd, 'the mix', s.timeouts.mix_sec, cancel)
        library.set_step(songs, meta, 'mix', 'done', **info)
        cancel.check()
        if not library.final_files_present(d):
            raise StepFailed('mix', 'the mix left no vocals_final.wav / inst_final.wav')
        meta['duration'] = info.get('duration', meta.get('duration'))
        meta['status'] = 'ready'
        meta['ready_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
        library.write_meta(songs, meta)
        self.log.info('ready: %s (%s), transpose %+d', meta.get('name'), song_id, shift)
        return meta
