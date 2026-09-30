"""The HTTP surface: GET /health, GET /windows, GET /capture, POST /shutdown.

Only loopback callers get an answer, and only callers that are not web pages: the Host header must name this
address (a page reaching the port through a rebound DNS name cannot pass) and a request that carries an Origin header
(every request a browser makes on behalf of a page) is refused. What this service returns is a picture of the
operator's screen.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

from . import SERVICE_NAME, VERSION
from .errors import CaptureError, bad_request, capture_failed
from .grabber import METHODS, Grabber, capture

DEFAULT_MAX_WIDTH = 768
DEFAULT_QUALITY = 80
DEFAULT_BLACK_THRESHOLD = 10.0
MAX_WIDTH = 4096
MIN_WIDTH = 64
# How long a capture waits for the one before it. A window that never answers would otherwise block every later one.
LOCK_WAIT_SECONDS = 10


@dataclass(frozen=True)
class CaptureParams:
    window: str
    max_width: int
    quality: int
    black_threshold: float
    method: str


def _single(query: dict[str, list[str]], name: str) -> str | None:
    values = query.get(name)
    if values is None:
        return None
    if len(values) != 1:
        raise bad_request(f"{name} was given {len(values)} times")
    return values[0]


def _number(text: str, name: str, cast):
    try:
        return cast(text)
    except ValueError:
        raise bad_request(f"{name} must be a number, got {text[:40]!r}") from None


def parse_capture_params(query: dict[str, list[str]]) -> CaptureParams:
    known = {"window", "max_width", "quality", "black_threshold", "method"}
    for name in query:
        if name not in known:
            raise bad_request(f"unknown parameter {name[:40]!r} (known: {', '.join(sorted(known))})")
    window = _single(query, "window")
    if window is None or not window.strip():
        raise bad_request("window is required: a window id, part of its title, or exe:<program>")

    width_text = _single(query, "max_width")
    max_width = DEFAULT_MAX_WIDTH if width_text is None else _number(width_text, "max_width", int)
    if max_width != 0 and not MIN_WIDTH <= max_width <= MAX_WIDTH:
        raise bad_request(f"max_width must be 0 (keep the size) or between {MIN_WIDTH} and {MAX_WIDTH}")

    quality_text = _single(query, "quality")
    quality = DEFAULT_QUALITY if quality_text is None else _number(quality_text, "quality", int)
    if not 1 <= quality <= 95:
        raise bad_request("quality must be between 1 and 95")

    threshold_text = _single(query, "black_threshold")
    threshold = DEFAULT_BLACK_THRESHOLD if threshold_text is None else _number(threshold_text, "black_threshold", float)
    if not 0 <= threshold <= 255:  # also false for nan
        raise bad_request("black_threshold must be between 0 and 255")

    method = _single(query, "method") or "auto"
    if method not in METHODS:
        raise bad_request(f"method must be one of {', '.join(METHODS)}")
    return CaptureParams(window, max_width, quality, threshold, method)


class ScreencapServer(ThreadingHTTPServer):
    daemon_threads = True
    # HTTPServer turns SO_REUSEADDR on; on Windows that lets a second process bind the same port.
    allow_reuse_address = False

    def __init__(self, address, grabber: Grabber):
        super().__init__(address, Handler)
        self.grabber = grabber
        self.capture_lock = threading.Lock()

    @property
    def port(self) -> int:
        return self.server_address[1]


def make_server(grabber: Grabber, port: int = 0) -> ScreencapServer:
    """A server bound to 127.0.0.1 (never any other address); port 0 picks a free one."""
    return ScreencapServer(("127.0.0.1", port), grabber)


class Handler(BaseHTTPRequestHandler):
    server: ScreencapServer
    server_version = f"{SERVICE_NAME}/{VERSION}"
    protocol_version = "HTTP/1.0"  # one request per connection

    def log_message(self, format, *args):  # noqa: A002 - the name comes from the base class
        pass  # a request line carries the title of a window, and nothing here needs a log line per request

    # ─────────────────────────────── plumbing ───────────────────────────────

    def _handle(self):
        self._dispatch(self.command)

    do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _handle

    def _dispatch(self, method: str) -> None:
        allow = None
        try:
            self._check_caller()
            url = urlsplit(self.path)
            routes = {
                "/health": ("GET", self._health),
                "/windows": ("GET", self._windows),
                "/capture": ("GET", self._capture),
                "/shutdown": ("POST", self._shutdown),
            }
            route = routes.get(url.path)
            if route is None:
                raise CaptureError("not_found", f"no such path: {url.path[:80]}", 404)
            allow, handler = route
            if method != allow:
                raise CaptureError("method_not_allowed", f"{url.path} answers {allow} only", 405)
            handler(parse_qs(url.query, keep_blank_values=True))
        except CaptureError as e:
            self._send_error(e, allow)
        except Exception as e:  # noqa: BLE001 - whatever it is, the caller gets an error, never silence or a 200
            traceback.print_exc(file=sys.stderr)
            self._send_error(capture_failed(f"unexpected failure: {type(e).__name__}: {e}"))

    def _check_caller(self) -> None:
        port = self.server.port
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"):
            raise CaptureError("forbidden_host", "this service answers only on its own loopback address", 403)
        if self.headers.get("Origin") is not None:
            raise CaptureError("forbidden_origin", "this service does not answer web pages", 403)

    def _send(self, status: int, body: bytes, content_type: str, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, body: dict) -> None:
        self._send(status, json.dumps(body).encode("utf-8"), "application/json; charset=utf-8")

    def _send_error(self, error: CaptureError, allow: str | None = None) -> None:
        headers = {"Allow": allow} if error.status == 405 and allow else None
        self._send(error.status, json.dumps(error.body()).encode("utf-8"), "application/json; charset=utf-8", headers)

    # ─────────────────────────────── routes ───────────────────────────────

    def _health(self, _query) -> None:
        grabber = self.server.grabber
        problem = grabber.check()
        config = {"grabber": grabber.name}
        dpi = getattr(grabber, "dpi", None)
        if dpi:
            config["dpi"] = dpi
        body: dict = {
            "ok": problem is None,
            "ready": problem is None,
            "service": SERVICE_NAME,
            "version": VERSION,
            "config": config,
        }
        if problem is not None:
            body["detail"] = problem
        self._send_json(200 if problem is None else 503, body)

    def _windows(self, _query) -> None:
        windows = self.server.grabber.list_windows()
        self._send_json(200, {"windows": [w.public() for w in windows], "count": len(windows)})

    def _capture(self, query) -> None:
        params = parse_capture_params(query)
        lock = self.server.capture_lock
        if not lock.acquire(timeout=LOCK_WAIT_SECONDS):
            raise CaptureError("busy", "the capture before this one has not finished", 503, True)
        try:
            started = time.monotonic()
            result = capture(
                self.server.grabber,
                params.window,
                max_width=params.max_width,
                quality=params.quality,
                black_threshold=params.black_threshold,
                method=params.method,
            )
            elapsed_ms = round((time.monotonic() - started) * 1000)
        finally:
            lock.release()
        frame, window = result.frame, result.window
        # Header values are latin-1 at best; titles are anything, so they travel percent-encoded (UTF-8).
        headers = {
            "X-Window-Id": window.id,
            "X-Window-Title": quote(window.title, safe=""),
            "X-Window-Process": quote(window.process, safe=""),
            "X-Source-Width": str(frame.source_width),
            "X-Source-Height": str(frame.source_height),
            "X-Image-Width": str(frame.width),
            "X-Image-Height": str(frame.height),
            "X-Black": "true" if frame.black else "false",
            "X-Brightness": f"{frame.brightness:.2f}",
            "X-Peak": str(frame.peak),
            "X-Method": result.method,
            "X-Elapsed-Ms": str(elapsed_ms),
        }
        self._send(200, frame.jpeg, "image/jpeg", headers)

    def _shutdown(self, _query) -> None:
        self._send_json(200, {"ok": True})
        threading.Thread(target=self.server.shutdown, daemon=True).start()
