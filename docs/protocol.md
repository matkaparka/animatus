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
`sing.state`, `sleep.state`, `stats`, `error`, `debug.reply`, `pong`.

`playback.ended` carries the reason (`done`, `cancelled`, `error`, `timeout`, `audio_suspended`,
`superseded`) and the number of buffer underruns. `stats` includes the counters the soak test checks:
`audio_contexts_created`/`open`, `underruns_total`, `tpose_frames`, `frames_total`.

## Timing rules the stage follows

- One audio clock: the stage's `AudioContext`. Dance, song and captions are positioned on it, offset by
  the output latency, so motion and lyrics line up with what is heard rather than what was scheduled.
- Speech is played through a jitter buffer with a short pre-roll; after an underrun it re-synchronises
  instead of drifting.
- If the `AudioContext` cannot run, an utterance still completes (reason `audio_suspended`) so the
  pipeline never stalls waiting for a sound that will not come.
- Dance and song hold back spoken utterances until they finish.
