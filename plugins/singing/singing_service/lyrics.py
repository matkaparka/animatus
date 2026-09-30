"""Lyrics: LRC text to the `[{t, text}]` list the stage shows, one line at a time."""

from __future__ import annotations

import math
import re

# The stage's protocol takes at most this many lines, each at most this long.
MAX_LINES = 2000
MAX_LINE_CHARS = 400

_STAMP = re.compile(r'\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]')
_ANY_TAG = re.compile(r'\[[^\]]*\]')
# "Lyricist: ...", "Composer: ..." and their Chinese forms: credits, not words to sing.
_CREDIT = re.compile(
    r'^\s*(作词|作曲|编曲|制作人|制作|演唱|原唱|混音|混缩|录音|母带|和声|合声|吉他|贝斯|鼓|键盘|弦乐|监制|出品|发行|企划|统筹'
    r'|词|曲|编|OP|SP|Producer|Lyricist|Composer|Arranger)\s*[:：]',
    re.IGNORECASE,
)


def parse_lrc(text: str) -> list[dict[str, object]]:
    """Timed lines from LRC text. A line may carry several time stamps; credits and empty lines are dropped;
    the result is in time order and fits what the stage accepts."""
    lines: list[tuple[float, str]] = []
    for raw in (text or '').splitlines():
        stamps = _STAMP.findall(raw)
        if not stamps:
            continue
        body = _ANY_TAG.sub('', raw).strip()
        if not body or _CREDIT.match(body):
            continue
        body = body[:MAX_LINE_CHARS]
        for minutes, seconds in stamps:
            t = int(minutes) * 60 + float(seconds.replace(':', '.'))
            if math.isfinite(t):
                lines.append((t, body))
    lines.sort(key=lambda pair: pair[0])
    return [{'t': round(t, 3), 'text': body} for t, body in lines[:MAX_LINES]]
