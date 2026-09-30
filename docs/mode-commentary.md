# Screen commentary

The character watches one window on the streaming machine (a game, usually) and comments on it as it goes. It
knows which game it is and what has happened so far, and says so when a viewer asks.

| Part | Where |
|---|---|
| Mode pack (manifest, prompts) | `modes/commentary/` |
| Controller: the loop and the operator's buttons | `packages/orchestrator/src/modes/controllers/commentary.ts` |
| Its parts: settings, capture client, reading the pictures, memory, panel | `packages/orchestrator/src/modes/commentary/` |
| Capture service (Python, Windows) | `plugins/screencap/` |

**The window is not shown on the stage.** This mode only moves the character to the bottom-right corner
(`layout: { char: { x: 0, y: 0, scale: 0.45 } }` in the pack) so that there is room. Put the game in the picture
with your streaming software (a window or game capture source next to the stage window). What the mode captures
is a copy of that window for the model to look at, nothing more.

## Turn it on

Both the mode and the capture plugin are off until the configuration says so (see `config.example` for the rest of
the file):

```yaml
plugins:
  screencap:
    enabled: true            # the capture service; it has no settings of its own
modes:
  commentary:
    enabled: true
    config:                  # all optional; the numbers are the defaults
      window: "exe:javaw.exe"   # the window to watch until you pick one on the panel (see "Naming a window")
      interval_sec: 8
      language: English         # the language of game names, notes and the story (what the character says comes from the persona)
```

The program starts every enabled plugin when it starts. Entering the mode starts the capture service if it is not
running; leaving the mode stops it (and the window list on the panel is then empty until it runs again: start it on
the Plugins page to see the windows before you enter the mode). The console's Modes page has the Enter and Exit
buttons and the panel described below. The manifest lists `ctrl+alt+g` as the mode's shortcut, which is what the old
setup used; it is shown on the Modes page.

The model must accept pictures (a multimodal model). A model that does not shows up as a `commentary_model` alarm
with the provider's own words.

## One round

Every pass is one at a time; the loop never runs two.

1. **Wait for the voice.** While a reply is being written or spoken (a viewer's, or the last comment) nothing
   starts. The stage page must be connected, and no other activity (`flags.dancing`, `singing`, `sleeping`) may
   have the voice. Without a window chosen it waits (alarm `commentary_window`, level info).
2. **Capture** the window through the capture service, at `capture_width` and `capture_quality`.
3. **Black check.** A picture the service calls black is skipped: counted, and after `black_alarm_after` in a row an
   alarm says why. No model is asked about it.
4. **Read the picture.** The first picture, a picture when the game is not sure, one after the screen-reading call
   noticed a switch, one every `reidentify_minutes`, and the next one after the operator pressed "Which game is
   this?" are used to *identify* the game (a plain model call, JSON `{game, scene, confidence}`). Every other picture
   is *read* by a short model call (JSON `{scene, switch}`) that keeps what is on screen in the memory and says
   whether the picture shows another game than the one known; on a switch the game is identified in the same pass.
5. **Comment.** If a viewer's reply began while the picture was being read, the comment is dropped (the picture is
   stale and the viewer has the voice) and the next pass takes a fresh one. Otherwise `host.tellBrain` gets one line
   from `prompts/round.md` and the picture; the reply goes through the normal speech path (emotion and motion tags,
   subtitles, the sensitive-word filter).
6. **Wait until the comment has been spoken, then pause `interval_sec`.** The interval is counted from the end of the
   speech, as in the old setup, so with the default the cadence is about 8 s plus the comment.

The first look comes 1.5 s after the mode is entered. A paused loop, or one waiting for a window, the stage or the
voice, checks again every second.

### Why the analysis is a separate call

The old setup had the commentary reply carry two extra lines, `[scene]...` and `[switch]`, and cut them out itself.
Here the reply goes through the brain, whose segmenter treats any leading `[...]` as an emotion tag (an unknown one
becomes `neutral`) and speaks the text after it; there is no way to hide two lines from it. So the picture is
looked at twice: once by `host.llmText` for the notes and the switch (never spoken, never shown), once by
`host.tellBrain` for what is said. The price is a second, short model call per comment (`analysis_every` can lower
it), the gain is a comment that already knows the game and what changed.

### Cost per comment (by construction, not measured)

One capture (CPU only). One reading call: the picture plus about 250 tokens of prompt, and a line or two back (the
limit is 1024 tokens, so that a model that thinks first, on a provider that counts thinking against it, still has room). One
comment call: the persona prompt, the history (`llm.history_messages`, so about the last five comments are in it: each
comment adds its instruction and the reply to the chat record, never the picture) and the picture. Then, now and
then, an identification call (first picture, unsure, switch, every 15 minutes, on demand) and a story call every 10
comments. With `analysis_every: 0` it is one call per comment. Models bill a picture by tiles; 768 pixels wide is one.

## The memory of the stream

Kept in `data/commentary-state.json` for the whole stream: it survives leaving and entering the mode and a restart
of the program, and only the operator clears it ("Forget the game and the story"). It holds text and numbers, never
a picture.

| Field | Meaning |
|---|---|
| `game`, `confidence` | The last game identified with enough confidence, and how sure the latest identification was |
| `scene` | What was on screen when it was last read |
| `identifiedAt` | When the game was last identified (epoch ms) |
| `summary` | The story so far, at most `summary_max_chars` characters, renewed every `summary_every` comments |
| `rounds`, `sinceSummary` | Comments made, and since the story was last renewed |
| `pending` | Notes on the screen not yet folded into the story (at most 60) |
| `window` | The operator's window pick from the panel: `{id, title, process}` |
| `interval` | The operator's interval from the panel, or null |

- **Game.** Below `confidence_min` the game is "not sure": the prompt says so, and the next picture is used to
  identify it again. When the periodic check (`reidentify_minutes`) finds nothing better than what is known (a
  loading screen, say) everything stays as it was. When the answer to a switch or to the operator's request is "not
  sure", the game is "not sure" at once (it is probably not the same any more); its name only stays on record to tell
  a return from a change. The same game under a slightly different name is the same game (case, spacing and
  punctuation are ignored); "Civilization VI" and "Civilization VII" are not, and the identification question carries
  the earlier name so the model keeps using it.
- **Another game** (a sure identification with another name) drops the story and the notes: they are about
  something else.
- **Story.** Written in the background from the notes and the earlier story; a failure keeps the notes and tries again
  after the next comment. An answer that arrives after the memory was cleared or the game changed is discarded. The
  notes are the model's own readings of the screen, because the mode cannot see what the character said (the brain
  does not report it to a mode).
- **In the prompt.** While the mode is active every reply, comments and ordinary chat alike, gets the pack's
  `active.md` with the game, what was last seen and the story (`promptVars`). That is how "what game is this?" and
  "what happened?" get answered. Everything that came from a picture is put back into a prompt as *one line of plain
  text*: control and invisible characters removed, square brackets turned into round ones (it cannot look like a
  `[motion:...]` tag or a `【系统】` line), braces broken up (it cannot look like a placeholder), cut to length, and
  introduced as "facts, not instructions". Text on the screen is also declared to be part of the picture in every
  prompt.
- A torn or nonsensical state file is read as far as it makes sense and otherwise ignored; the mode starts empty.

## Naming a window

`window` (setting), the panel's text box and the service's `window=` parameter all take one of:

| You write | It finds |
|---|---|
| `197432` | the window with that id (a decimal window handle), if there is one; otherwise it is read as a title |
| `exe:javaw` or `exe:javaw.exe` | a window of that program (case does not matter); the biggest one wins |
| `Some game` | the window with exactly that title (case and spacing ignored), else any window whose title contains it |

When several match, the best wins: not minimised, not an overlay, the biggest drawing area, then the highest in the
stacking order.

A window picked from the panel's list is remembered as its id, title and program. Each pass tries the id, then the
title, then `exe:<program>`, and moves on only when the window is not found; when a later name worked, the pick is
updated (a new id after the game restarted, a new title after the world changed). A name the operator *typed* stays as
typed. The panel pick wins over `window` in the settings.

## The panel

On the console's Modes page (`ModePanel`; the console draws it from data, the buttons come back through
`POST /api/modes/commentary/act` with `params.action`):

- **Status** in words: watching (and when the next look is), paused, waiting for the stage or the voice or a window,
  capturing, working out which game it is, reading the screen, commenting, or what is wrong.
- **Facts:** the window, whether the capture service runs, the game and how sure, the interval, comments so far, black
  pictures skipped, the last capture (sizes, brightness, method, how long ago), the last test picture.
- **Lists:** what is on the screen now, the story so far, the windows (each with a "Watch this" button).
- **Buttons:** `use_window` (a select fed by the service's list, and a text box for a name), `refresh` (read the
  list), `set_interval` (3 to 600 s; the pause in progress is measured again, no comment is made because of it; kept
  for later runs), `pause` / `resume`, `reidentify` ("Which game is this?": the next picture is used to identify
  it), `test` (a picture now, no model asked; shows the same facts as a capture), `clear_memory` (asks first; keeps
  the window and the interval).

`refresh` and `test` work whenever the capture service runs, also while the mode is off. The window list is read when
the panel is drawn if it is older than 10 s, and forgotten when the service is not running. The Enter button of the
Modes page starts the mode (`action: start`, also with `replace` and `force`).

## When something goes wrong

Nothing here holds the voice, sets a flag, changes the stage's look or draws an overlay, so a failure has nothing to
leave behind. Every alarm has subject `commentary`, is raised once (its words refreshed when they change), and is
withdrawn when its problem ends or the mode is left.

| Alarm | Level | Raised when | Goes when |
|---|---|---|---|
| `commentary_window` | info | the mode is on and no window is chosen | a window is chosen, or the mode is left |
| `commentary_capture` | warn | a capture failed: service not running, window not found, minimised, not responding, service answering nonsense | the next capture works |
| `commentary_black` | warn | `black_alarm_after` black pictures in a row | the first picture that is not black |
| `commentary_model` | warn | a model call failed (reading the picture, or asking for the comment) | the next comment works |
| `commentary_analysis` | warn | three answers in a row could not be read as what was asked for | the next readable answer |
| `mode_start_failed` (the mode manager's) | error | the service did not start, or the pack lacks a prompt file | the next start works |

- A **model failure** waits longer each time: the pause becomes `interval x 2`, `x 4`, and so on up to
  `max_backoff_sec`; the first comment that works ends it. Choosing another window ends it at once.
- A **capture failure** or a **black picture** is tried again after the normal interval: they cost nothing, and the
  operator who fixes the window should not wait out a back-off.
- An **unreadable answer** does not stop the commentary; the game memory just is not updated.
- A **failed story** is logged and its notes are kept for the next try; a **failed window list** is shown on the panel
  where the list would be. Neither raises an alarm.
- **Leaving the mode** (console, another mode, shutdown) aborts the capture and the model call in progress and does not
  wait for a comment that is being written; whatever the pass was doing is dropped, without an alarm for the abort.
  Entering again at once starts a new run; the cut-off one cannot change the memory.

Whether the *comment* call itself failed cannot be read from `host.tellBrain` (it resolves when the reply is written,
also when the model failed); the reading calls before it are what tells the mode the model is unreachable, and the
application's own `llm_failed` alarm covers the rest.

## Settings (`modes.commentary.config`)

Validated when the program starts; a wrong value or an unknown key stops it with the setting named.

| Key | Default | Bounds | Meaning |
|---|---|---|---|
| `interval_sec` | 8 | 3 to 600 | Seconds between the end of a comment's speech and the next look |
| `window` | none | 1 to 300 characters | The window to watch until one is picked on the panel (see "Naming a window") |
| `service` | `screencap` | a plugin id | The service name of the capture plugin. The pack's `requires.services` must name the same one; to use another, copy `modes/commentary/mode.yaml` to `config/modes/commentary/mode.yaml` and change it there |
| `capture_width` | 768 | 0, or 64 to 4096 | Width of the picture sent to the model, in pixels; 0 keeps the window's size |
| `capture_quality` | 80 | 30 to 95 | JPEG quality |
| `capture_method` | `auto` | `auto`, `printwindow`, `screen` | How the window's pixels are obtained (see the service) |
| `capture_timeout_sec` | 10 | 2 to 60 | How long the capture service may take to answer |
| `black_threshold` | 10 | 0 to 255 | A picture darker than this everywhere is black; 0 turns the check off |
| `black_alarm_after` | 3 | 1 to 100 | Black pictures in a row before the alarm |
| `reidentify_minutes` | 15 | 0 to 1440 | Identify the game again every so many minutes; 0 = never on a timer |
| `confidence_min` | 0.6 | 0 to 1 | Below this the game counts as "not sure" |
| `analysis_every` | 1 | 0 to 50 | Read the screen (notes, and the check for a switch) on every N-th comment; 0 = never |
| `summary_every` | 10 | 0 to 200 | Renew the story every N comments; 0 = no story |
| `summary_max_chars` | 300 | 100 to 1000 | The longest the story may be |
| `language` | `English` | 1 to 40 characters | The language game names, notes and the story are written in |
| `model_timeout_sec` | 30 | 5 to 180 | How long one of the mode's own model calls may take |
| `max_backoff_sec` | 120 | 10 to 3600 | The longest pause after model failures |

## The capture service (`plugins/screencap`)

A small loopback HTTP server, standard library and Pillow only, no GPU. The manifest is `runtime.type: process`,
`env: light`, `service: screencap`, `resources.gpu: false`, health at `/health`, polite stop by `POST /shutdown`. The
plugin has no settings of its own: everything below is asked per request.

**Why GDI through `ctypes` and not `ImageGrab`.** `PIL.ImageGrab` copies a rectangle of the screen, so whatever lies
over the game (the console, a chat window) is in the picture, and it cannot look at a window that is partly off the
screen. `PrintWindow` asks the window to paint itself, which works for a window behind others. So `auto` prints the
window first (`PW_CLIENTONLY | PW_RENDERFULLCONTENT`: the drawing area only, and windows drawn by the compositor,
browsers and most windowed games, come out right), and copies that window's rectangle from the screen (`BitBlt` with
`CAPTUREBLT`) when the printed picture is black, when `PrintWindow` failed, or when the program does not scale itself
to the display (see below). The service is made per-monitor DPI aware at start, or a scaled display (125%, 150%)
would crop the picture.

A program that is not DPI-aware on a scaled display is a real case, found in testing: Windows stretches its window
on screen, but `PrintWindow` gets the unstretched picture and it fills only the top-left part of a bitmap of the
real size. The service recognises such a window and uses the screen copy for it (in `auto`; `printwindow` says why it
refuses).

### Requests

Every request needs `Host: 127.0.0.1:<port>` (or `localhost`, `[::1]`) and must carry no `Origin` header, or it is
answered `403`: what this service returns is a picture of the operator's screen, so a web page (which sends
`Origin`, or reaches the port through a rebound name) gets nothing. It binds to `127.0.0.1` only and does not share
its port. Nothing is written to disk, and no request line (which holds a window title) is logged.

| Request | Answer |
|---|---|
| `GET /health` | `200` `{ok, ready, service, version, config: {grabber, dpi}}`; `503` with `detail` when capture cannot work here (not Windows, no desktop session) |
| `GET /windows` | `200` `{windows: [{id, title, process, width, height, minimized, overlay}], count}` |
| `GET /capture?window=...` | `200`, the JPEG as the body, described by headers |
| `POST /shutdown` | `200` `{ok: true}`, then the process ends |

`/windows` lists what a person could pick, top of the stacking order first: visible, not cloaked (other virtual
desktops, suspended store apps), not a tool window, without an owner (a dialog belongs to its program's entry) unless
it asks for a taskbar button, with a title, at least 16 x 16 pixels unless minimised, and not the desktop. `id` is a
decimal window handle as a string. `overlay` is a hint: the window is click-through, or topmost, layered and
non-activating (a game overlay, a streaming widget), which is almost never what to capture. `width` and `height` are
the drawing area, 0 when minimised.

`/capture` parameters (anything else is a `400`; a parameter given twice too):

| Parameter | Default | Meaning |
|---|---|---|
| `window` | required | A window id, part of a title, or `exe:<program>` (see "Naming a window") |
| `max_width` | 768 | 0 (keep the size) or 64 to 4096; never enlarges |
| `quality` | 80 | JPEG quality, 1 to 95 |
| `black_threshold` | 10 | 0 to 255 |
| `method` | `auto` | `auto`, `printwindow`, `screen` |

Headers of a `200` from `/capture` (`Content-Type: image/jpeg`; titles and program names are percent-encoded UTF-8):
`X-Window-Id`, `X-Window-Title`, `X-Window-Process`, `X-Source-Width`, `X-Source-Height` (the window's drawing area),
`X-Image-Width`, `X-Image-Height` (the JPEG), `X-Black` (`true` or `false`), `X-Brightness` (mean, 0 to 255),
`X-Peak` (the brightest cell of the thumbnail), `X-Method` (`printwindow` or `screen`), `X-Elapsed-Ms`.

**Black** means: on a 32 x 18 thumbnail (each cell is the average of a block, so a mouse cursor does not count) the
mean brightness is below `black_threshold` and no cell is above four times it. With the default: mean under 10, no
cell over 40. Exclusive-fullscreen games and some overlay windows give this. A black picture is still a `200`, marked.

Errors are `{error: {code, message, retryable}}` with a non-2xx status; the service never answers `200` with nothing:

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | A parameter is missing, unknown, out of bounds or not a number |
| 403 | `forbidden_host`, `forbidden_origin` | Not a loopback caller, or a web page |
| 404 | `window_not_found` (retryable), `not_found` | No visible window matches; no such path |
| 405 | `method_not_allowed` | Wrong method for the path (`Allow` says which) |
| 409 | `window_minimized`, `window_not_responding` (both retryable) | Restore it; the program is hung |
| 422 | `window_too_small` (retryable), `window_too_large` | Nothing to capture (under 8 x 8 pixels); more than 64 million pixels |
| 500 | `capture_failed` (retryable) | A Windows call failed; the message has the error code and, for `auto`, both methods' reasons |
| 503 | `busy` (retryable), `unsupported_platform` | The capture before this one has not finished in 10 s; not Windows |

Captures are done one at a time.

The client in the mode (`captureClient.ts`) uses plain `node:http` with a fresh connection (never a proxy from the
environment), checks that a `200` really is a JPEG with all its headers, and turns every failure into a `CaptureError`:
the service's own codes pass through, and it adds `service_down`, `timeout`, `aborted` and `bad_response`.

## Prompts

Files of `modes/commentary/prompts/`; an operator overrides one by putting the same name in
`config/modes/commentary/prompts/`. All are generic (no name of a character or a person: that lives in the persona).
A file the controller needs and the pack lacks stops the mode from starting, with the file named.

| File | Used for | Variables |
|---|---|---|
| `active.md` | Added to every reply while the mode is active (the manifest's `prompt:`) | `screen`, `progress` |
| `screen_known.md`, `screen_unsure.md` | The value of `screen`: the game is known, or not | `game`, `seen` |
| `seen.md`, `progress.md` | The value of `seen` (what was last seen) and of `progress` (the story) | `scene`, `summary` |
| `round.md` | The line that asks for a comment (a system message with the picture) | none |
| `identify.md`, `analyze.md`, `summarize.md` | The mode's own model questions | `game`, `scene`, `language`; `summary`, `scenes`, `limit` |

## What is different from the old setup

- The picture comes from a capture service that looks at one window, not from a screen share into the page; the page
  never captures anything.
- One reply with `[scene]` and `[switch]` lines became two model calls (see above); the switch is a field of the
  reading call, the scene a note in the memory.
- Viewers are not answered by cutting a comment off: a comment is never started while a viewer's reply is under way,
  and one that is ready when a viewer starts is dropped. The old page also stopped a comment that was being spoken.
- The reading of the screen while the character talks (the old "background analysis", off by default) is gone;
  `analysis_every` is what remains of it.
- The memory now survives a restart of the program (the old one, of the page, was lost on a page reload); it is still
  cleared only by the operator. The story is made from the notes on the screen, not from the comments, because the
  mode does not see what was said.
- The shortcuts for "identify again" and for the mode became panel buttons; the mode lists `ctrl+alt+g`.
- Nothing is drawn as the background of the stage; the game is composed in the streaming software.

## Limits and things to know

- **Windows only.** On another system the service starts and answers `503` on `/health` with the reason, so the plugin
  shows as failed instead of silently doing nothing.
- **Exclusive fullscreen** gives a black picture to any capture: switch the game to windowed or borderless. This is what
  `commentary_black` says. It was verified only against windows the tests make themselves (solid colours, a program that
  is not DPI-aware, a minimised and a closed window), not against real games.
- A window of a program running as administrator cannot be asked for its program name, and may refuse to be captured
  by a service that is not elevated. Not verified.
- The window must not be minimised, on another virtual desktop or hung; the service says which.
- Protected video (DRM) is black in any capture.
- **Privacy.** Only the chosen window is captured, not the screen; nothing is stored on disk; the pictures go to the
  model provider you configured, like any picture sent to a model. Window titles are shown on the console's panel and
  in its run log, which are for the operator and are not part of the stream. Do not choose a window with private
  content.
- The story is made from the model's readings of the screen, not from what the character said.
- A comment is not made when a viewer holds the voice; on a very busy chat the commentary is thin by design.
- The mode is exclusive with `dance`, `sing`, `draw`, `sleep` and `game` (priority 40); entering one of them, or
  `sleep`, which preempts everything, leaves it.

## Tests

```bash
# the service: unit tests with a fake grabber
C:/path/to/animatus/.venv/Scripts/python.exe -m unittest discover -s plugins/screencap -p "test_*.py"
# the mode
npx vitest run --project orchestrator test/modes test/app/commentary.test.ts test/plugins/screencap.test.ts
```

Two more tests are off unless the environment asks for them, because they need an interactive Windows desktop:
`ANIMATUS_SCREENCAP_LIVE=1` makes the unit-test command above also run `test_win32_live.py`, which opens a few small
windows of its own (solid colours, one from a program that is not DPI-aware) and captures only those;
`ANIMATUS_TEST_PYTHON=C:/path/to/python.exe` (a Python with Pillow) lets `test/plugins/screencap.test.ts` start the
real service under the real supervisor when the repository has no `.venv` of its own.

`test/modes/commentary*.test.ts` run the controller through the real mode service with a fake host, fake timers, a
scripted model and a fake capture service (in-process, or over a real socket for the client);
`test/app/commentary.test.ts` runs it inside the real application with a real stage server and a scripted page.

## Core change needed

Nothing is needed to run the mode. These would make it better; none was made here because they touch shared files.

1. `docs/modes.md` and `config.example/animatus.config.yaml`: add the mode to the list and the snippet from "Turn it on"
   (the config example already has room for `plugins.screencap` and `modes.commentary`).
2. `ModeHost.tellBrain` should resolve with how the reply ended (`done`, `failed`, `cancelled` and the number of
   sentences), so a mode can tell that the model failed to comment instead of inferring it from its own calls.
3. The console has to draw the panel: `select` inputs with `options`, sections whose rows carry buttons, `disabled` reasons
   and `confirm` text. Nothing here needs the panel's `image` field.
4. `releaseServices` stops a `process` plugin when the last mode that needs it is left, so the window list is empty
   between runs. A manifest flag to keep a cheap service running while it is enabled would let the operator pick the
   window before entering the mode.
5. `test/app/modes.test.ts` (dance end to end) assumed its pack was the only one in `modes/`; two assertions were
   changed to look for the dance view by id. Every new pack needs the same change.
