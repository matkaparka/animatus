# VRAM measurements

Measured with `packages/vram-probe` (per-process dedicated GPU memory, 1 Hz). These are the numbers the
admission check starts from; anything not listed here is *not measured* and the console says so.

## Machine

| | |
|---|---|
| Discrete GPU | NVIDIA GeForce RTX 5070 Ti Laptop, 11944 MiB dedicated (12 GB class) |
| Integrated GPU | AMD Radeon 610M (hybrid-graphics laptop) |
| Date | 2026-09-30 |
| Desktop / other apps | Nothing else on the discrete GPU: it reported 0 MiB before the run |

## Run 1: all three at once

Order: stage stand-in (Chrome, WebGL page) → GPT-SoVITS started and given one synthesis → Forge Neo
started and given one image → teardown in reverse order. Marks bracket each step.

| Component | Setting | Idle (loaded) | Peak while working | Notes |
|---|---|---|---|---|
| GPT-SoVITS `api_v2` | v2Pro, fp16, CUDA, streaming off | **2760 MiB** | 3054 MiB | Peak is a two-sentence synthesis (about +300 MiB over idle). One request took 4.8 s (first was 6.8 s in an earlier run). |
| Forge Neo | SDXL checkpoint, 1024×1024, 40 steps, `--cuda-malloc --expandable-segments` | **3794 MiB** | **7280 MiB** | Measured **with GPT-SoVITS resident**. One image: 26.3 s including the checkpoint load. |
| Stage (Chrome) | default GPU selection, WebGL page holding ~256 MiB of textures | **0 MiB** | 0 MiB | Rendered on the integrated GPU (about 30 MiB idle, 70 MiB peak there). |
| **Total on the discrete GPU** | | **6558 MiB** | **10044 MiB** | 1.9 GB of headroom on a 12 GB card. |

After Forge exited the card fell back to the GPT-SoVITS-only level (2764 MiB, residual +0); after
GPT-SoVITS exited it read 0. `nvidia-smi` agreed with the adapter counter to within 5 MiB in steady
state (largest transient gap 155 MiB).

### What this changes

- The design brief estimated GPT-SoVITS at 2–3 GB (not measured then) and took Forge's whole-card peak of
  10185 MiB from an earlier run without GPT-SoVITS, adding up to about 12.2–13.2 GB. Measured together,
  the total peak is **10.0 GB**: Forge's own peak drops from about 10.2 GB (alone) to 7.3 GB when there
  is less free memory, because its memory management offloads instead of failing. So "Forge running
  while GPT-SoVITS stays resident" **fits** on this card at 1024×1024.
- The stage costs the discrete GPU nothing on this machine, **provided** the browser renders on the
  integrated GPU (Windows graphics preference for `chrome.exe` left at default). If it is switched to
  "High performance", the stage's WebGL memory moves onto the budget; the probe reports it either way
  (`off-target` vs the `stage` role).

### Not yet measured

- Forge unload without exiting the process (does the Forge build expose an unload endpoint?).
- Forge at other sizes (for example 896 on the long side): the relevant number for the maximum-size
  setting. Needs the actual value the operator uses.
- Hires or extra LoRAs, a second checkpoint (the photo route switches checkpoints).
- The singing pipeline steps, and the ASMR speech recogniser.
- Local LLM alongside the above (about 4 GB VRAM and 20 GB RAM per its own documentation, not measured here).
- The real stage (this run used a stand-in WebGL page).
