"""The service's HTTP face (the contract is documented in docs/mode-sing.md).

JSON in and out on 127.0.0.1. A request that is answered (queued, refused for a reason, nothing to do) is HTTP 200
with a body that says which; a failure of real work (the song source cannot answer, a bug) is a non-2xx status with
`{"error": {"code", "message", "retryable"}}`, never a 200 with an empty or misleading body. `message` is what may be
told to a viewer: it never carries a path, an address or a tool's output.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .errors import SingingError, SourceUnavailable
from .service import OUTCOMES, SingingService

MAX_BODY = 64 * 1024
#: A refused body that is still being sent is read and dropped up to this much, for at most this long (see `_drain`).
MAX_DRAIN = 1 << 20
DRAIN_TIMEOUT_SEC = 2.0
log = logging.getLogger('singing.api')


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.retryable = status, code, message, retryable


def _bad(message: str) -> ApiError:
    return ApiError(400, 'bad_request', message)


def _text(body: dict[str, Any], key: str, *, required: bool = False, limit: int = 200) -> str:
    value = body.get(key)
    if value is None or value == '':
        if required:
            raise _bad(f'"{key}" is required')
        return ''
    if not isinstance(value, str):
        raise _bad(f'"{key}" must be text')
    return value[:limit]


def _identity(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if value is None:
        return ''
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise _bad(f'"{key}" must be text or a number')
    return str(value)[:100]


def _integer(body: dict[str, Any], key: str, *, required: bool = False, minimum: int | None = None) -> int | None:
    value = body.get(key)
    if value is None:
        if required:
            raise _bad(f'"{key}" is required')
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise _bad(f'"{key}" must be a whole number')
    if minimum is not None and value < minimum:
        raise _bad(f'"{key}" must be at least {minimum}')
    return value


class Api:
    """What each route does, in terms of the service. Also the place where errors become HTTP answers."""

    def __init__(self, service: SingingService | None, startup_error: str, stop: Callable[[], None]) -> None:
        self.service = service
        self.startup_error = startup_error
        self.stop = stop

    def _svc(self) -> SingingService:
        if self.service is None:
            raise ApiError(503, 'not_configured', 'the singing service is not set up', False)
        return self.service

    def health(self) -> tuple[int, dict[str, Any]]:
        if self.service is None:
            return 503, {'ok': False, 'ready': False, 'service': 'singing', 'detail': self.startup_error[:190]}
        body = self.service.health()
        return (200 if body['ok'] else 503), body

    def route(self, method: str, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        try:
            return self._route(method, path, body)
        except ApiError as error:
            return error.status, self._error(error.code, error.message, error.retryable)
        except SourceUnavailable as error:
            log.warning('the song source could not answer (%s): %s', error.code, error.reason)
            return 503, self._error(error.code, self._svc()._viewer_text(error), True)
        except SingingError as error:
            log.warning('%s: %s', error.code, error.reason)
            return 500, self._error(error.code, self._svc()._viewer_text(error), error.retryable)
        except ValueError as error:
            return 400, self._error('bad_request', str(error)[:200], False)
        except Exception:  # noqa: BLE001 - whatever it is, the caller gets an answer and the log gets the detail
            log.exception('%s %s failed', method, path)
            return 500, self._error('internal', 'the singing service hit an internal error', False)

    @staticmethod
    def _error(code: str, message: str, retryable: bool) -> dict[str, Any]:
        return {'error': {'code': code[:64], 'message': message[:1000], 'retryable': retryable}}

    def _route(self, method: str, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if (method, path) == ('GET', '/health'):
            return self.health()
        if (method, path) == ('POST', '/shutdown'):
            threading.Thread(target=self.stop, daemon=True).start()
            return 200, {'ok': True}
        svc = self._svc()
        if (method, path) == ('GET', '/queue'):
            return 200, svc.queue()
        if method != 'POST':
            raise ApiError(404, 'not_found', 'no such path')
        if path == '/request':
            wait = body.get('wait_s')
            if wait is not None and (isinstance(wait, bool) or not isinstance(wait, (int, float)) or not 0.1 <= wait <= 120):
                raise _bad('"wait_s" must be a number from 0.1 to 120')
            return 200, svc.request(
                _text(body, 'keyword', limit=400),
                _identity(body, 'requester_uid'),
                _text(body, 'requester_name', limit=100),
                request_id=_text(body, 'request_id', limit=96) or None,
                wait_s=float(wait) if wait is not None else None,
            )
        if path == '/abandon':
            return 200, svc.abandon(_text(body, 'request_id', required=True, limit=96))
        if path == '/claim':
            return 200, svc.claim(_text(body, 'claim_id', required=True, limit=96))
        if path == '/done':
            outcome = _text(body, 'outcome', required=True, limit=20)
            if outcome not in OUTCOMES:
                raise _bad(f'"outcome" must be one of {", ".join(OUTCOMES)}')
            return 200, svc.done(_integer(body, 'qid'), outcome, _text(body, 'reason', limit=500))
        if path == '/skip':
            return 200, svc.skip()
        if path == '/remove':
            return 200, svc.remove(_integer(body, 'qid', required=True) or 0)
        if path == '/cancel':
            position = _integer(body, 'position', minimum=1)
            uid = _identity(body, 'requester_uid')
            if position is None and not uid:
                raise _bad('"requester_uid" or "position" is required')
            return 200, svc.cancel(uid or None, position)
        if path == '/source/resume':
            return 200, svc.resume_source()
        raise ApiError(404, 'not_found', 'no such path')


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind a port that is being listened on: do not ask for it there.
    allow_reuse_address = os.name != 'nt'


def _handler(api: Api) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        #: What the caller of a refused request has declared and not yet sent (see `_drain`).
        _unread = 0

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the base class's name
            log.debug('%s %s', self.address_string(), format % args)

        def _answer(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
            try:
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionError):
                pass  # the caller went away; whatever was decided stays decided

        def _read_body(self) -> dict[str, Any]:
            self._unread = 0
            length = self.headers.get('Content-Length')
            if not length:
                return {}
            # isascii(): a header is read as Latin-1, where a superscript two passes isdigit() but int() refuses it
            if not (length.isascii() and length.isdigit()):
                raise _bad('Content-Length is not a number')
            if int(length) > MAX_BODY:
                self._unread = int(length)
                raise ApiError(413, 'too_large', f'the body may be at most {MAX_BODY} bytes')
            raw = self.rfile.read(int(length))
            try:
                body = json.loads(raw.decode('utf-8')) if raw.strip() else {}
            except (ValueError, UnicodeDecodeError):
                raise _bad('the body is not JSON') from None
            if not isinstance(body, dict):
                raise _bad('the body must be a JSON object')
            return body

        def _drain(self) -> None:
            """Reads and drops the body of a refused request that the caller is still sending. Closing a connection that
            has unread input resets it, and on Windows the reset can destroy the answer before the caller has read it: it
            saw a broken connection instead of the 413. Bounded in size and in time; a caller that declares more than
            MAX_DRAIN gets the reset it asked for."""
            remaining, self._unread = self._unread, 0
            if not 0 < remaining <= MAX_DRAIN:
                return
            try:
                self.connection.settimeout(DRAIN_TIMEOUT_SEC)
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 1 << 16))
                    if not chunk:
                        return
                    remaining -= len(chunk)
            except OSError:
                return

        def _handle(self, method: str) -> None:
            path = self.path.split('?', 1)[0]
            try:
                body = self._read_body() if method == 'POST' else {}
            except ApiError as error:
                self.close_connection = True
                self._answer(error.status, api._error(error.code, error.message, error.retryable))
                self._drain()  # after the answer: it is already on its way while the rest is being read
                return
            status, payload = api.route(method, path, body)
            self._answer(status, payload)

        def do_GET(self) -> None:  # noqa: N802 - http.server's names
            self._handle('GET')

        def do_POST(self) -> None:  # noqa: N802
            self._handle('POST')

    return Handler


class ApiServer:
    """The service on a loopback port. `serve()` blocks until `stop()` (or a `POST /shutdown`)."""

    def __init__(
        self,
        service: SingingService | None,
        port: int = 0,
        startup_error: str = '',
    ) -> None:
        self._stopped = threading.Event()
        self.api = Api(service, startup_error, self.stop)
        self.httpd = _Server(('127.0.0.1', port), _handler(self.api))

    @property
    def port(self) -> int:
        return int(self.httpd.server_address[1])

    def serve(self) -> None:
        self.httpd.serve_forever(poll_interval=0.1)

    def stop(self) -> None:
        if not self._stopped.is_set():
            self._stopped.set()
            self.httpd.shutdown()

    def close(self) -> None:
        self.httpd.server_close()
