# Workers

A worker is an agent that does a long job on its own while the character comments on it: it plays a game, decides what to do
next, acts, and reports what happened. The character does not press keys. It hears the reports, says something about them, and
steers the worker with short directives ("gather wood first", "go for science"). The worker is a plugin (a process the
supervisor starts, or one you start yourself) that serves the routes below on `127.0.0.1`; the [game mode](mode-game.md) is what
talks to it.

```
worker (its own model, its own tools, the game)  ◀── directives ──  character (the orchestrator's model)
      │  state, events (what happened, how urgent)                          ▲
      └──────────────────────────────── polled by the game mode ───────────┘
```

Contract: `packages/protocol/src/worker.ts`. Client: `packages/orchestrator/src/workers/`. Server kit for Python:
`plugins/_worker/worker_kit/`. Smallest example: `plugins/game-demo/`.

## Why one protocol

The two agents this grew out of (a Civilization VI player and a Minecraft bot) each had a link of their own on the same fixed
port (8098). Their first state, what `/pause` and `/forget` meant, and what happened to event numbers after a restart all
differed: after a restart the numbers began again at 1 with nothing to say so, so a reader that had seen 200 events silently
missed the first 200 of the new run. Now:

- the orchestrator picks the port (`port: auto`, given to the worker as `{port}`);
- every run has an **epoch**, and event numbers only mean something inside one;
- a worker **starts paused**, and pause, resume and forget mean the same in every worker.

## The routes

All JSON. Bodies are at most 4 KiB. Answers other than 2xx are `{ ok: false, code, message }` with a code from
`bad_request`, `not_online`, `not_found`, `too_large`, `forbidden_host`.

| Route | Does |
|---|---|
| `GET /health` | The plugin contract: `{ ok, ready, service: "game", config: { worker } }`. The supervisor polls it |
| `POST /shutdown` | The plugin contract: stop politely |
| `GET /worker/state` | `WorkerState`: `worker`, `epoch`, `online` (in a game), `paused`, `planner` (`thinking`, `executing`, `pending` directives, `given_up`), `last_command`, `latest_seq`, `summary` (one line for the model), `facts` (a few game-specific numbers and words, at most 30) |
| `GET /worker/events?after=<seq>&epoch=<epoch>&limit=` | The events after `seq`, oldest first, at most 50 (`limit` may lower that): `{ epoch, latest, reset, events, more }`. Each event is `{ seq, at, kind, text, urgency }` |
| `GET /worker/trace?limit=` | The last steps it took, for diagnosis (free-form, at most 200) |
| `POST /worker/command { text }` | A directive from the character, 1 to 300 characters. 409 `not_online` while it is not in a game. It is kept as a standing order (the newest three) and shown to the agent at its next step |
| `POST /worker/pause { paused }` | Pause or resume. A paused worker makes no decisions and takes no steps; events may still arrive, the game goes on. Answers with the pause state |
| `POST /worker/forget` | Drop the notes and standing directives it carries. Epoch, event numbers and pause state stay |

### The epoch, and `reset`

`epoch` is a new random string every time the worker process starts. A reader remembers the epoch of the run it has read and
the last `seq` it has seen, and asks with both. If the worker answers with another epoch, or the reader named none and asked
from the middle, the answer has `reset: true` and starts from the beginning of the new run: the reader forgets its cursor and
knows that what it believed about the game may be wrong. `WorkerFeed` in the client does exactly this, including reading a
long backlog in pages (`more`).

### Urgency

| | The character should speak of it |
|---|---|
| `immediate` | now (a death, a war, a milestone) |
| `soon` | at the next quiet moment (a turn finished) |
| `later` | only as background, in the next thing it says |

### Guards

A worker answers requests whose `Host` header is the loopback address it was reached at, and no other (a page cannot reach it
through the user's browser by pointing a name at 127.0.0.1); it sends no CORS header, ever; it validates everything it reads.
The client gives every call a time limit (5 s), reads at most 1 MB and checks every answer against the schema, because a call
that could hang once froze a whole game.

## Writing a worker in Python

```python
from worker_kit import WorkerServer, WorkerState

state = WorkerState("mygame")            # a fresh epoch, paused, not online
server = WorkerServer(state, port)       # 127.0.0.1:port, also serves /health and /shutdown
server.start()                           # serves in a thread

state.set_online(True)                   # when the game is connected
while running:
    state.wait_resumed()                 # blocks while paused
    for directive in state.take_directives():   # what the character asked for, once each
        ...
    # decide and act; then say what happened:
    state.set_facts(turn=turn)
    state.summary = f"Turn {turn}, ahead in science"
    state.push("turn", f"Turn {turn} finished", "soon")
    if state.forget_requested:            # drop your own notes, then clear the flag
        state.forget_requested = False
```

`plugins/game-demo/service.py` is a complete worker in 90 lines; copy it. The manifest is `plugins/game-demo/plugin.yaml`: a
process on the light Python environment, `service: game`, `port: auto`, stopped politely with `POST /shutdown`.

## Older agents: the adapter

The Civilization VI player and the Minecraft bot speak the older link (`GET /status`, `GET /events?after=`, `GET /trace`,
`POST /command`, `/pause`, `/forget`). `LegacyLinkClient` reads it and says it in the terms above, so neither needs a change;
the game mode chooses it with `protocol: legacy`. Run the agent yourself (its own start script) and attach it with a plugin of
`service: game` that only health-checks (`plugins/game-attach-legacy`). What the adapter cannot give them is an epoch: it makes
one up, and makes a new one when the agent's newest event number goes backwards, which is what a restart looks like from
outside. A restart that has already produced more events than the reader had seen goes unnoticed, and the first ones of the new
run are missed. That is a limit of the older link, not of the adapter; an agent that uses the kit has no such gap.

## Concurrency

One worker runs at a time (the game mode is exclusive with the other modes that take the stream over). Several workers on one
machine are limited by the memory their plugins declare (`resources` in the manifest), like any other service; there is no
fixed number.
