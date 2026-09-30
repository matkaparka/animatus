# AGENTS.md

Instructions for coding agents (Claude Code, Codex, ...) and humans working on this repository.

## What this is

Animatus: an AI VTuber runtime split into an orchestrator (TypeScript), an empty VRM stage, a separate
console, and plugin services. Read `README.md` for the picture and `docs/` for the contracts. The
contracts live in code as zod schemas in `packages/protocol/src`; the docs explain them.

## Layout

```
packages/protocol/      shared types and schemas: stage protocol, plugin/mode manifests, events, tools
packages/vram-probe/    Windows per-process GPU memory recorder (runs with plain Node, no build)
packages/orchestrator/  the brain, mode manager, plugin supervisor, servers
packages/stage/         Vite + three.js stage page (no React)
packages/console/       console UI
plugins/<id>/           plugin.yaml manifest + adapter (+ service code if the plugin ships any)
modes/<id>/             mode.yaml manifest + Markdown prompts
personas/example/       generic example persona
config.example/         example configuration; copy to ./config (git-ignored)
tools/secret-scan/      pre-commit scanner
docs/                   protocol, plugins, modes
```

## Commands

```bash
npm install                  # also points git at .githooks
npm test                     # vitest, all packages
npx vitest run --project protocol
npm run typecheck            # tsc --noEmit per package
npm run secret-scan          # scan tracked and untracked files
uv sync                      # light Python group
```

Run TypeScript files directly with Node 24 (`node file.ts`) or `tsx`. Packages that are executed
without a build (`vram-probe`) must stick to *erasable* TypeScript: no `enum`, no constructor
parameter properties, no `namespace`; use `import type` and explicit `.ts` import extensions.

## Rules that are not negotiable

1. **No secrets, no personal data, no assets in the repo.** API keys, cookies, `.env` files, 3D models
   (`.vrm`), motions (`.vrma`), music and weights are git-ignored on purpose. Tests build fixtures in
   code or read paths from environment variables. The pre-commit hook runs `tools/secret-scan`; do not
   bypass it. If it flags a real false positive, add the path to `.secretscanignore`.
2. **The orchestrator is the only secret holder.** Secrets are injected into plugin processes as
   environment variables, and only the ones a plugin's manifest lists. The stage and the console
   frontend never see a secret. Never put a secret in a `NEXT_PUBLIC_`-style browser-visible variable.
3. **The stage is empty and stateless.** It renders, plays audio, plays motion and reports playback.
   No settings UI, no hotkeys, no local input, no decisions. Its WebSocket is a closed set of
   reports upstream; it can never send commands. Text shown on the stage is rendered with
   `textContent`, never as HTML.
4. **Viewer text is untrusted input.** It carries `trust: 'untrusted'` and may only trigger `free`
   tools. Approval-tier tools can only be requested by moderator or host sources, and the host
   approves in the console. See `packages/protocol/src/tools.ts` (`decideTool`).
5. **Only bind to 127.0.0.1.** Console requests carry the per-launch token and are Origin-checked.
   The stage page cannot obtain the token.
6. **Plugins never call each other.** Everything goes through the orchestrator.
7. **Failures are loud.** A service that fails real work returns a non-2xx status with a
   `ServiceError` body. Never answer 200 with empty or silent output, and never swallow an error and
   report health as ok.
8. **Public text stays generic.** README, this file, docs, the example persona and commit messages must
   not name a private character, private paths, or a specific person's setup.

## Conventions

- TypeScript strict, ESM, no semicolons, single quotes, 2-space indent (see `.prettierrc.json`).
- Prefer small pure modules with unit tests next to the package (`test/`). Anything time-based takes an
  injectable clock.
- Protocol changes: additive fields keep `PROTOCOL_VERSION`; breaking changes bump it. Update the zod
  schema, the tests in `packages/protocol/test`, and `docs/protocol.md` together.
- Estimates that were never measured are marked as such in manifests (`vram_mb_est: null`) and the UI
  says "not measured". Do not invent numbers.

## Windows notes

- Windows PowerShell 5.1 reads BOM-less `.ps1` files as the ANSI code page. Keep `.ps1` files ASCII
  only and load any non-ASCII text from a UTF-8 file with `-Encoding UTF8`.
- Some environments set `NoDefaultCurrentDirectoryInExePath=1`, which makes `call other.bat` (relative
  name) fail. When starting a user-supplied launcher, use absolute paths or remove that variable from
  the child's environment.
- `Get-Counter -Continuous` freezes its instance list at start. The probe rebuilds its PDH query on
  every sample so processes that start later are seen.
- On hybrid-GPU laptops the browser may render on the integrated GPU; the probe reports memory per
  adapter and picks the NVIDIA adapter as the budget by default.
