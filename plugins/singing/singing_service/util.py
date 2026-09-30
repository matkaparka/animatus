"""Small helpers: JSON files that survive a crash, safe names, text tails."""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

# A song id becomes a folder name, a URL path segment and a `sing.play` id, so it is kept to a safe alphabet.
SONG_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')


def check_song_id(song_id: object) -> str:
    text = str(song_id)
    if not SONG_ID.match(text) or text.endswith('.'):
        raise ValueError(f'not a usable song id: {text[:40]!r}')
    return text


def read_json(path: str, default: Any) -> Any:
    """The JSON in `path`, or `default` when the file is missing, torn or not JSON at all."""
    try:
        with open(path, encoding='utf-8-sig') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def write_json_atomic(path: str, value: Any) -> None:
    """Writes next to the target and renames over it: a crash leaves the old file or the new one, never half."""
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    tmp = f'{path}.tmp'
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=1)
    # Windows refuses a rename while a virus scanner or a reader holds the target for a moment.
    for attempt in range(8):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.05 * (attempt + 1))


def tail(text: str, lines: int = 15, max_chars: int = 1200) -> str:
    """The last few lines of a subprocess's output, for an error message."""
    kept = '\n'.join(text.strip().splitlines()[-lines:])
    return kept[-max_chars:]


def fmt_duration(seconds: float) -> str:
    total = int(seconds)
    return f'{total // 60}分{total % 60:02d}秒'
