"""A pretend game worker: the smallest thing that speaks the Worker protocol (docs/workers.md).

    python service.py --port N [--tick SECONDS]

Every tick, while it is not paused, "a turn passes": it pushes an event, and now and then a bigger one. Directives from the
character are picked up on the next tick and shown back as events. Nothing here plays a game or reaches outside the process.
Copy this file to start a real worker: replace `step()` with the agent's own loop.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_worker"))

from worker_kit import WorkerServer, WorkerState  # noqa: E402

WORKER_ID = "game-demo"
MILESTONE_EVERY = 5


class DemoGame:
    def __init__(self, state: WorkerState):
        self.state = state
        self.turn = 0
        self.gold = 10
        self.notes: list[str] = []
        self.stop = threading.Event()

    def step(self) -> None:
        """One turn of the pretend game. A real agent would decide and act here."""
        st = self.state
        if st.forget_requested:
            self.notes.clear()
            st.forget_requested = False
            st.push("forgot", "the notes and standing directives were dropped", "later")
        for text in st.take_directives():
            self.notes.append(text)
            st.push("plan", f"following the directive: {text}", "later")
        st.thinking = True
        st.executing = f"turn {self.turn + 1}"
        self.turn += 1
        self.gold += 3 + len(self.notes)
        st.set_facts(turn=self.turn, gold=self.gold, notes=len(self.notes))
        st.summary = f"Turn {self.turn}, {self.gold} gold" + (f", following: {self.notes[-1]}" if self.notes else "")
        if self.turn % MILESTONE_EVERY == 0:
            st.push("milestone", f"Turn {self.turn}: {self.gold} gold, a new district is ready", "immediate")
        else:
            st.push("turn", f"Turn {self.turn} finished, {self.gold} gold", "soon")
        st.thinking = False
        st.executing = None

    def run(self, tick: float) -> None:
        self.state.set_online(True)
        self.state.push("start", "the demo game is running (paused until asked to play)", "later")
        while not self.stop.is_set():
            # a paused worker makes no decisions; it looks again shortly
            if not self.state.wait_resumed(0.2):
                continue
            self.step()
            self.stop.wait(tick)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="A pretend game worker.")
    parser.add_argument("--port", type=int, required=True, help="port on 127.0.0.1")
    parser.add_argument("--tick", type=float, default=float(os.environ.get("GAME_DEMO_TICK", "4.0")), help="seconds per turn (default 4, or GAME_DEMO_TICK)")
    args = parser.parse_args(argv)
    state = WorkerState(WORKER_ID)
    game = DemoGame(state)
    server = WorkerServer(state, args.port, on_shutdown=game.stop.set)
    threading.Thread(target=game.run, args=(args.tick,), name="demo-game", daemon=True).start()
    print(f"{WORKER_ID} listening on 127.0.0.1:{server.port} (epoch {state.epoch})", flush=True)
    try:
        server.serve_forever()
    finally:
        game.stop.set()
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
