"""What a worker knows and publishes: the state, the events, the directives (docs/workers.md).

One `WorkerState` per worker process. The game agent's loop writes to it (`push`, `set_online`, ...) and reads what the
character asked for (`take_directives`, `wait_resumed`); the HTTP side (server.py) only reads it and hands the character's
words over. It is safe to use from several threads.

The rules the older agents did not keep, and this does:

* a worker starts **paused**, and stays so until told otherwise;
* every run has an **epoch**, a new random string each time the process starts, and event numbers are only meaningful
  inside one epoch: a reader that names another epoch is told to start over (`reset`);
* `forget` drops what the worker carries (notes, standing directives) and nothing else: the epoch, the event numbers and the
  pause state stay.
"""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Literal

Urgency = Literal["immediate", "soon", "later"]
URGENCIES = ("immediate", "soon", "later")

PROTOCOL = 1
EVENT_RING_SIZE = 300
EVENTS_PER_RESPONSE = 50
TRACE_SIZE = 200
MAX_COMMAND_CHARS = 300
DIRECTIVES_KEPT = 3
MAX_FACTS = 30


def _cut(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def _now_ms() -> int:
    return int(time.time() * 1000)


class WorkerState:
    def __init__(self, worker: str, *, epoch: str | None = None, ring: int = EVENT_RING_SIZE):
        if not worker or not worker.replace("-", "").replace("_", "").isalnum() or not worker[0].isalpha() or worker != worker.lower():
            raise ValueError(f"not a worker id: {worker!r}")
        self.worker = worker
        self.epoch = epoch or "w-" + secrets.token_hex(8)
        self._lock = threading.RLock()
        self._ring = ring
        self._events: list[dict[str, Any]] = []
        self._next_seq = 1
        self._trace: list[dict[str, Any]] = []
        self.online = False
        self._paused = True
        self._resumed = threading.Event()  # set while running
        self.summary = ""
        self.facts: dict[str, str | int | float | bool | None] = {}
        self.thinking = False
        self.executing: str | None = None
        self.given_up = False
        self.last_command: dict[str, Any] | None = None
        # Standing orders from the character, newest last; the agent puts them in every prompt.
        self.directives: list[str] = []
        # Directives the agent has not looked at yet.
        self._fresh: list[str] = []
        self.forget_requested = False

    # ── what the agent publishes ─────────────────────────────────────────────

    def push(self, kind: str, text: str, urgency: Urgency = "later") -> int:
        """Record something that happened; returns its number. `urgency` says when the character should speak of it."""
        if urgency not in URGENCIES:
            raise ValueError(f"urgency must be one of {URGENCIES}")
        with self._lock:
            seq = self._next_seq
            self._next_seq += 1
            self._events.append(
                {"seq": seq, "at": _now_ms(), "kind": _cut(kind or "event", 40), "text": _cut(text, 600), "urgency": urgency}
            )
            if len(self._events) > self._ring:
                del self._events[: len(self._events) - self._ring]
            return seq

    def set_online(self, online: bool) -> None:
        with self._lock:
            self.online = bool(online)

    def set_facts(self, **facts: str | int | float | bool | None) -> None:
        with self._lock:
            self.facts.update(facts)
            if len(self.facts) > MAX_FACTS:
                raise ValueError(f"at most {MAX_FACTS} facts")

    def add_trace(self, entry: dict[str, Any]) -> None:
        with self._lock:
            self._trace.append(entry)
            if len(self._trace) > TRACE_SIZE:
                del self._trace[: len(self._trace) - TRACE_SIZE]

    def trace(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._trace[-max(1, min(limit, TRACE_SIZE)) :])

    # ── pause ────────────────────────────────────────────────────────────────

    @property
    def paused(self) -> bool:
        return self._paused

    def set_paused(self, paused: bool) -> None:
        with self._lock:
            self._paused = bool(paused)
            if self._paused:
                self._resumed.clear()
            else:
                self._resumed.set()

    def wait_resumed(self, timeout: float | None = None) -> bool:
        """Blocks while paused. True when running, False if `timeout` ran out first."""
        return self._resumed.wait(timeout)

    # ── directives ───────────────────────────────────────────────────────────

    def add_directive(self, text: str) -> None:
        """The character said something. Kept as a standing order and queued for the agent's next step."""
        text = text.strip()
        with self._lock:
            self.last_command = {"text": _cut(text, MAX_COMMAND_CHARS), "at": _now_ms()}
            self.directives = (self.directives + [text])[-DIRECTIVES_KEPT:]
            self._fresh.append(text)
            self.push("command", f"directive from the character: {_cut(text, 200)}", "later")

    def take_directives(self) -> list[str]:
        """The directives not yet seen by the agent, oldest first (each is returned once)."""
        with self._lock:
            fresh, self._fresh = self._fresh, []
            return fresh

    @property
    def pending(self) -> int:
        with self._lock:
            return len(self._fresh)

    def forget(self) -> None:
        """Drop what the worker carries: standing directives and the last command. The agent is told through
        `forget_requested` (it clears its own notes and resets the flag). Epoch, numbers and pause are untouched."""
        with self._lock:
            self.directives.clear()
            self._fresh.clear()
            self.last_command = None
            self.forget_requested = True

    # ── what the character reads ─────────────────────────────────────────────

    @property
    def latest_seq(self) -> int:
        with self._lock:
            return self._next_seq - 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "protocol": PROTOCOL,
                "worker": self.worker,
                "epoch": self.epoch,
                "online": self.online,
                "paused": self._paused,
                "planner": {
                    "thinking": self.thinking,
                    "executing": None if self.executing is None else _cut(self.executing, 200),
                    "pending": len(self._fresh),
                    "given_up": self.given_up,
                },
                "last_command": self.last_command,
                "latest_seq": self._next_seq - 1,
                "summary": _cut(self.summary, 600),
                "facts": dict(self.facts),
            }

    def events_after(self, after: int = 0, epoch: str | None = None, limit: int = EVENTS_PER_RESPONSE) -> dict[str, Any]:
        """The events since `after`, oldest first, at most `limit`; `more` when there are more after those.

        A caller that names an epoch other than this run's has the numbers of another run: `reset` is true and the events
        start from the beginning. So does one that names none and asks from the middle."""
        limit = max(1, min(limit, EVENTS_PER_RESPONSE))
        with self._lock:
            reset = (epoch is not None and epoch != self.epoch) or (epoch is None and after > 0)
            start = 0 if reset else max(0, after)
            wanted = [e for e in self._events if e["seq"] > start]
            page = wanted[:limit]
            return {
                "epoch": self.epoch,
                "latest": self._next_seq - 1,
                "reset": reset,
                "events": [dict(e) for e in page],
                "more": len(wanted) > len(page),
            }
