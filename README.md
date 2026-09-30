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

## Status

Early development. What exists today:

| Part | State |
|---|---|
| `packages/protocol` | Stage protocol v1, plugin manifest, mode manifest, event bus types, tool tiers. Tested. |
| `packages/vram-probe` | Per-process GPU memory recorder for Windows, with marks and summaries. Tested. |
| `tools/secret-scan` | Pre-commit secret and privacy scanner. |
| `packages/stage`, `packages/orchestrator`, `packages/console` | In progress. |

## Repository contents

This repository ships an empty program: **no API keys, no 3D models, no motion or music files, no
character persona.** You bring your own. `personas/example/` is a generic example only.

## Development

Requirements: Windows 10/11 (the GPU probe and process supervision are Windows-specific for now),
Node.js 24+, [uv](https://docs.astral.sh/uv/).

```bash
npm install          # workspaces, installs the git hooks
npm test             # unit tests for all packages
npm run typecheck
uv sync              # light Python group (services without torch)
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
