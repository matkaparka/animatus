"""The HTTP surface, over a real socket with a fake grabber."""

import http.client
import io
import json
import threading
import time
import unittest
from unittest import mock
from urllib.parse import quote, unquote

from PIL import Image

from fake_grabber import FakeGrabber, solid, window
from screencap import server as server_module
from screencap.errors import capture_failed, window_too_small
from screencap.server import make_server

LIT = (200, 120, 40)


class Served:
    """A running server and a way to call it."""

    def __init__(self, grabber):
        self.server = make_server(grabber, 0)
        # a short poll interval, or every shutdown waits half a second for the loop to notice
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True)
        self.thread.start()
        self.port = self.server.port

    def call(self, method, path, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest(method, path, skip_host=host is not None)
            if host is not None:
                conn.putheader("Host", host)
            for name, value in (headers or {}).items():
                conn.putheader(name, value)
            conn.endheaders()
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def json(self, method, path, **kw):
        status, headers, body = self.call(method, path, **kw)
        return status, headers, json.loads(body)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


class ServiceCase(unittest.TestCase):
    def serve(self, grabber) -> Served:
        served = Served(grabber)
        self.addCleanup(served.close)
        return served


class Health(ServiceCase):
    def test_healthy(self):
        status, _, body = self.serve(FakeGrabber()).json("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(
            (body["ok"], body["ready"], body["service"], body["config"]), (True, True, "screencap", {"grabber": "fake"})
        )

    def test_a_grabber_that_cannot_work_makes_health_a_503_that_says_why(self):
        status, _, body = self.serve(FakeGrabber(problem="there is no desktop")).json("GET", "/health")
        self.assertEqual(status, 503)
        self.assertEqual((body["ok"], body["ready"], body["detail"]), (False, False, "there is no desktop"))


class Windows(ServiceCase):
    def test_lists_the_windows_with_their_details(self):
        served = self.serve(
            FakeGrabber([window("10", "游戏 – Test", process="game.exe"), window("11", "Notes", overlay=True)])
        )
        status, _, body = served.json("GET", "/windows")
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["windows"][0]["title"], "游戏 – Test")
        self.assertEqual(body["windows"][0]["process"], "game.exe")
        self.assertEqual(body["windows"][1]["overlay"], True)

    def test_a_failing_listing_is_an_error_not_an_empty_list(self):
        class Broken(FakeGrabber):
            def list_windows(self):
                raise capture_failed("the window list could not be read")

        status, _, body = self.serve(Broken()).json("GET", "/windows")
        self.assertEqual((status, body["error"]["code"]), (500, "capture_failed"))


class Capture(ServiceCase):
    def grabber(self, image=None, **kw):
        return FakeGrabber(
            [window("42", "游戏 – Test 1.21", process="javaw.exe")], {("42", None): image or solid(LIT, (1600, 900))}, **kw
        )

    def test_returns_the_jpeg_and_says_which_window_and_how_it_went(self):
        served = self.serve(self.grabber())
        query = "/capture?window=" + quote("游戏") + "&max_width=800&quality=70"
        status, headers, body = served.call("GET", query)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertEqual(headers["Cache-Control"], "no-store")
        image = Image.open(io.BytesIO(body))
        self.assertEqual((image.format, image.size), ("JPEG", (800, 450)))
        self.assertEqual(headers["X-Window-Id"], "42")
        self.assertEqual(unquote(headers["X-Window-Title"]), "游戏 – Test 1.21")
        self.assertEqual(unquote(headers["X-Window-Process"]), "javaw.exe")
        self.assertEqual((headers["X-Source-Width"], headers["X-Source-Height"]), ("1600", "900"))
        self.assertEqual((headers["X-Image-Width"], headers["X-Image-Height"]), ("800", "450"))
        self.assertEqual((headers["X-Black"], headers["X-Method"]), ("false", "printwindow"))
        self.assertGreater(float(headers["X-Brightness"]), 50)
        self.assertGreaterEqual(int(headers["X-Elapsed-Ms"]), 0)
        self.assertEqual(int(headers["Content-Length"]), len(body))

    def test_the_defaults_are_768_wide_at_quality_80_with_method_auto(self):
        status, headers, body = self.serve(self.grabber()).call("GET", "/capture?window=42")
        self.assertEqual(status, 200)
        self.assertEqual(Image.open(io.BytesIO(body)).size, (768, 432))

    def test_a_black_window_is_still_a_picture_but_says_so(self):
        served = self.serve(self.grabber(solid((0, 0, 0))))
        status, headers, body = served.call("GET", "/capture?window=42")
        self.assertEqual((status, headers["X-Black"]), (200, "true"))
        self.assertEqual(Image.open(io.BytesIO(body)).format, "JPEG")

    def test_the_black_threshold_and_the_method_are_passed_on(self):
        fake = self.grabber(solid((30, 30, 30)))
        served = self.serve(fake)
        _, headers, _ = served.call("GET", "/capture?window=42&method=screen&black_threshold=40")
        self.assertEqual((headers["X-Black"], headers["X-Method"]), ("true", "screen"))
        self.assertEqual(fake.grabs, [("42", "screen")])

    def test_errors_of_the_window_are_json_with_the_right_status(self):
        cases = [
            ("/capture?window=nothing", 404, "window_not_found", True),
            ("/capture?window=42", 422, "window_too_small", True),
        ]
        served = self.serve(self.grabber(window_too_small(3, 3)))
        for path, status, code, retryable in cases:
            with self.subTest(path=path):
                got, headers, body = served.json("GET", path)
                self.assertEqual((got, body["error"]["code"], body["error"]["retryable"]), (status, code, retryable))
                self.assertIn("application/json", headers["Content-Type"])
                self.assertTrue(body["error"]["message"])

    def test_a_minimised_window(self):
        served = self.serve(FakeGrabber([window("42", "Game", minimized=True, size=(0, 0))]))
        status, _, body = served.json("GET", "/capture?window=game")
        self.assertEqual((status, body["error"]["code"]), (409, "window_minimized"))

    def test_bad_parameters_are_400s_that_name_the_parameter(self):
        served = self.serve(self.grabber())
        cases = {
            "/capture": "window is required",
            "/capture?window=": "window is required",
            "/capture?window=42&max_width=10": "max_width",
            "/capture?window=42&max_width=99999": "max_width",
            "/capture?window=42&max_width=wide": "max_width",
            "/capture?window=42&quality=0": "quality",
            "/capture?window=42&quality=100": "quality",
            "/capture?window=42&black_threshold=-1": "black_threshold",
            "/capture?window=42&black_threshold=nan": "black_threshold",
            "/capture?window=42&method=magic": "method",
            "/capture?window=42&maxwidth=500": "unknown parameter",
            "/capture?window=42&window=43": "window was given 2 times",
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                status, _, body = served.json("GET", path)
                self.assertEqual((status, body["error"]["code"]), (400, "bad_request"))
                self.assertIn(expected, body["error"]["message"])

    def test_zero_width_keeps_the_size(self):
        _, _, body = self.serve(self.grabber()).call("GET", "/capture?window=42&max_width=0")
        self.assertEqual(Image.open(io.BytesIO(body)).size, (1600, 900))

    def test_an_unexpected_exception_is_an_error_answer_never_a_200_or_a_dropped_connection(self):
        served = self.serve(self.grabber(RuntimeError("boom")))  # not a CaptureError
        with mock.patch("sys.stderr", new_callable=io.StringIO):
            status, _, body = served.json("GET", "/capture?window=42")
        self.assertEqual((status, body["error"]["code"]), (500, "capture_failed"))
        self.assertIn("boom", body["error"]["message"])

    def test_two_captures_at_once_are_done_one_after_the_other(self):
        active = {"now": 0, "max": 0}
        lock = threading.Lock()

        class Slow(FakeGrabber):
            def grab(self, window_id, method):
                with lock:
                    active["now"] += 1
                    active["max"] = max(active["max"], active["now"])
                time.sleep(0.15)
                with lock:
                    active["now"] -= 1
                return solid(LIT)

        served = self.serve(Slow([window("42", "Game")]))
        results = []
        threads = [
            threading.Thread(target=lambda: results.append(served.call("GET", "/capture?window=42")[0]))
            for _ in range(3)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(results, [200, 200, 200])
        self.assertEqual(active["max"], 1)

    def test_a_capture_that_never_finishes_does_not_block_the_next_one_forever(self):
        release = threading.Event()
        self.addCleanup(release.set)

        class Stuck(FakeGrabber):
            def grab(self, window_id, method):
                release.wait(10)
                return solid(LIT)

        served = self.serve(Stuck([window("42", "Game")]))
        first = threading.Thread(target=lambda: served.call("GET", "/capture?window=42"), daemon=True)
        first.start()
        time.sleep(0.2)
        with mock.patch.object(server_module, "LOCK_WAIT_SECONDS", 0.2):
            status, _, body = served.json("GET", "/capture?window=42")
        self.assertEqual((status, body["error"]["code"], body["error"]["retryable"]), (503, "busy", True))
        release.set()
        first.join(5)


class Callers(ServiceCase):
    def test_binds_to_loopback_only_and_does_not_share_the_port(self):
        served = self.serve(FakeGrabber())
        self.assertEqual(served.server.server_address[0], "127.0.0.1")
        self.assertFalse(server_module.ScreencapServer.allow_reuse_address)

    def test_localhost_is_accepted_as_the_host_name(self):
        served = self.serve(FakeGrabber())
        status, _, _ = served.call("GET", "/health", host=f"localhost:{served.port}")
        self.assertEqual(status, 200)

    def test_another_host_name_is_refused_even_on_the_right_address(self):
        served = self.serve(FakeGrabber())
        for host in ("evil.example", f"evil.example:{served.port}", f"127.0.0.1:{served.port + 1}", ""):
            with self.subTest(host=host):
                status, _, body = served.json("GET", "/windows", host=host)
                self.assertEqual((status, body["error"]["code"]), (403, "forbidden_host"))

    def test_a_request_from_a_web_page_is_refused(self):
        served = self.serve(FakeGrabber([window("1", "Game")], {("1", None): solid(LIT)}))
        for path in ("/health", "/windows", "/capture?window=1"):
            with self.subTest(path=path):
                status, _, body = served.json("GET", path, headers={"Origin": "http://evil.example"})
                self.assertEqual((status, body["error"]["code"]), (403, "forbidden_origin"))
        status, _, _ = served.call("POST", "/shutdown", headers={"Origin": "null"})
        self.assertEqual(status, 403)

    def test_unknown_paths_and_wrong_methods_are_json_errors(self):
        served = self.serve(FakeGrabber())
        status, _, body = served.json("GET", "/nothing")
        self.assertEqual((status, body["error"]["code"]), (404, "not_found"))
        status, headers, body = served.json("POST", "/capture?window=1")
        self.assertEqual((status, body["error"]["code"], headers["Allow"]), (405, "method_not_allowed", "GET"))
        status, headers, _ = served.json("GET", "/shutdown")
        self.assertEqual((status, headers["Allow"]), (405, "POST"))
        for method in ("PUT", "DELETE", "PATCH", "OPTIONS"):
            with self.subTest(method=method):
                self.assertEqual(served.call(method, "/capture?window=1")[0], 405)
        self.assertEqual(served.call("HEAD", "/health")[0], 405)  # no body, but the status still says no


class Shutdown(unittest.TestCase):
    def test_a_shutdown_request_stops_the_server(self):
        served = Served(FakeGrabber())
        self.addCleanup(served.server.server_close)
        status, _, body = served.json("POST", "/shutdown")
        self.assertEqual((status, body), (200, {"ok": True}))
        served.thread.join(5)
        self.assertFalse(served.thread.is_alive())


if __name__ == "__main__":
    unittest.main()
