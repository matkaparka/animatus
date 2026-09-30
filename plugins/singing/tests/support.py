"""Shared plumbing of the tests: temporary folders, tiny generated audio, waiting for a condition."""

from __future__ import annotations

import math
import os
import shutil
import struct
import tempfile
import time
import unittest
import wave
from collections.abc import Callable


class TempCase(unittest.TestCase):
    """A test case that owns temporary folders and removes them at the end."""

    def tmpdir(self, name: str = '') -> str:
        root = tempfile.mkdtemp(prefix='singing-test-')
        self.addCleanup(shutil.rmtree, root, True)
        return os.path.join(root, name) if name else root


def write_wav(path: str, seconds: float = 0.2, rate: int = 8000, freq: float = 440.0, channels: int = 1) -> str:
    """A few hundred bytes of sine wave. No test carries a recording."""
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    frames = int(seconds * rate)
    with wave.open(path, 'wb') as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        data = bytearray()
        for i in range(frames):
            sample = int(8000 * math.sin(2 * math.pi * freq * i / rate))
            data += struct.pack('<h', sample) * channels
        out.writeframes(bytes(data))
    return path


def wait_until(condition: Callable[[], bool], timeout: float = 5.0, what: str = 'the condition') -> None:
    end = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > end:
            raise AssertionError(f'timed out after {timeout:g} s waiting for {what}')
        time.sleep(0.01)
