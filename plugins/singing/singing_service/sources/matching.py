"""Choosing the song a request means from a list of candidates."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

Song = dict[str, Any]

_BRACKETS = re.compile(r'[（(\[【［].*?[)）\]】］]')


def norm(text: str) -> str:
    """For comparing: full and half width alike, lower case, only letters and digits."""
    folded = unicodedata.normalize('NFKC', text or '').lower()
    return ''.join(c for c in folded if unicodedata.category(c)[0] in 'LN')


def _title_key(song: Song) -> str:
    return norm(_BRACKETS.sub('', song['name'])) or norm(song['name'])


def is_candidate(keyword: str, song: Song) -> bool:
    """Whether a song from a folder is worth ranking at all for the request: its title or artist is in the words,
    or the words are part of them. (A search server has already done this; a folder has not.)"""
    kw = norm(keyword)
    if not kw:
        return False
    title = _title_key(song)
    artists = [a for a in (norm(x) for x in song.get('artists', [])) if a]
    if title and (title in kw or kw in title):
        return True
    return any(a in kw for a in artists) or kw in ''.join(artists) + title


def best_match(keyword: str, songs: list[Song]) -> Song:
    """The song that fits "title [artist]" best.

    A search server's first hit is not always the one meant (a request for one song by one artist can return another
    song with a similar name first). The words minus the artists that appear in them are compared with the title
    (brackets such as "Live" or "DJ version" removed): equal scores highest, one containing the other next; an artist
    hit adds a little; ties keep the server's order. If nothing fits, the first one is taken. `songs` is not empty.
    """
    kw = norm(keyword)
    best, best_score = songs[0], 0.0
    for rank, song in enumerate(songs):
        title = _title_key(song)
        artists = [a for a in (norm(x) for x in song.get('artists', [])) if a]
        artist_hit = any(a in kw for a in artists)
        kw_title = kw
        for a in artists:
            kw_title = kw_title.replace(a, '')
        if title and title == kw_title:
            t = 3.0
        elif title and kw_title and (title in kw_title or kw_title in title):
            t = 1.0 + min(len(title), len(kw_title)) / max(len(title), len(kw_title))
        else:
            t = 0.0
        score = t * 2 + (1 if artist_hit else 0) - rank * 0.01
        if score > best_score:
            best, best_score = song, score
    return best
