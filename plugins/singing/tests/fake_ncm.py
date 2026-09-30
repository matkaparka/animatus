"""A stand-in for the NetEase API server (and its CDN), on a loopback port. No test talks to a real network."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

Reply = tuple[int, Any, dict[str, str]]


class FakeNcm:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.delay = 0.0  # seconds every answer is held back
        self.cdn_bytes = b'FAKE-AUDIO-' * 200
        self.routes: dict[str, Callable[[dict[str, Any]], Reply]] = {
            '/cloudsearch': self._search,
            '/song/detail': self._detail,
            '/song/url/v1': self._url,
            '/lyric': self._lyric,
            '/playlist/track/all': self._playlist,
            '/cdn/a.mp3': lambda req: (200, self.cdn_bytes, {}),
        }
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: object) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802 - http.server's name
                parsed = urlparse(self.path)
                req = {
                    'path': parsed.path,
                    'query': {k: v[0] for k, v in parse_qs(parsed.query).items()},
                    'cookie': self.headers.get('Cookie'),
                    'at': time.time(),
                }
                outer.requests.append(req)
                if outer.delay:
                    time.sleep(outer.delay)
                route = outer.routes.get(parsed.path)
                status, body, headers = route(req) if route else (404, {'code': 404, 'message': 'no route'}, {})
                data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode('utf-8')
                try:
                    self.send_response(status)
                    self.send_header('Content-Length', headers.pop('Content-Length', str(len(data))))
                    for key, value in headers.items():
                        self.send_header(key, value)
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f'http://127.0.0.1:{self.server.server_address[1]}'

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def count(self, path: str) -> int:
        return sum(1 for r in self.requests if r['path'] == path)

    # ─── default answers ───

    def _search(self, req: dict[str, Any]) -> Reply:
        songs = [
            {'id': 111, 'name': 'First Song', 'ar': [{'name': 'Artist A'}], 'al': {'name': 'Album'}, 'dt': 215000, 'fee': 0},
            {'id': 222, 'name': 'Paid Song', 'ar': [{'name': 'Artist B'}], 'al': {'name': 'Album 2'}, 'dt': 180000, 'fee': 1},
        ]
        return 200, {'code': 200, 'result': {'songs': songs}}, {}

    def _detail(self, req: dict[str, Any]) -> Reply:
        sid = int(req['query'].get('ids', '0'))
        if sid == 999:
            return 200, {'code': 200, 'songs': []}, {}
        return 200, {'code': 200, 'songs': [{'id': sid, 'name': f'Song {sid}', 'ar': [], 'al': {}, 'dt': 100000, 'fee': 0}]}, {}

    def _url(self, req: dict[str, Any]) -> Reply:
        return 200, {'code': 200, 'data': [{'id': 111, 'url': f'{self.base_url}/cdn/a.mp3', 'type': 'MP3', 'fee': 0}]}, {}

    def _lyric(self, req: dict[str, Any]) -> Reply:
        return 200, {'code': 200, 'lrc': {'lyric': '[00:01.00]hello\n[00:05.00]world'}}, {}

    def _playlist(self, req: dict[str, Any]) -> Reply:
        songs = [{'id': 111, 'name': 'One', 'ar': [], 'al': {}, 'dt': 100000, 'fee': 0}]
        return 200, {'code': 200, 'songs': songs}, {}
