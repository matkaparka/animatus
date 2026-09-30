"""Starts the service:  python -m singing_service --port N --songs-dir DIR --state-dir DIR [--settings FILE]

The orchestrator's plugin supervisor runs this (see plugin.yaml). Only 127.0.0.1 is ever bound.
A settings file that cannot be read does not end the process: it answers /health with `ok: false` and the reason, so
the operator sees why in the console instead of "exited with code 2".
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading

from .api import ApiServer
from .runtime import build
from .service import SingingService
from .settings import SettingsError, load_config
from .sources import cookie_from_environment


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='singing_service')
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--songs-dir', required=True, help='the songs library: the same folder as paths.songs')
    ap.add_argument('--state-dir', required=True, help='where the queue and the locks are kept')
    ap.add_argument('--settings', default='', help='the YAML file with everything else (may be missing)')
    args = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format='%(asctime)s %(name)s %(levelname)s %(message)s',
        datefmt='%H:%M:%S',
    )
    log = logging.getLogger('singing')

    service: SingingService | None = None
    startup_error = ''
    try:
        config = load_config(args.settings, args.songs_dir, args.state_dir)
        source, pipeline = build(config, cookie_from_environment())
        service = SingingService(config, source, pipeline)
        for problem in config.problems():
            log.error('setup problem: %s', problem)
        if config.source_kind == 'local' and not cookie_from_environment():
            log.info('source: the local folder %s', config.settings.paths.local_music)
    except SettingsError as error:
        startup_error = str(error)
        log.error('the settings cannot be used: %s', startup_error)

    server = ApiServer(service, args.port, startup_error)
    # the handler runs in the thread that serves, and stopping waits for that loop: stop from another thread
    stop = lambda *_: threading.Thread(target=server.stop, daemon=True).start()  # noqa: E731
    for name in ('SIGINT', 'SIGTERM', 'SIGBREAK'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)
    print(f'singing service listening on 127.0.0.1:{server.port}', flush=True)
    try:
        server.serve()
    finally:
        if service is not None:
            service.close()  # kills the tool the worker is running: the GPU must not stay busy behind a stopped service
        server.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
