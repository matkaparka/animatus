"""Tests of the worker kit: the state's rules, and the HTTP routes against a real server on a free port.

    python -m unittest discover -s plugins/_worker -p "test_*.py"
"""

from __future__ import annotations

import http.client
import json
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from worker_kit import EVENTS_PER_RESPONSE, MAX_COMMAND_CHARS, WorkerServer, WorkerState  # noqa: E402


class StateTests(unittest.TestCase):
    def test_a_worker_starts_paused_and_offline_with_a_fresh_epoch(self):
        a, b = WorkerState("mygame"), WorkerState("mygame")
        self.assertTrue(a.paused)
        self.assertFalse(a.online)
        self.assertNotEqual(a.epoch, b.epoch)
        self.assertRegex(a.epoch, r"^w-[0-9a-f]{16}$")
        snap = a.snapshot()
        self.assertEqual(snap["protocol"], 1)
        self.assertEqual(snap["latest_seq"], 0)
        self.assertEqual(snap["planner"], {"thinking": False, "executing": None, "pending": 0, "given_up": False})

    def test_the_worker_id_is_checked(self):
        for bad in ("", "Civ6", "6civ", "a b", "a/b", "x" * 0):
            with self.assertRaises(ValueError, msg=bad):
                WorkerState(bad)
        WorkerState("mine-craft_2")

    def test_events_are_numbered_from_one_and_come_back_in_order_in_pages(self):
        s = WorkerState("g")
        for i in range(120):
            s.push("n", f"e{i}")
        first = s.events_after(0, s.epoch)
        self.assertEqual([e["seq"] for e in first["events"]], list(range(1, EVENTS_PER_RESPONSE + 1)))
        self.assertTrue(first["more"])
        self.assertFalse(first["reset"])
        rest = s.events_after(EVENTS_PER_RESPONSE, s.epoch)
        self.assertEqual(rest["events"][0]["seq"], EVENTS_PER_RESPONSE + 1)
        last = s.events_after(100, s.epoch)
        self.assertEqual([e["seq"] for e in last["events"]], list(range(101, 121)))
        self.assertFalse(last["more"])
        self.assertEqual(last["latest"], 120)
        self.assertEqual(s.events_after(120, s.epoch)["events"], [])

    def test_another_epoch_means_start_over_and_so_does_no_epoch_from_the_middle(self):
        s = WorkerState("g")
        for i in range(5):
            s.push("n", f"e{i}")
        stale = s.events_after(200, "w-of-an-earlier-run")
        self.assertTrue(stale["reset"])
        self.assertEqual([e["seq"] for e in stale["events"]], [1, 2, 3, 4, 5])
        middle = s.events_after(3, None)
        self.assertTrue(middle["reset"])
        beginning = s.events_after(0, None)
        self.assertFalse(beginning["reset"])

    def test_the_ring_keeps_the_newest_and_the_numbers_keep_counting(self):
        s = WorkerState("g", ring=10)
        for i in range(25):
            s.push("n", f"e{i}")
        got = s.events_after(0, s.epoch)
        self.assertEqual([e["seq"] for e in got["events"]], list(range(16, 26)))
        self.assertEqual(got["latest"], 25)

    def test_an_event_that_is_too_long_is_cut_and_a_bad_urgency_is_refused(self):
        s = WorkerState("g")
        s.push("k" * 100, "t" * 1000)
        e = s.events_after(0, s.epoch)["events"][0]
        self.assertLessEqual(len(e["kind"]), 40)
        self.assertLessEqual(len(e["text"]), 600)
        with self.assertRaises(ValueError):
            s.push("n", "x", "whenever")  # type: ignore[arg-type]

    def test_a_directive_is_a_standing_order_and_a_fresh_one_for_the_agent_exactly_once(self):
        s = WorkerState("g")
        for text in ("one", "two", "three", "four"):
            s.add_directive(text)
        self.assertEqual(s.directives, ["two", "three", "four"])  # the newest three stand
        self.assertEqual(s.pending, 4)
        self.assertEqual(s.take_directives(), ["one", "two", "three", "four"])
        self.assertEqual(s.take_directives(), [])
        self.assertEqual(s.snapshot()["last_command"]["text"], "four")
        self.assertEqual(s.events_after(0, s.epoch)["events"][-1]["kind"], "command")

    def test_forget_drops_what_it_carries_and_nothing_else(self):
        s = WorkerState("g")
        s.set_paused(False)
        s.push("n", "a")
        s.add_directive("go north")
        epoch, latest = s.epoch, s.latest_seq
        s.forget()
        self.assertEqual(s.directives, [])
        self.assertEqual(s.take_directives(), [])
        self.assertIsNone(s.snapshot()["last_command"])
        self.assertTrue(s.forget_requested)
        self.assertEqual((s.epoch, s.latest_seq, s.paused), (epoch, latest, False))

    def test_wait_resumed_blocks_while_paused_and_returns_at_once_when_running(self):
        s = WorkerState("g")
        self.assertFalse(s.wait_resumed(0.05))
        threading.Timer(0.05, lambda: s.set_paused(False)).start()
        self.assertTrue(s.wait_resumed(2))
        s.set_paused(True)
        self.assertFalse(s.wait_resumed(0.02))

    def test_facts_are_limited(self):
        s = WorkerState("g")
        s.set_facts(turn=3, name="Rome")
        self.assertEqual(s.snapshot()["facts"], {"turn": 3, "name": "Rome"})
        with self.assertRaises(ValueError):
            s.set_facts(**{f"k{i}": i for i in range(40)})

    def test_several_threads_pushing_lose_nothing_and_repeat_nothing(self):
        s = WorkerState("g", ring=10_000)

        def work():
            for _ in range(500):
                s.push("n", "x")

        threads = [threading.Thread(target=work) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        seqs = []
        after = 0
        while True:
            page = s.events_after(after, s.epoch)
            seqs += [e["seq"] for e in page["events"]]
            if not page["more"]:
                break
            after = seqs[-1]
        self.assertEqual(seqs, list(range(1, 3001)))


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.state = WorkerState("mygame")
        self.stopped = threading.Event()
        self.server = WorkerServer(self.state, 0, on_shutdown=self.stopped.set)
        self.server.start()
        self.addCleanup(self.server.shutdown)

    def call(self, method: str, path: str, body=None, headers=None, raw: bytes | None = None):
        c = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=5)
        try:
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            h = {"Content-Type": "application/json", **(headers or {})}
            c.request(method, path, body=data, headers=h)
            r = c.getresponse()
            text = r.read().decode("utf-8")
            return r.status, (json.loads(text) if text else None), r
        finally:
            c.close()

    def test_health_is_the_plugin_contract(self):
        status, body, _ = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True, "ready": True, "service": "game", "version": "0.1.0", "config": {"worker": "mygame"}})

    def test_health_can_say_it_is_not_ready_and_why(self):
        state = WorkerState("mygame")
        server = WorkerServer(state, 0, health=lambda: (False, "the model is still loading"))
        server.start()
        self.addCleanup(server.shutdown)
        c = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
        c.request("GET", "/health")
        body = json.loads(c.getresponse().read())
        c.close()
        self.assertEqual((body["ok"], body["ready"], body["detail"]), (True, False, "the model is still loading"))

    def test_state_is_the_snapshot(self):
        self.state.set_online(True)
        self.state.summary = "turn 4"
        status, body, _ = self.call("GET", "/worker/state")
        self.assertEqual(status, 200)
        self.assertEqual(body, self.state.snapshot())
        self.assertTrue(body["paused"])

    def test_events_pages_reset_and_bad_numbers(self):
        for i in range(70):
            self.state.push("n", f"e{i}")
        status, body, _ = self.call("GET", f"/worker/events?after=0&epoch={self.state.epoch}")
        self.assertEqual((status, len(body["events"]), body["more"], body["reset"]), (200, 50, True, False))
        status, body, _ = self.call("GET", "/worker/events?after=50&epoch=w-elsewhere")
        self.assertEqual((status, body["reset"], body["events"][0]["seq"]), (200, True, 1))
        status, body, _ = self.call("GET", "/worker/events?after=abc")
        self.assertEqual((status, body["code"]), (400, "bad_request"))
        status, body, _ = self.call("GET", f"/worker/events?after=0&limit=2&epoch={self.state.epoch}")
        self.assertEqual(len(body["events"]), 2)

    def test_command_needs_a_game_and_a_sensible_text(self):
        status, body, _ = self.call("POST", "/worker/command", {"text": "go"})
        self.assertEqual((status, body["code"]), (409, "not_online"))
        self.state.set_online(True)
        status, body, _ = self.call("POST", "/worker/command", {"text": "  build a house  "})
        self.assertEqual((status, body["ok"], body["paused"]), (200, True, True))
        self.assertEqual(self.state.take_directives(), ["build a house"])
        for bad in ({"text": ""}, {"text": "   "}, {"text": "x" * (MAX_COMMAND_CHARS + 1)}, {"text": 5}, {}):
            status, body, _ = self.call("POST", "/worker/command", bad)
            self.assertEqual((status, body["code"]), (400, "bad_request"), bad)

    def test_pause_and_resume_and_forget(self):
        status, body, _ = self.call("POST", "/worker/pause", {"paused": False})
        self.assertEqual((status, body["paused"]), (200, False))
        self.assertFalse(self.state.paused)
        status, body, _ = self.call("POST", "/worker/pause", {"paused": True})
        self.assertEqual(body["paused"], True)
        status, body, _ = self.call("POST", "/worker/pause", {"paused": "yes"})
        self.assertEqual((status, body["code"]), (400, "bad_request"))
        status, body, _ = self.call("POST", "/worker/pause", {})
        self.assertEqual(status, 400)
        self.state.set_online(True)
        self.state.add_directive("x")
        status, body, _ = self.call("POST", "/worker/forget")
        self.assertEqual((status, body["ok"], body["epoch"]), (200, True, self.state.epoch))
        self.assertEqual(self.state.directives, [])

    def test_the_trace(self):
        for i in range(5):
            self.state.add_trace({"step": i})
        status, body, _ = self.call("GET", "/worker/trace?limit=2")
        self.assertEqual((status, body), (200, [{"step": 3}, {"step": 4}]))

    def test_a_host_that_is_not_the_loopback_address_is_refused_and_no_cors_header_is_sent(self):
        for host in ("evil.example", f"evil.example:{self.server.port}", "127.0.0.1", f"127.0.0.1.evil.example:{self.server.port}"):
            status, body, _ = self.call("GET", "/worker/state", headers={"Host": host})
            self.assertEqual((status, body["code"]), (403, "forbidden_host"), host)
        status, _, response = self.call("GET", "/worker/state", headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 200)
        self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
        status, _, _ = self.call("GET", "/worker/state", headers={"Host": f"localhost:{self.server.port}"})
        self.assertEqual(status, 200)

    def test_bodies_are_limited_and_must_be_json_objects(self):
        status, body, _ = self.call("POST", "/worker/command", raw=b"x" * 5000)
        self.assertEqual((status, body["code"]), (413, "too_large"))
        status, body, _ = self.call("POST", "/worker/command", raw=b"{not json")
        self.assertEqual((status, body["code"]), (400, "bad_request"))
        status, body, _ = self.call("POST", "/worker/command", raw=b"[1,2]")
        self.assertEqual((status, body["code"]), (400, "bad_request"))

    def test_unknown_routes_and_wrong_methods(self):
        self.assertEqual(self.call("GET", "/nothing")[0], 404)
        self.assertEqual(self.call("POST", "/worker/state", {})[0], 405)
        self.assertEqual(self.call("GET", "/worker/command")[0], 405)

    def test_shutdown_stops_the_server(self):
        status, body, _ = self.call("POST", "/shutdown", {})
        self.assertEqual((status, body), (200, {"ok": True}))
        self.assertTrue(self.stopped.wait(3))


if __name__ == "__main__":
    unittest.main()
