# Stage protocol v1

Source of truth: `packages/protocol/src/stage.ts` (schemas), `binary.ts` (media frames). This page
explains the intent. The stage opens one WebSocket to the orchestrator (`/stage` on the stage port,
subprotocol `animatus.stage.v1`). JSON control frames are text frames; media is binary.

## Principles

- The stage is **empty and stateless**: it renders, plays audio, plays motion and reports playback.
  Reloading the page loses nothing, because the orchestrator re-sends every snapshot on connect.
- Downstream messages are either **snapshots** (idempotent, re-sent on reconnect) or **commands**
  (not re-sent).
- Upstream is a **closed set of reports**. The orchestrator validates every upstream frame with
  `StageUpstream`; anything else is dropped. A stage cannot send commands, and it never holds a secret.
- Big files travel as **asset URLs** (`/asset/...`, same origin, no dot segments) that the stage fetches
  over HTTP. Only per-utterance audio and live-generated VRMA travel as binary frames.
- Text on the stage is rendered with `textContent`.

## Connection

1. Stage → `hello` (protocol, stage id, user agent, capabilities).
2. Orchestrator → `welcome` (session id, epoch, `dev` flag), then the snapshots: `scene.set`,
   `library.set`, `look.set`, `tuning.set`, `overlay.set` for each overlay.
3. From then on: commands downstream, reports upstream. `ping`/`pong` for liveness.

## Downstream

| Type | Kind | Purpose |
|---|---|---|
| `scene.set` | snapshot | Model URL, layout (character offset/scale, drawing frame), background, lighting, camera. The model reloads only when its URL changes. |

| `library.set` | snapshot | Idle base pose, idle variants, talk clips (mirrored variants are derived on the stage). |
| `look.set` | snapshot | Calm look: light multiplier, mouth scale, calm 0..1, motion scale, lip-sync range, night dim. |
| `tuning.set` | snapshot | Optional overrides of motion / procedural-layer constants. Unknown keys ignored. |
| `overlay.set` | snapshot | `credit`, `lyrics`, `subtitle`, `frame`, `notice`. Lyrics and sleep captions are timed by the stage from the audio clock; this only toggles them. |
| `utterance.begin` | command | Starts one spoken sentence: ids, `seq`, `handle`, emotion, optional body motion (already resolved to a clip URL), `live_motion` flag, PCM16 format, optional subtitle. |
| `utterance.cancel` | command | Cancel one utterance or everything, with a short fade. |
| `motion.play` | command | One-shot body motion outside an utterance. |
| `dance.play` / `dance.stop` / `dance.tune` | command | A dance: motion + music aligned on the audio clock, with offset and speed. |
| `sing.play` / `sing.stop` | command | Vocals + instrumental tracks and lyrics. Lip sync follows the vocals only. |
| `sleep.play` / `.pause` / `.resume` / `.stop` | command | Long whisper track played from a URL, with a caption timeline. |
| `debug.request` | command | Dev only (`welcome.dev`). Fixed operations, no code execution. |
| `ping` | command | Liveness. |

## Camera

`scene.set.camera` is either fixed numbers (`position`, `target`, `follow_head`) or a fit by the model's own
measured size: `fit: head | upper_body | full_body`. A model made at any scale (the one this stage was built
against is four metres tall) is then framed the same way: after the model appears in its idle pose the stage
measures the head joint, the hips and the ankles and puts the camera straight in front, far enough that the
chosen part and its width fit, re-fitting when the window's shape changes. `fit` other than `none` takes over
`position`, `target` and `follow_head`. A re-sent `scene.set` keeps the measurement, so the camera does not
jump when the orchestrator reconnects.

### The mouse

The stage window is the one place the operator can frame the shot by hand, as in the legacy viewer: left drag
orbits, right drag (or shift/ctrl + left drag) pans, the wheel and middle drag zoom, a double click starts
over. The pointer is a grab hand over the stage. The result is a `CameraAdjust` (yaw, pitch, zoom, pan) that is
*relative* to the pose the configuration gives, so it stays meaningful when the model, its size or the window
changes. When a gesture ends the stage reports it (`camera.adjusted`); the orchestrator keeps it in
`data/stage-state.json` and echoes it in `scene.set.camera.adjust`, so it survives a page reload and a
restart. `camera.locked: true` makes the stage ignore the mouse (a composition that must not move by
accident during a broadcast). An adjustment made while the stage is disconnected is not kept.

## Spoken subtitle

`utterance.begin.subtitle` is shown on the `subtitle` overlay from the moment that sentence starts to sound
until the next one replaces it, and stays about two seconds after the last one (a cut-off sentence takes its
words with it). The overlay is switched on and styled by `overlay.set` for `subtitle`: `variant` is `bubble`
(rounded translucent box) or `plain` (bare words with a shadow), and `text` is an optional name badge above the
words. The orchestrator fills the subtitle with the sentence as written (motion and emotion tags removed) and
applies the same sensitive-word replacement as for the voice.

## Lip sync profile

If the orchestrator serves a library named `lipsync`, the stage loads `/asset/lipsync/profile.json` (a wLipSync
vowel profile) and estimates a/i/u/e/o from the audio it is playing. Without the file, or if the worklet cannot
start, it falls back to an amplitude-driven single open mouth and reports nothing worse than that.

## Binary frames

16-byte little-endian header, then payload.

| Offset | Size | Field |
|---|---|---|
| 0 | 2 | magic `A` `N` |
| 2 | 1 | version (1) |
| 3 | 1 | kind: 1 audio (PCM16 LE mono), 2 vrma |
| 4 | 4 | handle (from `utterance.begin`) |
| 8 | 4 | chunk index |
| 12 | 1 | flags, bit 0 = last |
| 13 | 3 | reserved |

A VRMA stream completes before that utterance's audio starts. An audio stream always ends with a
`last` frame, possibly empty. Frames for an unknown or cancelled handle are dropped.

## Upstream reports

`hello`, `model.state`, `audio.state`, `playback.started`, `playback.ended`, `dance.state`,
`sing.state`, `sleep.state`, `stats`, `error`, `debug.reply`, `pong`, `camera.adjusted`.

`playback.ended` carries the reason (`done`, `cancelled`, `error`, `timeout`, `audio_suspended`,
`superseded`) and the number of buffer underruns. `stats` includes the counters the soak test checks:
`audio_contexts_created`/`open`, `underruns_total`, `tpose_frames`, `frames_total`.

## Well-known asset paths

The protocol has no message for these; the stage looks for them at fixed URLs and degrades if they are missing.

| Path | What | If missing |
|---|---|---|
| `/asset/lipsync/profile.json` | A wLipSync profile (JSON) for vowel estimation | The mouth follows volume only, and the stage reports an `error` with code `lipsync_profile_missing`. |

The orchestrator maps the `lipsync` asset library to a folder that contains `profile.json`.

## Timing rules the stage follows

- One audio clock: the stage's `AudioContext`. Dance, song and captions are positioned on it, offset by
  the output latency, so motion and lyrics line up with what is heard rather than what was scheduled.
- Speech is played through a jitter buffer with a short pre-roll; after an underrun it re-synchronises
  instead of drifting.
- If the `AudioContext` cannot run, an utterance still completes (reason `audio_suspended`) so the
  pipeline never stalls waiting for a sound that will not come.
- Dance and song hold back spoken utterances until they finish.
