# Mode packs and VRAM arbitration

Source of truth: `packages/protocol/src/mode.ts`. Each feature that takes over the stream for a while
(dance, sing, sleep, draw, commentary, game, ...) is a mode pack; the mode manager is the only thing that
enters and leaves modes.

```
modes/<id>/mode.yaml
modes/<id>/prompts/*.md
```

```yaml
id: draw
title: Draw on request
requires:
  services: [tts, motion, forge]
  vram_mb_est: null            # measured by the probe, then written to the measurement store
exclusive_with: [sing, game, sleep, reaction]
priority: 50                   # sleep is 100 with preempts: true
prompt: prompts/draw.md        # loaded on enter, dropped on exit
tools: [draw_image]
triggers:
  hotkey: ctrl+alt+p           # shown as a shortcut on the console's mode page
  danmaku_prefix: ["draw", "/draw"]
stage:
  layout: frame
  background: drawing_frame
```

## State machine

`IDLE → STARTING (start services) → ACTIVE → STOPPING (unload, wait for VRAM to fall back) → IDLE`.
Any step that times out returns to `IDLE` and raises an alarm.

## Admission (configuration-driven, not hard-coded)

1. At start-up, and after any plugin setting changes, read the relevant settings (image service maximum
   long side, checkpoint architecture, hires, LoRA count; speech synthesis precision; local LLM model and
   context length).
2. Estimate each mode's VRAM from **probe measurements** keyed by service and a hash of those settings.
   A setting combination that was never measured uses a conservative value and is shown as
   "not measured".
3. Compute whether each mode fits alone and whether each pair fits together, giving a compatibility
   matrix. Modes that do not fit are greyed out in the console with the reason.
4. The matrix recomputes immediately when a setting changes; no restart.

The resident set is the stage's WebGL (on hybrid-GPU machines the browser may sit on the integrated GPU
and cost the discrete card nothing), the speech synthesizer, and the motion service (no VRAM).

## Measuring

`packages/vram-probe` records dedicated GPU memory per process once per second and attributes it to
roles. Marks `enter:<mode>` and `exit:<mode>` define a window; the summary reports the peak and steady
cost above the level just before the window, and whether memory fell back afterwards.

```bash
node packages/vram-probe/src/cli.ts record --label draw \
  --role "forge=cmd:launch.py" --role "stage=cmd:my-profile-dir"
node packages/vram-probe/src/cli.ts mark "enter:draw"
node packages/vram-probe/src/cli.ts mark "exit:draw"
node packages/vram-probe/src/cli.ts stop
node packages/vram-probe/src/cli.ts summarize probe-out/draw-<stamp>.jsonl \
  --window enter:draw..exit:draw --key forge --config-hash <hash> --write-measurement data/vram-measured.json
```
