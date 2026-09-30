"""Layer 1: the keyword blocklist, Chinese and English.

One entry per line, `#` starts a comment line, case does not matter. Two kinds of entry:

* only ASCII (`nsfw`, `see-through`): matches whole words, with punctuation, spaces and underscores counting as the
  same separator. `sex` does not hit "Essex", `bra` does not hit "brave", `see through` hits "see_through".
* anything else (Chinese, or mixed like `触手play`): matches as a substring, and also with the spaces and punctuation
  of the text taken out, so `色 情` and `色.情` hit an entry `色情`.

Full-width letters are folded to plain ones first (NFKC). The same rules are written again in TypeScript
(packages/orchestrator/src/modes/draw/blocklist.ts, the check that runs before any model is asked);
`blocklist_cases.json` next to this package pins them for both.

A list that cannot be read, or has no words, is an error, never an empty list: a safety layer must not switch itself
off because a file went missing.
"""

from __future__ import annotations

import re
import time
import unicodedata
from collections.abc import Callable, Iterable
from pathlib import Path

_SEPARATORS = re.compile(r"[^a-z0-9]+")


class BlocklistError(Exception):
    """The blocklist cannot be used right now (a file is missing or unreadable, or there are no words)."""


def fold(text: str) -> str:
    """Case-insensitive comparison form: NFKC, lower case."""
    return unicodedata.normalize("NFKC", text).lower()


def squeeze(text: str) -> str:
    """Only the letters and digits, so spacing tricks (`色 情`, `n.u.d.e`) do not get around an entry."""
    return "".join(ch for ch in text if ch.isalnum())


def _word_key(folded: str) -> str:
    return " " + _SEPARATORS.sub(" ", folded).strip() + " "


class _Entry:
    """One listed word, prepared for matching."""

    __slots__ = ("word", "folded", "words_key", "squeezed")

    def __init__(self, word: str) -> None:
        self.word = word
        self.folded = fold(word)
        if self.folded.isascii():
            self.words_key: str | None = _word_key(self.folded)
            self.squeezed = ""
        else:
            self.words_key = None
            self.squeezed = squeeze(self.folded)

    @property
    def usable(self) -> bool:
        return self.words_key.strip() != "" if self.words_key is not None else self.folded.strip() != ""

    def matches(self, folded_text: str, text_key: str, squeezed_text: str) -> bool:
        if self.words_key is not None:
            return self.words_key in text_key
        if self.folded in folded_text:
            return True
        return self.squeezed != "" and self.squeezed in squeezed_text


def parse_words(content: str) -> list[str]:
    words = []
    for line in content.lstrip("﻿").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            words.append(line)
    return words


class Blocklist:
    """The words of one or more files, re-read when a file changes (looked at most every `recheck_sec`)."""

    def __init__(
        self,
        paths: Iterable[Path],
        *,
        now: Callable[[], float] = time.monotonic,
        recheck_sec: float = 5.0,
    ) -> None:
        self._paths = tuple(Path(p) for p in paths)
        self._now = now
        self._recheck_sec = recheck_sec
        self._entries: list[_Entry] = []
        self._stamps: dict[Path, float | None] = {}
        self._checked_at = float("-inf")
        self.error: str | None = None
        self.reload()

    # ─────────────────────────────── loading ───────────────────────────────

    @property
    def words(self) -> int:
        return len(self._entries)

    def _stamp(self, path: Path) -> float | None:
        try:
            return path.stat().st_mtime
        except OSError:
            return None

    def reload(self) -> None:
        """Read every file again. On any problem `error` says what, and nothing may pass `check` until it is fixed."""
        self._checked_at = self._now()
        entries: list[_Entry] = []
        problem: str | None = None
        self._stamps = {p: self._stamp(p) for p in self._paths}
        for path in self._paths:
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as e:
                problem = f"{path}: {e.strerror if isinstance(e, OSError) and e.strerror else e}"
                break
            entries.extend(e for e in map(_Entry, parse_words(text)) if e.usable)
        if problem is None and not entries:
            problem = "the blocklist has no words: " + ", ".join(str(p) for p in self._paths)
        if problem is not None:
            self.error = f"the blocklist cannot be used ({problem})"
            self._entries = []
            return
        self.error = None
        self._entries = entries

    def _refresh(self) -> None:
        if self._now() - self._checked_at < self._recheck_sec:
            return
        self._checked_at = self._now()
        if any(self._stamp(p) != self._stamps.get(p) for p in self._paths):
            self.reload()

    def check(self) -> None:
        """Raise BlocklistError unless the list is loaded."""
        self._refresh()
        if self.error is not None:
            raise BlocklistError(self.error)

    # ─────────────────────────────── matching ───────────────────────────────

    def hit(self, *texts: str) -> str | None:
        """The listed word that matches any of the texts, or None."""
        self.check()
        for text in texts:
            folded = fold(text)
            key = _word_key(folded)
            squeezed = squeeze(folded)
            for entry in self._entries:
                if entry.matches(folded, key, squeezed):
                    return entry.word
        return None

    def scrub_prompt(self, prompt: str) -> tuple[str, list[str]]:
        """Delete the comma-separated tags that hit the list. Returns the rest and what was deleted."""
        kept: list[str] = []
        dropped: list[str] = []
        for part in prompt.split(","):
            tag = part.strip()
            if not tag:
                continue
            (dropped if self.hit(tag) is not None else kept).append(tag)
        return ", ".join(kept), dropped
