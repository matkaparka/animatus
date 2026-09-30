# Automations

"When this happens, do that", written in the configuration. A rule names an event and a short list of things to do.
Everything a rule can do is something the program already does for other reasons: say a fixed line, ask the model to
say something, call a tool through the [tool gate](tools.md), run the memory pass. A rule cannot run a command or reach
the network.

```yaml
automations:
  max_per_minute: 12          # all rules together; the rest are dropped
  quiet_wait_sec: 20          # how long a line waits for the voice to be free before it is dropped
  rules:
    - id: follow-reminder
      on: timer
      every_min: 20
      do:
        - say: "If you like the stream, a follow means a lot."

    - id: quiet-room
      on: cold_start          # needs inbox.cold.enabled: true; replaces the default cold-start line
      do:
        - tell: "The room has been quiet for {minutes} minutes. Bring up something you find interesting."

    - id: new-crew
      on: guard
      do:
        - tool: { name: tell_streamer, args: { text: "{name} became {title}" } }

    - id: after-the-stream
      on: stream_end
      do:
        - say: "That is all for today. Thank you for watching."
        - consolidate_memory: true
```

## Events

| `on` | When | Offers |
|---|---|---|
| `timer` | every `every_min` minutes (1 to 1440) while the program runs | nothing |
| `cold_start` | nobody has written for `inbox.cold.minutes`; with a rule for it, the default cold-start line is not sent to the model | `{minutes}` |
| `stream_start`, `stream_end` | the platform says the stream went on or off the air (Bilibili's own messages; a lost connection is not this) | nothing |
| `guard` | someone bought a guard tier | `{name}`, `{title}`, `{months}` |
| `superchat` | a paid message; `min_yuan` keeps only the larger ones | `{name}`, `{yuan}`, `{text}` |
| `mode_entered`, `mode_exited` | a mode became active, or ended; `mode` keeps only one | `{mode}` |

A rule may only use the placeholders its event offers: anything else is a configuration error that names the rule and
what the event does offer, so a typo is not spoken aloud on stream.

## Things to do

Each entry of `do` is exactly one of:

| | |
|---|---|
| `say: "text"` | speaks the line, no model. It waits for the voice to be free and is dropped, not kept waiting, when it is not. The sensitive-word filter applies as for everything spoken |
| `tell: "text"` | gives the model a system message to answer in character, as the mode host's `tellBrain` does |
| `tool: { name, args }` | calls a tool through the gate; the strings inside `args` are filled in like the other texts |
| `consolidate_memory: true` | runs the memory consolidation pass now (also writes the stream note when `memory.consolidate.stream_notes` is on); does nothing when memory is off |

Up to five per rule, run in the order written.

## Who a rule acts as

The events that come from the audience (`guard`, `superchat`) carry the audience's name and words. The program does not
let those become instructions:

- A `tell` after such an event is answered as **untrusted**: a tool the model asks for in that reply can only be a free one.
- A `tool` after such an event is called as **that viewer**, untrusted: only free tools run. A tool that waits for the
  streamer's yes is refused, and the program says so when it starts (alarm `automation_tool_untrusted` naming the rule)
  rather than letting it fail quietly on stream.
- The name and the words are cleaned like everything a viewer writes, so they cannot carry a marker of their own.

Events the program makes itself (a timer, the end of the stream, a mode changing, a quiet room) are the program's own
words: a `tell` is answered as trusted, and a `tool` is called as **the system**. A tool that waits for approval still
waits: the request goes to the console's Approvals tab and nothing happens before the streamer says yes. A rule is not a
standing approval.

## Limits

- A rule for an audience event waits 30 seconds before it runs again; other rules have no wait. `cooldown_sec` sets either.
- Rules run one at a time. At most ten wait; the rest are dropped and the run log says so.
- All rules together do at most `max_per_minute` things a minute.
- Every result is a line in the console's run log (`automation <id>: ...`), including what the gate answered to a tool call
  and why a line was skipped.

## Not there

There is no event for a chat message: what a viewer types is never a trigger. A rule cannot start a mode by itself
(`enter_mode` needs the streamer's yes, always); it can ask for one.
