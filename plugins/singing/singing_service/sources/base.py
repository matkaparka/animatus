"""Where songs come from.

The queue and the pipeline know one small interface; the operator chooses the adapter. `local` (a folder of audio
files the operator keeps) needs no network at all and is what a fresh setup uses. `netease` talks to a NetEase API
server the operator runs; it is a separate module so a build that does not ship it only leaves that file out.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..control import Cancel, Deadline
from .matching import Song


class SongSource(ABC):
    kind = ''

    @abstractmethod
    def search(self, keyword: str, deadline: Deadline, cancel: Cancel | None = None) -> list[Song]:
        """Candidates for what the viewer typed, best guess first. Empty when nothing fits.
        Raises SourceUnavailable when the source cannot answer now."""

    def precheck(self, song: Song) -> tuple[str, str] | None:
        """(code, detail) when the search result alone shows the song cannot be fetched (a paid track when there
        is no membership), without asking the source again; None when it may work."""
        return None

    @abstractmethod
    def fetch(self, song: Song, dest_dir: str, cancel: Cancel, timeout: float) -> None:
        """Puts the original in `dest_dir` as `orig.<ext>` and its lyrics, if any, as `lyric.lrc`.
        Raises SongRejected when this song cannot be had, SourceUnavailable when the source failed."""

    def status(self) -> dict[str, Any]:
        return {'kind': self.kind}

    def resume(self) -> None:
        """Lifts a stop the source put itself under (the NetEase circuit breaker)."""

    def catalog(self) -> list[Song]:
        """Every song the source can prepare in bulk (for `prefetch --all`)."""
        raise NotImplementedError(f'the {self.kind} source cannot list all its songs')

    def details(self, song_ids: list[str], deadline: Deadline) -> list[Song]:
        """The songs with these ids (for `prefetch --ids`)."""
        raise NotImplementedError(f'the {self.kind} source cannot look songs up by id')

    def playlist(self, playlist_id: str, deadline: Deadline) -> list[Song]:
        """The songs of a playlist (for `prefetch --playlist`)."""
        raise NotImplementedError(f'the {self.kind} source has no playlists')
