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
- **Automated tests** cover the app end to end with a real stage server and a scripted page, including the
  failure paths: model failure, one sentence that cannot be synthesised, stage disconnect, no model provider,
  missing key, speech service warming up, speech service that stops answering.

Not yet done:

- A run with a real language model (needs the operator's key in `config/.env` or the console).
- The console wired to the real backend (the server and UI exist and are tested against a fake one).
- A 30-minute chat soak through the whole chain.

## P0

VRAM measurements are in [vram-measurements.md](vram-measurements.md).
