# Plugins

Source of truth: `packages/protocol/src/plugin.ts`. A plugin is a service the orchestrator starts,
health-checks, restarts and stops, and calls through an in-process TypeScript adapter. Plugins never call
each other.

```
plugins/<id>/plugin.yaml     manifest
plugins/<id>/adapter.ts      adapter implementing the interface of the plugin's `kind` (optional)
plugins/<id>/...             service code, if the plugin ships any
```

## Manifest

```yaml
id: forge                      # lowercase kebab
title: Image generation
kind: image                    # tts | motion | image | singing | game | music-source | search | llm | custom
service: forge                 # name modes use in requires.services (defaults to id)
provides: [image.txt2img]

runtime:
  type: process                # process | external (user starts it) | inprocess (adapter only)
  env: light                   # light | audio | external | node | native  (where the interpreter comes from)
  command: ["{python}", "service.py", "--port", "{port}"]
  cwd: "{plugin_dir}"
  port: auto
  env_vars: {}
  guard: true                  # run under the job-object guard: children die with the orchestrator
  stop: { http: { method: POST, path: /shutdown }, grace_ms: 5000 }

health:
  http: { path: /health }      # 200 + {ok:true, ready:true} means usable
                               # ready_field: null  -> only the status code counts (third-party servers with
                               #                       no health endpoint, probed with an HTML page)
  start_timeout_ms: 120000
  interval_ms: 5000
  fail_threshold: 3

restart: { policy: on-failure, max_restarts: 3, backoff_ms: [1000, 5000, 15000] }

resources:
  gpu: true
  vram_mb_est: null            # null = never measured; the console says "not measured"
  ram_mb_est: null

secrets:                       # only these are injected, as environment variables
  - { name: gemini, env: GEMINI_API_KEY }
```

Placeholders in `command`, `cwd` and `env_vars`: `{port}`, `{python}`, `{plugin_dir}`, `{data_dir}`,
`{config.<key>}`, `${secret:<name>}`, `${config:<key>}`.

- `{python}` is the interpreter of `runtime.env`; for `external` it is the plugin's own `config.python`.
- `${secret:<name>}` is accepted in `env_vars` **only** (a command line is visible in the process list),
  and only for names listed under `secrets`.
- The strings are checked strictly: an unknown placeholder, a config key that is not set or an
  unterminated brace is an error that names the placeholder and never contains a resolved value.
  `{{` and `}}` are literal braces.
- For `runtime.type: external`, `url` may use `{config.<key>}`; after substitution it must be an http(s)
  URL (this is how "use the speech server that is already running" takes its address from the settings).

Two plugins can offer the same service name (GPT-SoVITS started by Animatus, and GPT-SoVITS that is
already running); at most one of them may be enabled.

`config_schema.required` lists the settings a plugin cannot start without. A plugin whose required setting is
missing, empty, and without a `default` in the schema is not started; it stays `failed` with
`plugins.<id>.config.<key> is not set: <what it is for>`, and `npm run doctor` reports the same before the first start.

The job guard (`guard: true`) is a standard-library Python script. It runs on the shared `light` environment when that
is installed (`uv sync`), and otherwise on the plugin's own interpreter (`config.python` for `runtime.env: external`),
so a basic install with GPT-SoVITS does not need `uv`. Python 3.7 or newer will do.

Notes for people who write plugins:

- A service that is `external` and down past its start timeout stays `failed` until it is started again
  from the console; the orchestrator does not poll forever.
- Secrets are decrypted (DPAPI) in a PowerShell child that receives the values on stdin. If your machine
  has PowerShell script-block or module logging switched on by policy, that log can contain the plain
  text; leave those off on the streaming machine or use `config/.env` instead.

## Service contract

Every supervised service answers on its health path:

| Response | Meaning |
|---|---|
| `200` + `{ok:true, ready:true, service, ...}` | working |
| `200` + `{ok:true, ready:false}` | process alive, still loading |
| `503` + `{ok:false, ...}` | alive but broken |

Real failures (a synthesis, a generation, a download) return a non-2xx status with
`{error:{code, message, retryable}}`. **Never 200 with empty or silent output.**

`ServiceHealth.config` can carry effective settings worth showing in the console (for example the
image service's maximum long side), and `POST /config` on a service is how the console changes a
setting that must survive a restart.

## Plugins that ship

| Plugin | Kind | What |
|---|---|---|
| `gptsovits`, `gptsovits-attach` | speech | GPT-SoVITS started by the program, or one already running |
| `singing` | custom | keeps the song queue and prepares each song: finds it, separates the vocals, converts the voice, mixes; the sing mode's service ([mode-sing.md](mode-sing.md)). It starts with the program, not with the mode, because it holds the queue |
| `forge` | image | asks your own Forge (Stable Diffusion WebUI) for a picture under a strict rating policy; the draw mode's service ([mode-draw.md](mode-draw.md)) |
| `screencap` | capture | copies one window as a picture for the commentary mode; Windows only, loopback only ([mode-commentary.md](mode-commentary.md)) |

## Adapters

Adapters run inside the orchestrator and receive an `AdapterContext` (base URL, config, the secrets the
manifest asked for, an abort signal, a logger). Interfaces per kind live in `plugin.ts`
(`TtsAdapter`, `MotionAdapter`, ...). A TTS adapter streams PCM16 and **throws** on failure; it must not
yield silence.

## Environments

Python services run from one of two uv dependency groups (`pyproject.toml`): `light` (no torch) and
`audio` (torch, CUDA 12.8). Install [uv](https://docs.astral.sh/uv/) and run `uv sync` in the repository folder to create
the light one (`.venv`), which the plugins that say `env: light` (image generation, screen capture, the game demo)
need. Chat with GPT-SoVITS does not need it. The groups conflict on purpose and never share an environment. Speech
synthesis (GPT-SoVITS), Forge Neo, Applio and the game MCP servers keep their own environments and are
referenced by path from the configuration (`runtime.env: external`).
