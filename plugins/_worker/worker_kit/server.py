"""The worker's HTTP face: the routes of the Worker protocol, and the two the plugin contract asks for.

    GET  /health                 {ok, ready, service, config: {worker}}   (what the supervisor polls)
    POST /shutdown               ask the process to stop        (the supervisor's polite stop)
    GET  /worker/state           WorkerState
    GET  /worker/events?after=&epoch=&limit=
    GET  /worker/trace?limit=
    POST /worker/command {text}  409 while not in a game
    POST /worker/pause {paused}
    POST /worker/forget

Loopback only. A request whose Host header is not the loopback address it was made to is refused (a page on the internet
cannot reach a service on this machine through the user's browser by pointing a name at 127.0.0.1), and no CORS header is ever
sent, so no page can read an answer. Bodies are limited to 4 KiB.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from .state import EVENTS_PER_RESPONSE, MAX_COMMAND_CHARS, TRACE_SIZE, WorkerState

MAX_BODY = 4096


class _Refusal(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class WorkerServer:
    def __init__(
        self,
        state: WorkerState,
        port: int,
        *,
        service: str = "game",
        version: str = "0.1.0",
        health: Callable[[], tuple[bool, str]] | None = None,
        on_shutdown: Callable[[], None] | None = None,
    ):
        """`health()` says whether the worker is ready and, if not, why (a loading model, a missing setting)."""
        self.state = state
        self.service = service
        self.version = version
        self._health = health or (lambda: (True, ""))
        self._on_shutdown = on_shutdown
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "worker-kit"

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the base class's name
                return  # the supervisor keeps the process's own output; per-request lines are noise

            def _send(self, status: int, body: Any) -> None:
                payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(payload)

            def _host_ok(self) -> bool:
                host = (self.headers.get("Host") or "").strip().lower()
                return host in (f"127.0.0.1:{server_self.port}", f"localhost:{server_self.port}", f"[::1]:{server_self.port}")

            def _read_json(self) -> dict[str, Any]:
                try:
                    length = int(self.headers.get("Content-Length") or "0")
                except ValueError:
                    raise _Refusal(400, "bad_request", "Content-Length is not a number") from None
                if length > MAX_BODY:
                    raise _Refusal(413, "too_large", f"the body may be at most {MAX_BODY} bytes")
                raw = self.rfile.read(length) if length > 0 else b""
                if not raw:
                    return {}
                try:
                    data = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    raise _Refusal(400, "bad_request", "the body is not JSON") from None
                if not isinstance(data, dict):
                    raise _Refusal(400, "bad_request", "the body must be a JSON object")
                return data

            def _dispatch(self, method: str) -> None:
                try:
                    if not self._host_ok():
                        raise _Refusal(403, "forbidden_host", "this service answers on the loopback address only")
                    url = urlparse(self.path)
                    q = parse_qs(url.query)
                    status, body = server_self._route(method, url.path, q, self._read_json if method == "POST" else None)
                    self._send(status, body)
                except _Refusal as r:
                    self._send(r.status, {"ok": False, "code": r.code, "message": r.message})
                except Exception as e:  # noqa: BLE001 - a bug must not take the service down
                    self._send(500, {"ok": False, "code": "bad_request", "message": f"internal error: {type(e).__name__}"})

            def do_GET(self) -> None:  # noqa: N802 - the base class's names
                self._dispatch("GET")

            def do_POST(self) -> None:  # noqa: N802
                self._dispatch("POST")

        self._httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self._httpd.daemon_threads = True
        self.port = self._httpd.server_address[1]
        self._thread: threading.Thread | None = None

    # ── routes ───────────────────────────────────────────────────────────────

    def _route(
        self,
        method: str,
        path: str,
        q: dict[str, list[str]],
        read_json: Callable[[], dict[str, Any]] | None,
    ) -> tuple[int, Any]:
        st = self.state
        table = {
            ("GET", "/health"),
            ("POST", "/shutdown"),
            ("GET", "/worker/state"),
            ("GET", "/worker/events"),
            ("GET", "/worker/trace"),
            ("POST", "/worker/command"),
            ("POST", "/worker/pause"),
            ("POST", "/worker/forget"),
        }
        if (method, path) not in table:
            if any(p == path for _m, p in table):
                raise _Refusal(405, "not_found", f"{path} does not take {method}")
            raise _Refusal(404, "not_found", "no such route")
        if path == "/health":
            ready, why = self._health()
            body: dict[str, Any] = {"ok": True, "ready": bool(ready), "service": self.service, "version": self.version, "config": {"worker": st.worker}}
            if not ready and why:
                body["detail"] = why[:300]
            return 200, body
        if path == "/shutdown":
            threading.Thread(target=self._stop_soon, daemon=True).start()
            return 200, {"ok": True}
        if path == "/worker/state":
            return 200, st.snapshot()
        if path == "/worker/events":
            after = self._int(q, "after", 0, 0, 2**53)
            limit = self._int(q, "limit", EVENTS_PER_RESPONSE, 1, EVENTS_PER_RESPONSE)
            epoch = (q.get("epoch") or [None])[0]
            if epoch is not None and not (0 < len(epoch) <= 64):
                raise _Refusal(400, "bad_request", "epoch is not one")
            return 200, st.events_after(after, epoch, limit)
        if path == "/worker/trace":
            return 200, st.trace(self._int(q, "limit", 20, 1, TRACE_SIZE))
        body = (read_json or (lambda: {}))()
        if path == "/worker/command":
            text = body.get("text")
            if not isinstance(text, str) or not text.strip() or len(text.strip()) > MAX_COMMAND_CHARS:
                raise _Refusal(400, "bad_request", f"text must be 1-{MAX_COMMAND_CHARS} characters")
            if not st.online:
                raise _Refusal(409, "not_online", "the game is not connected")
            st.add_directive(text)
        elif path == "/worker/pause":
            paused = body.get("paused")
            if not isinstance(paused, bool):
                raise _Refusal(400, "bad_request", "paused must be true or false")
            st.set_paused(paused)
        elif path == "/worker/forget":
            st.forget()
        return 200, {"ok": True, "epoch": st.epoch, "paused": st.paused}

    @staticmethod
    def _int(q: dict[str, list[str]], name: str, default: int, low: int, high: int) -> int:
        raw = (q.get(name) or [None])[0]
        if raw is None or raw == "":
            return default
        try:
            n = int(raw)
        except ValueError:
            raise _Refusal(400, "bad_request", f"{name} must be a whole number") from None
        return max(low, min(high, n))

    # ── running ──────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Serve in a background thread and return."""
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="worker-http", daemon=True)
        self._thread.start()

    def serve_forever(self) -> None:
        self._httpd.serve_forever()

    def _stop_soon(self) -> None:
        if self._on_shutdown:
            try:
                self._on_shutdown()
            except Exception:  # noqa: BLE001
                pass
        self._httpd.shutdown()

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
