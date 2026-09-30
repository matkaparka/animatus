"""Prepares songs ahead of the show, into the same library the service uses.

    python -m singing_service.prefetch --songs-dir DIR --state-dir DIR [--settings FILE] MODE [--max N] [--dry-run]

  --all             every file of the local music folder
  --ids ID ...      these songs (NetEase ids)
  --playlist ID     a NetEase playlist
  --refresh         songs already prepared with older voice settings: convert and mix them again (no network)

It can run while the service does: the GPU lock and the NetEase request queue are shared across processes. A song
that cannot be sung (no rights, no vocals, too long) is skipped with its reason; a tripped breaker or a spent
download cap stops the run, as a person has to look at those. `--max` is the most new downloads of one run.
The membership cookie, if there is one, is read from the NCM_COOKIE environment variable.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any

from . import library
from .control import Cancel, Deadline
from .errors import Abandoned, SingingError, SourceUnavailable
from .pipeline import Pipeline
from .runtime import build
from .settings import Config, SettingsError, load_config
from .sources import cookie_from_environment
from .sources.base import SongSource
from .sources.matching import Song

log = logging.getLogger('singing.prefetch')
#: What stops the whole run rather than only skipping one song.
STOPPING_CODES = ('source_halted', 'download_cap')


@dataclass
class Report:
    prepared: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    stopped: str = ''


def _title(song: Song) -> str:
    artists = '/'.join(song.get('artists', []))
    return f'{song["name"]} - {artists}' if artists else str(song['name'])


def prefetch(
    config: Config,
    source: SongSource,
    pipeline: Pipeline,
    songs: list[Song],
    *,
    max_new: int = 100,
    dry_run: bool = False,
) -> Report:
    """Prepares each song that is not ready with today's settings. Nothing here raises for one song's trouble."""
    report = Report()
    cancel = Cancel()
    new_downloads = 0
    for number, song in enumerate(songs, 1):
        title = _title(song)
        meta = library.read_meta(config.songs_dir, song['id'])
        if library.is_current(meta, config.settings.rvc):
            report.skipped.append(title)
            continue
        if dry_run:
            log.info('[%d/%d] would prepare %s (%s)', number, len(songs), title, song['id'])
            continue
        if new_downloads >= max_new and not library.orig_file(library.song_dir(config.songs_dir, song['id'])):
            report.stopped = f'--max {max_new} new downloads reached'
            break
        log.info('[%d/%d] %s', number, len(songs), title)
        try:
            had_original = bool(library.orig_file(library.song_dir(config.songs_dir, song['id'])))
            pipeline.fetch(song, {'uid': '0', 'name': 'prefetch'}, cancel)
            if not had_original:
                new_downloads += 1
            done = pipeline.process(str(song['id']), cancel)
            report.prepared.append(title)
            for warning in done.get('warnings') or []:
                log.info('    note: %s', warning)
        except SourceUnavailable as error:
            log.warning('    %s: %s', error.code, error.reason)
            report.failed.append((title, error.reason))
            if error.code in STOPPING_CODES:
                report.stopped = f'{error.code}: {error.reason}'
                break
        except Abandoned:
            report.stopped = 'interrupted'
            break
        except SingingError as error:
            log.info('    skipped (%s): %s', error.code, error.reason)
            report.failed.append((title, error.reason))
        except Exception as error:  # noqa: BLE001 - one song's bug must not end a night's run
            log.exception('    unexpected error')
            report.failed.append((title, f'{type(error).__name__}: {error}'))
    return report


def stale_songs(config: Config) -> list[Song]:
    """The songs in the library that are ready but were converted with other voice settings."""
    found: list[Song] = []
    if not os.path.isdir(config.songs_dir):
        return found
    for name in sorted(os.listdir(config.songs_dir)):
        try:
            meta = library.read_meta(config.songs_dir, name)
        except ValueError:
            continue
        if meta and library.is_ready(meta) and not library.is_current(meta, config.settings.rvc):
            found.append({'id': meta['id'], 'name': meta.get('name', name), 'artists': meta.get('artists', []), 'album': '', 'duration': meta.get('duration', 0)})
    return found


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='singing_service.prefetch')
    ap.add_argument('--songs-dir', required=True)
    ap.add_argument('--state-dir', required=True)
    ap.add_argument('--settings', default='')
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--all', action='store_true')
    mode.add_argument('--ids', nargs='+')
    mode.add_argument('--playlist')
    mode.add_argument('--refresh', action='store_true')
    ap.add_argument('--max', type=int, default=100, help='the most new downloads of this run')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(asctime)s %(message)s', datefmt='%H:%M:%S')
    try:
        config = load_config(args.settings, args.songs_dir, args.state_dir)
    except SettingsError as error:
        print(f'the settings cannot be used: {error}', file=sys.stderr)
        return 2
    problems = config.problems(pipeline=not args.dry_run)
    if problems:
        for problem in problems:
            print(f'setup problem: {problem}', file=sys.stderr)
        return 2
    source, pipeline = build(config, cookie_from_environment())
    started = time.time()
    try:
        deadline = Deadline(3600)
        if args.refresh:
            songs = stale_songs(config)
        elif args.all:
            songs = source.catalog()
        elif args.ids:
            songs = source.details([str(i) for i in args.ids], deadline)
        else:
            songs = source.playlist(str(args.playlist), deadline)
    except NotImplementedError as error:
        print(str(error), file=sys.stderr)
        return 2
    except SingingError as error:
        print(f'cannot list the songs: {error.reason}', file=sys.stderr)
        return 1
    report = prefetch(config, source, pipeline, songs, max_new=args.max, dry_run=args.dry_run)
    summary: dict[str, Any] = {
        'prepared': len(report.prepared),
        'already ready': len(report.skipped),
        'failed': len(report.failed),
        'minutes': round((time.time() - started) / 60, 1),
    }
    log.info('done: %s', ', '.join(f'{k} {v}' for k, v in summary.items()))
    for title, reason in report.failed:
        log.info('  - %s: %s', title, reason)
    if report.stopped:
        log.warning('stopped early: %s', report.stopped)
    return 1 if report.stopped or report.failed else 0


if __name__ == '__main__':
    sys.exit(main())
