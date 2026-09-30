"""Tests of the demo worker's loop.

    python -m unittest discover -s plugins/game-demo -p "test_*.py"
"""

from __future__ import annotations

import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_worker"))

from service import MILESTONE_EVERY, DemoGame  # noqa: E402
from worker_kit import WorkerState  # noqa: E402


class DemoGameTests(unittest.TestCase):
    def setUp(self):
        self.state = WorkerState("game-demo")
        self.game = DemoGame(self.state)

    def events(self):
        return self.state.events_after(0, self.state.epoch, 50)["events"]

    def test_a_turn_reports_itself_and_every_fifth_is_a_milestone(self):
        for _ in range(MILESTONE_EVERY):
            self.game.step()
        kinds = [e["kind"] for e in self.events()]
        self.assertEqual(kinds, ["turn"] * (MILESTONE_EVERY - 1) + ["milestone"])
        self.assertEqual(self.events()[-1]["urgency"], "immediate")
        self.assertEqual(self.state.snapshot()["facts"]["turn"], MILESTONE_EVERY)

    def test_a_directive_is_picked_up_on_the_next_turn_and_shows_in_the_summary(self):
        self.state.set_online(True)
        self.state.add_directive("focus on gold")
        self.game.step()
        self.assertIn("focus on gold", self.state.summary)
        self.assertIn("plan", [e["kind"] for e in self.events()])
        self.assertEqual(self.state.pending, 0)

    def test_forget_drops_the_notes_once(self):
        self.state.add_directive("focus on gold")
        self.game.step()
        self.state.forget()
        self.game.step()
        self.assertEqual(self.game.notes, [])
        self.assertFalse(self.state.forget_requested)
        self.assertEqual([e["kind"] for e in self.events()].count("forgot"), 1)

    def test_it_does_nothing_while_paused_and_plays_when_resumed(self):
        thread = threading.Thread(target=self.game.run, args=(0.01,), daemon=True)
        thread.start()
        self.assertTrue(self.state.online or self._wait(lambda: self.state.online))
        self.assertEqual(self.game.turn, 0)  # paused: it starts paused
        self.state.set_paused(False)
        self.assertTrue(self._wait(lambda: self.game.turn >= 3))
        self.state.set_paused(True)
        turns = self.game.turn
        self._wait(lambda: False, 0.15)
        self.assertLessEqual(self.game.turn, turns + 1)  # at most the turn that was under way
        self.game.stop.set()
        thread.join(2)

    @staticmethod
    def _wait(cond, timeout=3.0):
        end = threading.Event()
        for _ in range(int(timeout / 0.01)):
            if cond():
                return True
            end.wait(0.01)
        return cond()


if __name__ == "__main__":
    unittest.main()
