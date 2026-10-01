# Animatus

Animatus is a free, non-commercial AI VTuber runtime. It replaces the all-in-one browser page that
most AI-streamer setups grow into with three separate parts:

- an **orchestrator** (TypeScript, Node) that owns the brain: chat events in, LLM, sentence
  splitting, tags, speech scheduling, modes, memory, tools, secrets;
- an **empty stage** (Vite + three.js + `@pixiv/three-vrm`): a page that only renders a VRM model,
  plays audio with lip sync, plays motion and reports what it played. It has no settings, no menus and
  no keyboard shortcuts, so it can be captured on stream without exposing any controls;
- a **console**, opened in a normal browser window, where everything is configured and approved.

Heavy models (speech synthesis, image generation, motion generation, singing) run as **plugins**:
separate processes the orchestrator starts, health-checks and calls. Plugins never talk to each other.

```
 chat platform          stage (empty)                       console (separate window)
      │ events              ▲ content and commands              ▲ config, approvals, memory editor
      ▼                     │ WebSocket (reports only upstream) │ HTTP / WebSocket, start-up token
 ┌────────────────────── orchestrator (TypeScript) ──────────────────────┐
 │ event bus · brain · speech scheduler · mode manager · tools · memory  │
 │ plugin supervisor (start / health / restart)                          │
 └───────────────────────────────────┬───────────────────────────────────┘
                                     │ the only way to reach a plugin
           speech synthesis · motion · image generation · singing · game workers
```

## Try it

Windows 10/11 and Node.js 24+. You bring a `.vrm` model, a model key (Gemini or any OpenAI-compatible server) and a
GPT-SoVITS install for the voice; the program ships none of them.

```bash
npm install
npm run build
npm run setup      # a few questions, then a working configuration
npm run doctor     # checks that everything is in place
npm start          # prints the address of the console
```

[`docs/getting-started.md`](docs/getting-started.md) walks through it, up to the first spoken answer and what to do when
something is wrong.

## Status

Under development, run by its author. Working today:

| Part | State |
|---|---|
| Stage | An empty page that renders the VRM, plays the voice with lip sync, motion and a relaxed built-in pose, subtitles, credits, lyrics and picture frames. |
| Orchestrator | Chat in, model, sentence cutting and tags, speech scheduling, memory, tools with a tool gate and approvals, automations, a safety check before the voice. |
| Modes | Dance, sing, sleep, draw, commentary and game; game agents speak one protocol. |
| Console | Run, plugins, modes, approvals, memory editor, settings, keys. |
| Release | First-run setup, doctor, secret scan, asset scan, licence audit. |

What has not been tried against the real thing is listed in [`docs/acceptance.md`](docs/acceptance.md).

## Repository contents

This repository ships an empty program: **no API keys, no 3D models, no motion or music files, no
character persona.** You bring your own. `personas/example/` is a generic example only.

The sing mode can look songs up through a NetEase API server that you run yourself, with your own account. The repository
ships no songs, no vocals and no such server, and what you may do with them is yours to check: read
[songs and rights](docs/mode-sing.md#songs-and-rights) first.

## Development

```bash
npm install          # workspaces, installs the git hooks
npm test             # unit tests for all packages
npm run typecheck
uv sync              # light Python group (services without torch); only some plugins need it
```

GPU memory probe (records per-process dedicated VRAM once per second):

```bash
node packages/vram-probe/src/cli.ts adapters
node packages/vram-probe/src/cli.ts record --label my-run
node packages/vram-probe/src/cli.ts mark "enter:draw"     # from another terminal
```

See [`docs/`](docs/) for the stage protocol, the plugin contract and mode packs, and
[`AGENTS.md`](AGENTS.md) for conventions when working on the code (also for coding agents).

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). Source-available, not open source in the OSI sense:
you may use, modify and share it for non-commercial purposes. Third-party components keep their own
licenses, see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Required Notice: Copyright 2026 matkaparka (https://github.com/matkaparka)
