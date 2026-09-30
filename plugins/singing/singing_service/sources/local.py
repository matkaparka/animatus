"""The local source: a folder of audio files the operator provides.

A file is a song. `Artist - Title.mp3` gives both names (several artists separated by `/`, `&`, `、` or `,`); any
other name is a title. A `.lrc` file with the same name next to it holds the lyrics. Requests are matched against
the names, so nothing here needs a network.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
from collections.abc import Callable
from typing import Any

from ..control import Cancel, Deadline
from ..errors import SongRejected
from ..settings import AUDIO_EXTENSIONS
from .base import SongSource
from .matching import Song, is_candidate

_SPLIT_ARTISTS = re.compile(r'\s*(?:[/&、,，]|\bfeat\b\.?)\s*', re.IGNORECASE)
MAX_FILES = 20000
COPY_CHUNK = 1 << 20


def song_from_path(root: str, path: str) -> Song:
    rel = os.path.relpath(path, root).replace(os.sep, '/')
    stem = os.path.splitext(os.path.basename(path))[0].strip()
    artists: list[str] = []
    title = stem
    if ' - ' in stem:
        left, right = stem.split(' - ', 1)
        if left.strip() and right.strip():
            artists = [a for a in _SPLIT_ARTISTS.split(left.strip()) if a]
            title = right.strip()
    return {
        'id': 'local_' + hashlib.sha1(rel.lower().encode('utf-8')).hexdigest()[:12],
        'name': title,
        'artists': artists,
        'album': '',
        'duration': 0.0,
        'path': path,
    }


def audio_duration(path: str) -> float:
    """Length in seconds when the file's header says (0 when it cannot be told: the pipeline measures again)."""
    try:
        import soundfile  # optional here: the audio environment has it, so does the light one

        return float(soundfile.info(path).duration)
    except Exception:  # noqa: BLE001 - any reader problem just means "unknown"
        return 0.0


class LocalSource(SongSource):
    kind = 'local'

    def __init__(
        self,
        folder: str,
        *,
        extensions: tuple[str, ...] = AUDIO_EXTENSIONS,
        rescan_sec: float = 15.0,
        search_limit: int = 10,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.folder = folder
        self.extensions = tuple(e.lower() for e in extensions)
        self.rescan_sec = rescan_sec
        self.search_limit = search_limit
        self._clock = clock
        self._index: list[Song] = []
        self._scanned_at = -1e18

    def _songs(self) -> list[Song]:
        """The files in the folder, read again when the last look is a little old (files get added while live)."""
        if self._clock() - self._scanned_at < self.rescan_sec:
            return self._index
        found: list[Song] = []
        for directory, dirs, files in os.walk(self.folder):
            dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
            for name in sorted(files):
                if name.lower().endswith(self.extensions) and not name.startswith('.'):
                    found.append(song_from_path(self.folder, os.path.join(directory, name)))
                    if len(found) >= MAX_FILES:
                        break
            if len(found) >= MAX_FILES:
                break
        self._index = found
        self._scanned_at = self._clock()
        return found

    def search(self, keyword: str, deadline: Deadline, cancel: Cancel | None = None) -> list[Song]:
        hits = [s for s in self._songs() if is_candidate(keyword, s)][: self.search_limit]
        return [{**s, 'duration': audio_duration(s['path'])} for s in hits]

    def fetch(self, song: Song, dest_dir: str, cancel: Cancel, timeout: float) -> None:
        source = song.get('path')
        if not source or not os.path.isfile(source):
            raise SongRejected('the file is gone from the music folder', code='local_missing')
        os.makedirs(dest_dir, exist_ok=True)
        ext = os.path.splitext(source)[1].lower()
        self._copy(source, os.path.join(dest_dir, f'orig{ext}'), cancel)
        lyric = os.path.splitext(source)[0] + '.lrc'
        text = ''
        if os.path.isfile(lyric):
            try:
                with open(lyric, encoding='utf-8-sig', errors='replace') as handle:
                    text = handle.read()
            except OSError:
                text = ''
        with open(os.path.join(dest_dir, 'lyric.lrc'), 'w', encoding='utf-8') as handle:
            handle.write(text)

    @staticmethod
    def _copy(source: str, dest: str, cancel: Cancel) -> None:
        part = dest + '.part'
        try:
            with open(source, 'rb') as src, open(part, 'wb') as out:
                while True:
                    cancel.check()
                    chunk = src.read(COPY_CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
            os.replace(part, dest)
        finally:
            if os.path.exists(part):
                try:
                    os.remove(part)
                except OSError:
                    pass

    def status(self) -> dict[str, Any]:
        """How many files the last look found; asking never walks the folder."""
        return {'kind': 'local', 'files': len(self._index)}

    def catalog(self) -> list[Song]:
        self._scanned_at = -1e18  # a bulk run starts from what is on disk now
        return self._songs()
