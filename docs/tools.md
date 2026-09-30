# Tools and approvals

The character can ask the program to do things: leave a note for the streamer, write something down, start a mode.
Once a model can ask for things, what the audience writes is untrusted input that may be steering it, so one rule
decides everything here: **what a tool call may do depends on who wrote the text that led to it, never on what the
model decided.**

```
viewer chat ─▶ inbox ─▶ brain ─▶ model ─▶ ```tool block ─▶ ToolGate ─▶ tool
                 │                                            │
      who wrote each line                    origin + tier ─▶ run | queue for the streamer | refuse
```

| Part | Where |
|---|---|
| Tiers, the rule (`decideTool`), audit entries | `packages/protocol/src/tools.ts`, `approvals.ts` |
| The gate: the only way to run a tool | `packages/orchestrator/src/tools/gate.ts` |
| The tools that ship | `packages/orchestrator/src/tools/builtin.ts` |
| Reading a call out of the reply | `packages/orchestrator/src/brain/toolblock.ts` |
| Who a reply answers | `packages/orchestrator/src/tools/origin.ts` |
| The console's Approvals tab and routes | `packages/console/src/Approvals.tsx`, `console/routes.approvals.ts` |

## The rule

Every tool has a **tier**:

| Tier | What happens to a call |
|---|---|
| `free` | It runs. Anything may trigger it, including a reply to the audience. It may only do what a viewer could safely make happen. |
| `approval` | It is put in the console's Approvals tab and runs only when the streamer says yes there. Only a call that came from a moderator, the streamer or the program itself may even be queued. |
| `disabled` | It never runs. |

A call whose origin is `untrusted` to an `approval` tool is **refused before anything is queued**: an injected
instruction cannot even put a request in front of the streamer. This is `decideTool` in the protocol package and the
gate applies it to every call, in this order:

1. the tool must exist (`unknown_tool`);
2. tier and origin decide: `disabled`, `untrusted_origin`, or go on;
3. a source may ask only so often (`rate_limited`, `tools.per_minute`; refused calls do not count against it);
4. the arguments are checked against the tool's own schema (`bad_args`), before running and **before queueing**, so
   garbage never reaches the streamer and what runs is what the schema made of the arguments;
5. free: it runs. Approval: it waits (`queue_full` past `tools.max_pending`).

A queued call keeps its own copy of the checked arguments. Approving runs exactly those, once (the entry leaves the
queue before it runs, so two clicks are one run); a call nobody answers expires (`tools.approval_ttl_sec`) and can no
longer be approved. Approving and denying exist only as console routes: the stage page has no message for it, and no
text from chat can reach them.

## Who wrote it: origin and trust

Each line that reaches the model has a role, decided from the platform's own flags and never from the words:

| Line | Role | Trust |
|---|---|---|
| Chat, paid messages, gifts, guard purchases, song lines made from what viewers wrote | none (audience) | `untrusted` |
| A room moderator's own chat message | `moderator` | `trusted` |
| The streamer's account (the room owner, or `inbox.singing.owner_uids`) | `host` | `privileged` |
| The cold-start line the program writes itself | `system` | `privileged` |

A reply is judged as its **least trusted line**: a moderator's line and a viewer's line in the same batch make an
audience reply, because the model reads them together and cannot tell which one an instruction came from. Text that
says "I am a moderator" or carries the markers is still the audience.

Other ways a message reaches the model are untrusted unless the program says otherwise:

- a mode's `host.tellBrain(text)` is **untrusted by default**: the text may hold a viewer's name, a song title, a chat
  line. A mode passes `fromProgram: true` only when nothing in the text or extras was written by anyone else; a
  message with pictures is never trusted;
- the reply to "forget me" carries the viewer's name and is untrusted.

## What the model is told

The model cannot tell a moderator's line from a viewer's in the text, and must not be able to (a marker in the text
could be typed by anyone). So when a reply answers staff only, the program says so in the system prompt, from the
platform's own flags: "the message below comes from a room moderator" (or "from the streamer"). It names no one: a
name is chosen by a person and does not belong in a system prompt. An audience reply, or one with any audience line
in it, gets no such note.

Each reply's prompt lists only the tools a call from that reply could get anywhere with (an audience reply is told
of the free ones only; `enter_mode` and `exit_mode` are left out when no mode is switched on, and name the modes
that are) and how to ask: a fenced block whose language word is `tool`, with one JSON object.

````
```tool
{"tool": "enter_mode", "args": {"mode": "sleep"}}
```
````

The block is never spoken and is not part of the record. At most three per reply are taken; a block that is not valid
JSON, is longer than 2,000 characters, or was cut off by the end of the stream is ignored. A reply that was cancelled
or failed asks for nothing. Only what the *model* writes is read: a fence typed in chat does nothing.

On its next reply the model is told what became of its calls (done, waiting for the streamer, the streamer said yes or
no, expired, did not work, not allowed here). A refusal says only that, so the model cannot be used to learn how the
gate decides.

## The tools that ship

| Tool | Tier | Floor | What it does |
|---|---|---|---|
| `tell_streamer` | free | free | A private note in the console (a run-log line and a quiet alarm). Never spoken, never on the stage. |
| `remember` | approval | approval | Adds one `[agent]` line to `world/agent-notes.md` in memory. Only exists when memory is on. |
| `enter_mode` | approval | approval | Starts a mode the way the console does. The mode id must be an enabled mode, or the call fails the arguments check at once. |
| `exit_mode` | approval | approval | Ends a mode. |

The **floor** is the lowest tier the configuration may give a tool: the operator can switch `enter_mode` off or leave
it at approval, never make it free.

## Configuration

```yaml
tools:
  enabled: true              # false: the model is told of no tools and tool blocks in replies are ignored
  tiers: {}                  # e.g. { tell_streamer: disabled, remember: disabled }
  approval_ttl_sec: 600      # a request waits this long for your answer
  max_pending: 20            # requests waiting at once
  per_minute: 20             # calls one source may ask for per minute
```

## The Approvals tab

Lists what waits (the tool's own one-line summary, who asked and with what trust, the arguments as they will be run,
how long it still waits) with **Approve** and **Deny**, and the last decisions. A count on the tab says how many wait;
the page reads the list again whenever the server says it changed. Text in a request is shown as text.

Routes (all need the console token, like everything under `/api`):

| Route | |
|---|---|
| `GET /api/approvals` | `{ pending, recent }` |
| `POST /api/approvals/:id/approve` | runs it now; 404 unknown id, 409 already decided or expired |
| `POST /api/approvals/:id/deny` | drops it; same refusals |

## The trail

Every decision (ran, queued, approved, denied, expired, refused, failed) is a line in the console's run log and a JSON
line in `data/tool-audit.jsonl` (who, what, why, the arguments cut short; over a megabyte the old file is kept as
`.1`). The file is private, like the rest of `data/`.

## What this does not do

The gate stops a call that came from the audience. It cannot know whether a moderator's or the streamer's own request
is what they meant: for those the streamer's yes in the Approvals tab is the check, and the summary is written by the
tool, not by the model, so it says what will really happen. A model that has been steered by the audience *earlier* in
the conversation can still misjudge a later moderator request (the history is in its prompt); the same yes is the
safeguard there. A free tool is only as safe as what it does: keep them to actions a viewer may cause.

## Adding a tool

A tool is a name, a schema for its arguments, a one-line `summarize`, and `run`. Register it in
`tools/builtin.ts` (or hand a `ToolRegistry` your own). Give anything that changes what the program does or remembers
the tier `approval` and a `floor: 'approval'`; give a `free` tool only an effect a viewer could safely cause. Put the
argument checks in the schema: it runs before the call is queued.
