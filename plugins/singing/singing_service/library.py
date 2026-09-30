"""The songs library: one folder per song, and what is written in it.

    <songs>/<song id>/
        orig.<ext>          the original (copied from the folder, or downloaded)
        lyric.lrc           its lyrics, possibly empty
        meta.json           title, artists, duration, state of every step, the settings the voice was converted with
        vocals.wav          the lead vocal, dry            (separation)
        inst.wav            the band plus the backing vocals
        f0_src.json         pitch statistics of the lead vocal
        vocals_rvc.wav      the converted voice
        vocals_final.wav    mono, mixed level: what the stage plays and the mouth follows
        inst_final.wav      stereo, mixed level, transposed with the voice when needed
        mix.mp3             both together, for listening by hand

The folder is the orchestrator's `paths.songs`: the stage fetches `vocals_final.wav` and `inst_final.wav` from it.
meta.json keeps the field names the previous service used, so an old library folder can be pointed at as it is.
"""

from __future__ import annotations

import os
import time
from typing import Any

from .settings import Rvc
from .util import check_song_id, read_json, write_json_atomic

VOCALS_FINAL = 'vocals_final.wav'
INST_FINAL = 'inst_final.wav'
LYRIC_FILE = 'lyric.lrc'


def song_dir(songs_dir: str, song_id: object) -> str:
    return os.path.join(songs_dir, check_song_id(song_id))


def meta_path(songs_dir: str, song_id: object) -> str:
    return os.path.join(song_dir(songs_dir, song_id), 'meta.json')


def read_meta(songs_dir: str, song_id: object) -> dict[str, Any] | None:
    """The song's meta.json, or None when there is none or it is unreadable (a torn write counts as never done)."""
    meta = read_json(meta_path(songs_dir, song_id), None)
    return meta if isinstance(meta, dict) else None


def write_meta(songs_dir: str, meta: dict[str, Any]) -> None:
    write_json_atomic(meta_path(songs_dir, meta['id']), meta)


def set_step(songs_dir: str, meta: dict[str, Any], step: str, status: str, **info: Any) -> None:
    meta.setdefault('steps', {})[step] = {
        'status': status,
        'time': time.strftime('%Y-%m-%d %H:%M:%S'),
        **info,
    }
    write_meta(songs_dir, meta)


def new_meta(song: dict[str, Any]) -> dict[str, Any]:
    return {
        'id': str(song['id']),
        'name': song.get('name', ''),
        'artists': list(song.get('artists', [])),
        'album': song.get('album', ''),
        'duration': song.get('duration', 0),
        'requests': [],
        'steps': {},
        'status': 'new',
    }


def is_ready(meta: dict[str, Any] | None) -> bool:
    return bool(meta) and meta is not None and meta.get('status') == 'ready'


def invalidate(songs_dir: str, song_id: object) -> None:
    """Marks a song as not ready, so the next request prepares it again (its final files went missing)."""
    meta = read_meta(songs_dir, song_id)
    if meta is not None and meta.get('status') == 'ready':
        meta['status'] = 'downloaded'
        write_meta(songs_dir, meta)


def rvc_signature(rvc: Rvc) -> dict[str, Any]:
    """Everything that decides what the converted voice sounds like. When one of these changes, the songs already
    prepared are stale: only the conversion and the mix run again, the separation stays."""
    return {
        'model': os.path.basename(rvc.model_pth),
        'index': os.path.basename(rvc.index),
        'index_rate': rvc.index_rate,
        'protect': rvc.protect,
        'volume_envelope': rvc.volume_envelope,
        'f0_method': rvc.f0_method,
        'embedder': rvc.embedder,
    }


def is_current(meta: dict[str, Any] | None, rvc: Rvc) -> bool:
    """Ready, and converted with the settings in force now."""
    conv = ((meta or {}).get('steps') or {}).get('convert') or {}
    return is_ready(meta) and conv.get('rvc') == rvc_signature(rvc)


def orig_file(directory: str) -> str | None:
    if not os.path.isdir(directory):
        return None
    for name in sorted(os.listdir(directory)):
        if name.startswith('orig.') and not name.endswith('.part'):
            return os.path.join(directory, name)
    return None


def final_files_present(directory: str) -> bool:
    return all(os.path.isfile(os.path.join(directory, n)) for n in (VOCALS_FINAL, INST_FINAL))


def read_lyric_text(directory: str) -> str:
    try:
        with open(os.path.join(directory, LYRIC_FILE), encoding='utf-8-sig') as handle:
            return handle.read()
    except OSError:
        return ''
