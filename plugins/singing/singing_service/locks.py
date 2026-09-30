"""A lock between processes. The service and a prefetch run can work in the same library at the same time; the
GPU takes one job at a time and the NetEase server takes one request at a time, whoever asks.

Waiting is bounded and can be cancelled: a lock some other process holds for too long must not hold this one's
worker with it.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import IO

from .control import Cancel
from .errors import Abandoned

if os.name == 'nt':
    import msvcrt

    def _try_lock(handle: IO[bytes]) -> bool:
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def _unlock(handle: IO[bytes]) -> None:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

else:
    import fcntl

    def _try_lock(handle: IO[bytes]) -> bool:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def _unlock(handle: IO[bytes]) -> None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class FileLock:
    POLL = 0.1

    def __init__(self, path: str) -> None:
        self.path = path
        # Handles of one process do not always exclude each other: the threads of this process queue here first.
        self._threads = threading.Lock()
        self._file: IO[bytes] | None = None

    @contextmanager
    def hold(
        self,
        timeout: float,
        cancel: Cancel | None = None,
        on_timeout: Callable[[], Exception] | None = None,
    ) -> Iterator[None]:
        """Holds the lock inside the `with`. Waits at most `timeout` seconds (then raises what `on_timeout` makes,
        or TimeoutError) and gives up at once when `cancel` is set (raises Abandoned)."""
        self._acquire(time.monotonic() + timeout, cancel, on_timeout)
        try:
            yield
        finally:
            self._release()

    @staticmethod
    def _give_up_if_due(end: float, cancel: Cancel | None, on_timeout: Callable[[], Exception] | None) -> None:
        if cancel is not None and cancel.is_set():
            raise Abandoned(cancel.reason)
        if time.monotonic() >= end:
            raise on_timeout() if on_timeout else TimeoutError('timed out waiting for a lock')

    def _acquire(self, end: float, cancel: Cancel | None, on_timeout: Callable[[], Exception] | None) -> None:
        while not self._threads.acquire(timeout=self.POLL):
            self._give_up_if_due(end, cancel, on_timeout)
        try:
            os.makedirs(os.path.dirname(self.path) or '.', exist_ok=True)
            handle = open(self.path, 'a+b')
            try:
                while not _try_lock(handle):
                    self._give_up_if_due(end, cancel, on_timeout)
                    time.sleep(self.POLL)
            except BaseException:
                handle.close()
                raise
            self._file = handle
        except BaseException:
            self._threads.release()
            raise

    def _release(self) -> None:
        handle, self._file = self._file, None
        try:
            if handle is not None:
                try:
                    _unlock(handle)
                finally:
                    handle.close()
        finally:
            self._threads.release()
