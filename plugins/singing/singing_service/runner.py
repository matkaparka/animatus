"""Running the pipeline's tools as subprocesses that cannot hang the worker.

Separation, pitch analysis, voice conversion and mixing each run in a process of their own: the models live and die
there, so the GPU memory is free again when the step ends. What the legacy service did not do (and what could hold
its worker and the GPU lock for ever) is bound each of them: every run has a timeout, and when it runs out, or the
entry being worked on is removed, the process and everything it started is killed.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Protocol

from .control import Cancel
from .errors import Abandoned, StepFailed, StepTimeout
from .util import tail

NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


@dataclass
class RunResult:
    stdout: str
    stderr: str
    seconds: float


class Runner(Protocol):
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
        """Runs a command to its end. Raises StepFailed (non-zero exit), StepTimeout (killed after `timeout`
        seconds) or Abandoned (killed because `cancel` was set)."""
        ...


def kill_tree(proc: subprocess.Popen[bytes]) -> None:
    """Ends a process and everything it started."""
    if proc.poll() is not None:
        return
    try:
        if os.name == 'nt':
            taskkill = shutil.which('taskkill') or os.path.join(
                os.environ.get('SystemRoot', 'C:\\Windows'), 'System32', 'taskkill.exe'
            )
            subprocess.run(
                [taskkill, '/PID', str(proc.pid), '/T', '/F'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
                creationflags=NO_WINDOW,
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()  # the root at least, if the tree kill did not work
    except OSError:
        pass


def last_json(stdout: str) -> dict[str, Any]:
    """The last line of a tool's output that is a JSON object (its result); empty when there is none."""
    for line in reversed(stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith('{'):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return {}


class ProcessRunner:
    poll_sec = 0.2

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
        if cancel is not None:
            cancel.check()  # an entry that is already gone never gets a process
        kwargs: dict[str, Any] = {}
        if os.name == 'nt':
            kwargs['creationflags'] = NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs['start_new_session'] = True
        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                **kwargs,
            )
        except OSError as error:
            raise StepFailed(what, f'{what} could not be started: {error.strerror or error}') from None
        out = err = b''
        try:
            while True:
                if cancel is not None and cancel.is_set():
                    self._reap(proc)
                    raise Abandoned(cancel.reason)
                left = timeout - (time.monotonic() - started)
                if left <= 0:
                    self._reap(proc)
                    raise StepTimeout(f'{what} ran longer than {timeout:g} s and was stopped')
                try:
                    out, err = proc.communicate(timeout=min(self.poll_sec, left))
                    break
                except subprocess.TimeoutExpired:
                    continue
        except BaseException:
            # any other way out (an interrupt, a bug): the child must not keep running
            self._reap(proc)
            raise
        seconds = time.monotonic() - started
        stdout, stderr = out.decode('utf-8', 'replace'), err.decode('utf-8', 'replace')
        if proc.returncode != 0:
            raise StepFailed(
                what,
                f'{what} failed (exit code {proc.returncode})',
                tail(stderr or stdout),
            )
        return RunResult(stdout=stdout, stderr=stderr, seconds=round(seconds, 1))

    @staticmethod
    def _reap(proc: subprocess.Popen[bytes]) -> None:
        kill_tree(proc)
        try:
            proc.communicate(timeout=5)
        except (subprocess.SubprocessError, OSError):
            for stream in (proc.stdout, proc.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
