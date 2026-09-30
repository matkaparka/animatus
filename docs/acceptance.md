# Acceptance results

What was actually run against each phase's pass criteria, and what was not. Numbers come from runs on the
development machine (Windows 11, Chrome 154, NVIDIA GPU for speech, the stage window on the integrated GPU).

## P1: the stage

`npm run replay -w @animatus/orchestrator -- <scenario.json> --duration 1800`: the orchestrator's stage server
plus a real Chrome window in app mode (1280×720). The model is a 47 MB VRM 0 humanoid (44 blend shapes, 220
spring joints, four metres tall). Twenty prerecorded utterances are spoken in random order with motion tags, and
two dances start at 7 and 21 minutes.

| Check | Limit | Result |
|---|---|---|
| Utterances played | | 269, every one ended `done` |
| AudioContexts created | 1 | 1 |
| T-pose frames | 0 | 0 of 184,385 |
| Underruns | at most 3 per minute | 0 in 30.1 minutes |
| Stage disconnects | 0 | 0 |
| Dances | 2 | 2 completed, 0 failed |
| JS heap | not growing | 155 to 176 MB throughout |
| Frame time (p95) | | 16 to 17 ms |

Verdict: **PASS** after 30 min 06 s.

Also checked by eye in the same window: textures, blink, wLipSync vowel shapes (same-origin worklet and
WebAssembly, so the strict Content-Security-Policy holds), both dances with music and credit line, and the
camera fit for head, upper body and full body.

## P2: brain, speech scheduling, chat source

Evidence so far:

- **Router and pacer against the legacy chat bridge.** 1,300 random scripts (350,000 events, 9,800 pacer sends)
  were run through the legacy Python code and through the port: zero differences. A replay of one real day of
  the bridge's own log (538 chat messages, all timestamps taken from the log): 388 of 388 accept decisions and
  42 of 42 drop reasons identical, 108 of 108 song commands recognised, 174 of 178 sent batches identical text
  for text. The other four follow songs, whose end time is not in the log.
- **The whole chain with the real parts.** Real stage window, real GPT-SoVITS started by the plugin supervisor
  from the shipped manifest, a scripted stand-in for the model. Four audience events (three chat lines and a
  gift) became four batches in the legacy line format and eleven spoken sentences with emotion and motion tags.
  First sentence of a reply: 0.85 to 1.6 s after it was queued once the synthesiser is warm, and about 7 s for
  the very first one after start-up (the synthesiser compiles kernels on first use), which is why it is warmed
  up before it is attached and why the pacer holds the audience's messages until then.
- **With a real model.** The same chain with Gemini (`gemini-3.5-flash-lite` through the proxy the machine needs,
  `thinking_level: minimal`): four audience events, four replies (emotion and motion tags, subtitles, speech), no
  alarms. Time to the first visible text 1.6 to 3.1 s, whole reply 1.7 to 3.2 s. The legacy stream's own round
  logs (1,231 replies, same model) show a median of 2.0 s to first text (p90 3.5 s) and 2.4 s in total (p90 4.0 s),
  so the new path is in the same range on this small sample. The first attempt failed loudly with HTTP 400: the
  Gemini 3 family rejects `thinkingBudget: 0`; the alarm now carries the provider's own words and there is a
  `thinking_level` setting.
- **Automated tests** cover the app end to end with a real stage server and a scripted page, including the
  failure paths: model failure, one sentence that cannot be synthesised, stage disconnect, no model provider,
  missing key, speech service warming up, speech service that stops answering.
- **A 30-minute chat soak through the whole chain.** Forty scripted lines from ten made-up viewers, one every
  10 to 25 seconds, through router, pacer, the real Gemini model (`gemini-3.5-flash-lite`), real GPT-SoVITS started
  by the supervisor, and a real Chrome stage window with the 47 MB model. Verdict: **PASS** after 30.8 minutes.

  | Check | Limit | Result |
  |---|---|---|
  | Audience lines in / model replies | | 100 in (some merged, as designed), 91 replies completed, 0 failed, 0 cancelled |
  | Sentences spoken | | 270 |
  | Time to the first visible text | | median 1.7 s, p90 2.6 s |
  | Speech synthesis per sentence (median) | | 1.5 s |
  | T-pose frames | 0 | 0 of 242,092 |
  | Underruns | at most 3 per minute | 0 in 30.8 minutes |
  | AudioContexts | 1 | 1 |
  | Stage disconnects / stage alarms | 0 | 0 / none |
  | Orchestrator memory growth | under 300 MB | +16 MB (100 to 111 MB) |
  | Stage frame rate | | 104 to 155 fps, JS heap 143 to 174 MB |

  One caveat: the very first attempt at a whole-chain run (before the synthesiser was warmed up and before the
  45-second request timeout and the restart watchdog existed) stalled after its first reply; the speech server
  was found unhealthy 23 seconds in. It did not reproduce on the following runs, including this one, and its cause
  is not known. The mitigations are in, and the alarm says so if it happens again.
- **The console** runs over the real application (`npm start` prints its address once), and is covered by tests
  of the backend against a real app.

Not yet done: nothing for P2.

## P3: modes

- **The mode framework** (state machine, admission by measured memory, exclusions and priorities, mode packs
  read from folders, controllers with a narrow host, the console's Modes page) is covered by unit tests of the
  manager, the admission matrix, the pack loader, the measurement file, the service (views, refusals, prompts,
  hooks) and the dance controller against a fake host and stage; and end to end through the whole application
  with a real stage server and a scripted page.
- **Dance.** End to end: a dance gift gives the model the line "you are about to dance", the reply is spoken, the
  dance plays with the voice held, the model is told and says a closing line, and chat that arrived meanwhile is
  answered after it, in that order; the model's own `[motion:dance:name]` tag; the cooldown (prompt and gift
  answers change, the console is exempt); a stop from the console (no closing line, cooldown starts); a stage that
  cannot load the dance (alarm with the stage's words, nothing left held); a shutdown mid-dance and one while a dance
  is waiting for the reply to finish. The tests found four faults that were fixed: a dance that ended by itself was
  treated as cut short, so the closing line was never said; the saved state could be overwritten by a read that
  finished late; two writes to the same state file could interleave; and stopping a mode that was still starting
  waited for the start to time out.
- **Not yet measured or not yet done:** dance against the real stage window (the stage's own dance code has its
  own tests and was seen in the P1 run); the other modes (sleep, sing, draw, commentary, game) have no controller
  yet; the console has no dance list or tuning panel yet (the API for both exists).

## P0

VRAM measurements are in [vram-measurements.md](vram-measurements.md).
