"""The server side of the Worker protocol, for a game agent written in Python. See docs/workers.md.

    from worker_kit import WorkerServer, WorkerState

    state = WorkerState("mygame")          # a new epoch, paused, not online
    server = WorkerServer(state, port)     # 127.0.0.1:port
    server.start()                         # serves in a thread
    state.set_online(True)
    state.push("turn", "Turn 3 finished", "soon")
    for text in state.take_directives(): ...   # what the character asked for
    state.wait_resumed()                   # blocks while paused
"""

from .server import WorkerServer
from .state import (
    DIRECTIVES_KEPT,
    EVENT_RING_SIZE,
    EVENTS_PER_RESPONSE,
    MAX_COMMAND_CHARS,
    PROTOCOL,
    URGENCIES,
    WorkerState,
)

__all__ = [
    "DIRECTIVES_KEPT",
    "EVENT_RING_SIZE",
    "EVENTS_PER_RESPONSE",
    "MAX_COMMAND_CHARS",
    "PROTOCOL",
    "URGENCIES",
    "WorkerServer",
    "WorkerState",
]
