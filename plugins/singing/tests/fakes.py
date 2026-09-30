"""Stand-ins for the parts the service tests do not run for real: a song source, and the pipeline's tools.

`FakeRunner` answers the commands the pipeline would run (separation, pitch analysis, voice conversion, mix) by
writing tiny placeholder files and printing what the real tool prints, so a song goes through every step without a
GPU, a model or any audio. It can be told to fail, to time out, or to hang until the job is cancelled.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from typing import Any

from singing_service.control import Cancel, Deadline
from singing_service.errors import Abandoned
from singing_service.runner import RunResult
from singing_service.settings import Config, parse_settings
from singing_service.sources.base import SongSource
from singing_service.sources.matching import Song, is_candidate

SAMPLE_LRC = '[00:01.00]first line\n[00:05.50]second line'


def song(sid: str, name: str, artists: tuple[str, ...] = ('Artist',), duration: float = 200.0, **extra: Any) -> Song:
    return {'id': sid, 'name': name, 'artists': list(artists), 'album': '', 'duration': duration, **extra}


class FakeClock:
    def __init__(self, now: float = 1_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeSource(SongSource):
    kind = 'fake'

    def __init__(self, songs: list[Song] | None = None) -> None:
        self.songs = songs or []
        self.precheck_codes: dict[str, tuple[str, str]] = {}
        self.search_calls: list[str] = []
        self.fetch_calls: list[str] = []
        self.search_hook: Callable[[str], None] | None = None
        self.fetch_hook: Callable[[Song, Cancel], None] | None = None
        self.search_error: Exception | None = None
        self.fetch_errors: list[Exception] = []
        self.halted: dict[str, Any] | None = None
        self.resumed = 0

    def search(self, keyword: str, deadline: Deadline, cancel: Cancel | None = None) -> list[Song]:
        self.search_calls.append(keyword)
        if self.search_hook:
            self.search_hook(keyword)
        if self.search_error:
            raise self.search_error
        return [s for s in self.songs if is_candidate(keyword, s)]

    def precheck(self, song: Song) -> tuple[str, str] | None:
        return self.precheck_codes.get(str(song['id']))

    def fetch(self, song: Song, dest_dir: str, cancel: Cancel, timeout: float) -> None:
        self.fetch_calls.append(str(song['id']))
        if self.fetch_hook:
            self.fetch_hook(song, cancel)
        if self.fetch_errors:
            raise self.fetch_errors.pop(0)
        os.makedirs(dest_dir, exist_ok=True)
        with open(os.path.join(dest_dir, 'orig.mp3'), 'wb') as handle:
            handle.write(b'ORIG')
        with open(os.path.join(dest_dir, 'lyric.lrc'), 'w', encoding='utf-8') as handle:
            handle.write(SAMPLE_LRC)

    def status(self) -> dict[str, Any]:
        return {'kind': 'fake', 'halted': self.halted}

    def resume(self) -> None:
        self.resumed += 1
        self.halted = None


class FakeRunner:
    """The pipeline's tools, simulated. `calls` records (step, command) in order."""

    def __init__(self, *, duration: float = 200.0, vocal_ratio: float = 0.3, median_hz: float = 220.0) -> None:
        self.duration = duration
        self.vocal_ratio = vocal_ratio
        self.median_hz = median_hz
        self.calls: list[tuple[str, list[str]]] = []
        self.errors: dict[str, Exception] = {}
        self.block: dict[str, threading.Event] = {}
        self.started: dict[str, threading.Event] = {}
        self.killed: list[str] = []
        self.separate_json: dict[str, Any] = {}

    def steps(self) -> list[str]:
        return [step for step, _ in self.calls]

    def started_event(self, step: str) -> threading.Event:
        return self.started.setdefault(step, threading.Event())

    @staticmethod
    def step_of(cmd: list[str]) -> str:
        if cmd[1].endswith('step_separate.py'):
            return 'separate'
        if cmd[1].endswith('step_f0.py'):
            return 'analyze'
        if cmd[1] == 'core.py':
            return 'convert'
        if cmd[1].endswith('step_mix.py'):
            return 'mix'
        raise AssertionError(f'a command the pipeline should not run: {cmd}')

    @staticmethod
    def arg(cmd: list[str], flag: str) -> str:
        return cmd[cmd.index(flag) + 1]

    def run(
        self,
        cmd: list[str],
        *,
        cwd: str | None,
        env: dict[str, str] | None,
        timeout: float,
        cancel: Cancel | None,
        what: str,
    ) -> RunResult:
        step = self.step_of(cmd)
        if cancel is not None:
            cancel.check()  # like the real runner: an entry that is gone never gets its process
        self.calls.append((step, cmd))
        self.started_event(step).set()
        if step in self.errors:
            raise self.errors[step]
        wait = self.block.get(step)
        while wait is not None and not wait.is_set():
            if cancel is not None and cancel.is_set():
                self.killed.append(step)  # what the real runner does: the tool is killed
                raise Abandoned(cancel.reason)
            time.sleep(0.005)
        return RunResult(stdout=self._simulate(step, cmd), stderr='', seconds=0.1)

    def _write(self, path: str, data: bytes = b'RIFF') -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as handle:
            handle.write(data)

    def _simulate(self, step: str, cmd: list[str]) -> str:
        if step == 'separate':
            d = cmd[2]
            self._write(os.path.join(d, 'vocals.wav'))
            self._write(os.path.join(d, 'inst.wav'))
            self._write(os.path.join(d, 'sep', 'orig.wav'))  # what the real tool leaves behind
            return 'progress...\n' + json.dumps(
                {'vocal_ratio': self.vocal_ratio, 'lead_ratio': 0.2, 'duration': self.duration, 'models': ['a'], **self.separate_json}
            )
        if step == 'analyze':
            quantiles = [self.median_hz * (0.5 + i / 100) for i in range(101)]  # 0.5x .. 1.5x of the median
            with open(self.arg(cmd, '--out'), 'w', encoding='utf-8') as handle:
                json.dump({'median_hz': self.median_hz, 'quantiles_hz': quantiles, 'voiced': 1000, 'frames': 2000}, handle)
            return json.dumps({'median_hz': self.median_hz})
        if step == 'convert':
            self._write(self.arg(cmd, '--output-path'))
            return 'converted'
        d = cmd[2]
        self._write(os.path.join(d, 'vocals_final.wav'))
        self._write(os.path.join(d, 'inst_final.wav'))
        return json.dumps({'duration': self.duration, 'preview': 'skipped', 'inst_shift': int(self.arg(cmd, '--shift'))})


def make_config(root: str, **overrides: Any) -> Config:
    """A configuration whose pipeline problems are none: the tools' folders and files exist (empty)."""
    applio = os.path.join(root, 'applio')
    os.makedirs(applio, exist_ok=True)
    music = os.path.join(root, 'music')
    os.makedirs(music, exist_ok=True)
    files = {name: os.path.join(root, name) for name in ('applio_python', 'voice.pth', 'ffmpeg')}
    for path in files.values():
        open(path, 'w').close()
    open(os.path.join(applio, 'core.py'), 'w').close()
    base: dict[str, Any] = {
        'paths': {'local_music': music, 'applio': applio, 'applio_python': files['applio_python'], 'ffmpeg': files['ffmpeg']},
        'rvc': {'model_pth': files['voice.pth']},
        'voice': {'f0_median_hz': 220.0, 'comfort_low_hz': 100.0, 'comfort_high_hz': 400.0},
        'retry': {'max_attempts': 3, 'backoff_sec': [10.0, 20.0]},
    }
    for section, values in overrides.items():
        if isinstance(values, dict) and isinstance(base.get(section), dict):
            base[section] = {**base[section], **values}
        else:
            base[section] = values
    return Config(
        settings=parse_settings(base),
        songs_dir=os.path.join(root, 'songs'),
        state_dir=os.path.join(root, 'state'),
    )
