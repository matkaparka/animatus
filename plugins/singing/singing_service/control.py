"""Cancellation and deadlines: how work that has been given up on finds out."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from .errors import Abandoned


class Cancel:
    """Set when the entry being worked on is removed, cancelled or the service is closing.

    Everything that can take a while (a subprocess wait, a lock wait, a download loop) looks at it and stops."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self.reason = ''

    def set(self, reason: str = '') -> None:
        self.reason = reason
        self._event.set()

    def is_set(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float) -> bool:
        """Sleeps up to `timeout` seconds; true as soon as it was set."""
        return self._event.wait(timeout)

    def check(self) -> None:
        if self._event.is_set():
            raise Abandoned(self.reason)


class Deadline:
    """How long the caller is still willing to wait. Monotonic, so a changed clock cannot stretch it."""

    def __init__(self, seconds: float, mono: Callable[[], float] = time.monotonic) -> None:
        self._mono = mono
        self._end = mono() + max(0.0, seconds)

    def remaining(self) -> float:
        return max(0.0, self._end - self._mono())

    def expired(self) -> bool:
        return self.remaining() <= 0.0

    def cap(self, seconds: float) -> float:
        """`seconds`, but no more than what is left."""
        return min(seconds, self.remaining())
