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

## Adapters

Adapters run inside the orchestrator and receive an `AdapterContext` (base URL, config, the secrets the
manifest asked for, an abort signal, a logger). Interfaces per kind live in `plugin.ts`
(`TtsAdapter`, `MotionAdapter`, ...). A TTS adapter streams PCM16 and **throws** on failure; it must not
yield silence.

## Environments

Python services run from one of two uv dependency groups (`pyproject.toml`): `light` (no torch) and
`audio` (torch, CUDA 12.8). The groups conflict on purpose and never share an environment. Speech
synthesis (GPT-SoVITS), Forge Neo, Applio and the game MCP servers keep their own environments and are
referenced by path from the configuration (`runtime.env: external`).
