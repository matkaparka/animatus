# Mode packs and VRAM arbitration

Source of truth: `packages/protocol/src/mode.ts`. Each feature that takes over the stream for a while
(dance, sing, sleep, draw, commentary, game, ...) is a mode pack; the mode manager is the only thing that
enters and leaves modes.

```
modes/<id>/mode.yaml
modes/<id>/prompts/*.md
```

```yaml
id: draw
title: Draw on request
requires:
  services: [tts, motion, forge]
  vram_mb_est: null            # measured by the probe, then written to the measurement store
exclusive_with: [sing, game, sleep, reaction]
priority: 50                   # sleep is 100 with preempts: true
prompt: prompts/draw.md        # loaded on enter, dropped on exit
tools: [draw_image]
triggers:
  hotkey: ctrl+alt+p           # shown as a shortcut on the console's mode page
  danmaku_prefix: ["draw", "/draw"]
stage:
  layout: frame
  background: drawing_frame
```

## State machine

`IDLE → STARTING (start services) → ACTIVE → STOPPING (unload, wait for VRAM to fall back) → IDLE`.
Any step that times out returns to `IDLE` and raises an alarm.

## Admission (configuration-driven, not hard-coded)

1. At start-up, and after any plugin setting changes, read the relevant settings (image service maximum
   long side, checkpoint architecture, hires, LoRA count; speech synthesis precision; local LLM model and
   context length).
2. Estimate each mode's VRAM from **probe measurements** keyed by service and a hash of those settings.
   A setting combination that was never measured uses a conservative value and is shown as
   "not measured".
3. Compute whether each mode fits alone and whether each pair fits together, giving a compatibility
   matrix. Modes that do not fit are greyed out in the console with the reason.
4. The matrix recomputes immediately when a setting changes; no restart.

The resident set is the stage's WebGL (on hybrid-GPU machines the browser may sit on the integrated GPU
and cost the discrete card nothing), the speech synthesizer, and the motion service (no VRAM).

## Measuring

`packages/vram-probe` records dedicated GPU memory per process once per second and attributes it to
roles. Marks `enter:<mode>` and `exit:<mode>` define a window; the summary reports the peak and steady
cost above the level just before the window, and whether memory fell back afterwards.

```bash
node packages/vram-probe/src/cli.ts record --label draw \
  --role "forge=cmd:launch.py" --role "stage=cmd:my-profile-dir"
node packages/vram-probe/src/cli.ts mark "enter:draw"
node packages/vram-probe/src/cli.ts mark "exit:draw"
node packages/vram-probe/src/cli.ts stop
node packages/vram-probe/src/cli.ts summarize probe-out/draw-<stamp>.jsonl \
  --window enter:draw..exit:draw --key forge --config-hash <hash> --write-measurement data/vram-measured.json
```

## What runs a mode: the controller

A pack is data. The code of a mode is its **controller**, one file under
`packages/orchestrator/src/modes/controllers/<id>.ts`, registered in `controllers/index.ts`. A controller
never reaches into the application; it gets a `ModeHost` (`modes/host.ts`), the narrow set of things a
mode legitimately needs: the stage (`hub.send`, `hub.on('dance.state', …)`), the voice (`holdSpeech`,
`say`, `whenQuiet`), the model (`tellBrain`, `brainBusy`), other modes, the plugin services
(`serviceUrl`), the pack's prompts (`prompt`), alarms and the run log. That is also what keeps a mode
testable with a handful of fakes.

`enter(ctx)` and `exit(ctx, reason)` are the mode manager's. `ctx.signal` is aborted when the mode is being
torn down or a step timed out, and a controller has to stop promptly when it is. Leaving a mode **while it
is still starting** (the operator presses stop while a service is coming up) aborts the start at once and is
not an alarm; the queued exit does not wait for a start that would have taken a minute.

Optional hooks, all called by the mode service:

| Hook | When | Used for |
|---|---|---|
| `attach()` | once, at start-up | subscribe to stage reports; return a function that undoes it |
| `advertise()` | before every model reply, while the mode is not active | "you may ask for this" text for the model: a prompt file of the pack and its variables, or nothing |
| `onBatch(batch)` | a batch of audience input is about to go to the model | extra lines for that reply only (a dance gift: "you are about to dance"); may start the mode |
| `onModelRequest(req)` | the model wrote a tag for the mode (`[motion:dance:name]`) | start the mode if it may |
| `onConsoleRequest(req)` | the console's Modes page asked, with details | start, tune, stop; the answer says why if it cannot |
| `onChatCommand(cmd)` | a chat message starts with a word the manifest lists under `triggers.danmaku_prefix`, and the mode is ACTIVE | take the message as a command (return true: it is not chat any more) or leave it to the chat (false). Longer words are asked first. Must be quick: start slow work and return |
| `promptVars()` | before every reply, while the mode is ACTIVE | values for the `{{name}}` placeholders of the pack's active prompt (the game being played, the summary so far); a name it does not give stays as written |
| `panel()` | every time the console asks for the modes | what the console shows besides the state: facts, buttons (with inputs) and lists, as data (`ModePanel`); what the operator presses comes back through `onConsoleRequest` with `action` (and `row`, and one field per input) set to the ids given |

A mode is only built when the configuration switches it on (`modes.<id>.enabled`, default off) **and** this
program has a controller for it. Anything else shows on the Modes page as unavailable with the reason; a mode
named in the configuration that has no pack at all (a typo) is an alarm, as is a pack that cannot be read.
A mode's own settings live under `modes.<id>.config` and are validated by its controller.

Prompts the model sees: the active prompt of every running mode (`prompt:` in the manifest), then the
advertisement of every mode that could be entered. They are markdown files in the pack; an operator overrides
a file by putting the same name in `config/modes/<id>/prompts/`, file by file, without copying the rest.

## The modes that ship

| Mode | What | Needs | Documentation |
|---|---|---|---|
| `dance` | dances to music when a viewer asks, holds the voice, says a closing line | dances in the motion library | below |
| `sleep` | a long whisper track, a calm look, chat answered now and then in a whisper | `paths.asmr`, a `whisper` voice style, a `night` background | [mode-sleep.md](mode-sleep.md) |
| `commentary` | comments on what a game window shows | the `screencap` plugin, a model that accepts pictures | [mode-commentary.md](mode-commentary.md) |
| `draw` | draws what a viewer asks for (`画 …`) on your own Forge under an all-ages policy, shows it in a frame, comments | the `forge` plugin and a running Forge, a model that accepts pictures | [mode-draw.md](mode-draw.md) |

## Dance

Pack: `modes/dance/`, controller `controllers/dance.ts`. Dances are folders under the motion library's
`dance/` (`motion.vrma`, optional `music.ogg|mp3|wav`, optional `meta.json` with `title`, `offset`, `bpm`,
`speed`, `volume`, `credit`, `enabled`); adding one needs no code and is picked up within about 15 seconds (the library is rescanned at most that often while the program runs).

A request comes from one of three places, and is answered `ok`, `busy`, `cooldown`, `none` or `notfound`:

- **a gift** whose name is in `inbox.dance.gifts`: the router turns it into a dance line, the controller
  starts the request and adds "you are about to dance, thank them first" to that reply;
- **the model**, with `[motion:dance]` or `[motion:dance:<name>]` at the start of the last sentence;
- **the console**: `POST /api/modes/dance/enter` with `{ "params": { "name": "aipao" } }` (no name: a random one;
  `"trial": true` says nothing afterwards and starts no cooldown). It ignores the cooldown and a dance's enabled flag.

Then, in order: the request waits until the reply that carried it has been spoken (dropped after
`pending_timeout_sec`); the mode is entered; `dance.play` goes to the stage and the voice is held; when the
stage reports the dance playing, the audience's queue stays closed; when the stage reports it over, the mode
is left, the model is told "you have just finished a dance" (`prompts/outro.md`) so it can say a closing line,
and the queue is released as soon as the model starts answering, or after `outro_window_sec`. A dance that is
cut short (the console, another mode, the stage stopping it, a shutdown) sends `dance.stop`, skips the closing
line, and still starts the cooldown; a dance the stage could not load raises `dance_failed` with the stage's own
words and starts no cooldown.

Not the controller's job, and done by the stage: fading in and out, the happy face, damped spring bones,
keeping the root inside a radius, the credit line.

The operator's live tuning from the console (`POST /api/modes/dance/act` with
`{ "params": { "action": "tune", "offset": 1.5, "speed": 0.9 } }`, per dance) is applied to the running dance and
remembered in `data/dance-state.json`, together with the end of the last dance (so a restart does not reset the
cooldown) and its name (so the next random pick is another one).

### Settings (`modes.dance.config`)

| Key | Default | Meaning |
|---|---|---|
| `cooldown_sec` | 180 | after a dance, requests from viewers and the model wait this long |
| `pending_timeout_sec` | 90 | how long a request waits for the reply that carried it to be spoken |
| `outro_window_sec` | 8 | how long the model has to start its closing line before the queue is released anyway |
| `start_timeout_sec` | 30 | the stage must report the dance as playing within this long |

## What a mode does to the stage

A pack's `stage:` section says how the stage should look while the mode is active. Each of `layout`,
`background` and `look` is either the values themselves or the **name of a preset** in the operator's
configuration:

```yaml
# modes/sleep/mode.yaml
stage:
  look: { calm: 1, dim: 0.6, mouth_scale: 0.6, light: 0.6 }     # values (any subset of look.set)
  background: night                                            # a name: stage.presets.backgrounds.night
  layout: corner                                               # a name: stage.presets.layouts.corner
```

```yaml
# config/animatus.config.yaml
stage:
  presets:
    layouts:     { corner: { char: { x: 55, y: 0, scale: 0.4 } }, frame: { char: { x: 40, y: 5, scale: 0.5 }, frame: { left: 5, top: 5, width: 60, height: 80 } } }
    backgrounds: { night: { kind: image, url: /asset/models/night.png, dim: 0.3 } }
    looks:       { quiet: { calm: 0.7 } }
```

When a mode becomes active the application sends the composed scene and look; when it is left the stage goes
back to the configuration (or to what the remaining active modes ask for). Layout fields and look fields merge
one by one, a background replaces the whole background, and where two active modes disagree the one with the
higher `priority` wins. A name the configuration does not have is a `mode_stage_preset` alarm for as long as the
mode is active; whatever else the mode asked for still applies. A stage that connects while a mode is active
gets that mode's stage, not the plain configuration.

## What a controller can use

Beyond the stage, the voice and the model (see the host above), a `ModeHost` gives a controller:

| Member | For |
|---|---|
| `libraryDir(name)`, `assetUrl(name, ...parts)` | files the stage fetches: `songs`, `asmr`, `motions` (from `paths.*`) and `generated` (always `data/generated`, made at start). `assetUrl` throws for a path that could not be served |
| `llmText({ tag, system, user, ... })` | one question to the model without persona and history, answered as text: planning, analysis. Same providers, keys and fallbacks as chat; counted under `tag` |
| `tellBrain(text, { images, fromProgram })` | a system message the model answers in character, with pictures it should look at (not kept in the record). Resolves with how the answer ended: `{ status: 'done' | 'failed' | 'cancelled', sentences, error? }` (the speech may still be playing). The reply is judged as **untrusted** (a tool it asks for can only be a free one, see [tools.md](tools.md)) unless `fromProgram: true` says the text is the program's own words: nothing in it or in `extras` written by a viewer or taken from outside (no name, song title, chat line, page text). With pictures it is never trusted |
| `songLine(text)` | a line about a song (`FORMATS.songQueued` and friends) for the model to react to, ahead of gifts and chat |
| hook `onSongCommand(cmd)` | a viewer's `点歌 …`, `切歌`, `歌单`, `取消点歌` command; return true when the mode took it, otherwise the run page says it was ignored |

`test/modes/fakeHost.ts` is a `ModeHost` made of fakes that write down what a controller did (see the header of
that file); `test/modes/dance.test.ts` shows a controller tested through the real mode service instead.
