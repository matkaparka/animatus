# @animatus/vram-probe

Records **dedicated GPU memory per process, once per second**, on Windows, and attributes it to roles
(speech synthesis, image generation, stage, ...). It is the first deliverable of the VRAM arbitration
work: every estimate in a manifest is meant to be replaced by something this tool measured.

## Why it reads performance counters

`nvidia-smi --query-compute-apps` returns nothing for WDDM processes on Windows, so per-process numbers
come from the `GPU Process Memory` and `GPU Adapter Memory` performance counters (the data Task
Manager shows), read through PDH by `src/collector.ps1`. `nvidia-smi` is used only to cross-check the
adapter total.

Two details that matter:

- A PDH query is rebuilt on **every sample**. `Get-Counter -Continuous` freezes its list of instances at
  start, so processes launched during the recording would never appear.
- Adapters come from DXGI, so the probe knows which LUID is which card. On hybrid-GPU laptops the
  browser can render on the integrated GPU; the probe reports that memory separately (`off-target`)
  and budgets against the NVIDIA adapter by default (`--luid` overrides).

## Use

```bash
node packages/vram-probe/src/cli.ts adapters
node packages/vram-probe/src/cli.ts record --label draw-test \
     --role "forge=cmd:launch.py" --role "stage=cmd:my-profile-dir"
node packages/vram-probe/src/cli.ts mark "enter:draw"      # from another terminal
node packages/vram-probe/src/cli.ts mark "exit:draw"
node packages/vram-probe/src/cli.ts stop
node packages/vram-probe/src/cli.ts summarize probe-out/draw-test-<stamp>.jsonl
```

`record` writes `probe-out/<label>-<stamp>.jsonl` (meta, one sample per second, marks, process table)
and a `.csv`, prints a line every 5 s, and on Ctrl+C prints a summary. Marks can also be typed on stdin
or POSTed to the control port (default 8777, loopback only).

### Roles

A role is a list of rules; a rule matches on image name (`name:chrome.exe`), command-line substring or
regex (`cmd:launch.py`, `cmd:/--app=.*5810/`), or a pid. All fields inside one rule must match. A
process without a rule inherits the role of its nearest ancestor that has one, so worker processes and
Chrome's GPU process (whose command line lacks `--app`) still land on the right role. Anything
unmatched is `other`. Built-in defaults: `gpt-sovits`, `forge`, `stage` (a browser profile directory
containing `animatus-stage`), `motion`, `llm`.

### Marks: enter/exit windows

Marks named `enter:<x>` and `exit:<x>` define a window. The summary reports, relative to the median of
the five samples before the window: peak and steady growth (what mode `<x>` costs), the same per role,
and the level after the window closes (it should fall back to roughly zero; if not, something did not
unload).

`summarize ... --window enter:x..exit:x --key <service> --config-hash <hash> --write-measurement
data/vram-measured.json` stores the result in the shape the admission check reads
(`VramMeasurement` in `@animatus/protocol`).

## As a library

```ts
import { VramProbe } from '@animatus/vram-probe'
const probe = new VramProbe({ roles, outDir: 'data/vram' })
await probe.start()
probe.mark('enter:draw')
// ...
probe.mark('exit:draw')
await probe.stop()
```

## Tests

`npx vitest run --project vram-probe`. The end-to-end tests drive `VramProbe` with a scripted
collector (`test/fake-collector.mjs`) that speaks the same JSON-lines protocol.
