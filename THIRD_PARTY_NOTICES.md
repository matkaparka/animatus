# Third-party notices

Animatus itself is licensed under the PolyForm Noncommercial License 1.0.0 (see `LICENSE`).
Dependencies keep their own licenses. The main ones:

| Component | License | Use |
|---|---|---|
| three | MIT | 3D rendering (stage) |
| @pixiv/three-vrm, @pixiv/three-vrm-animation | MIT | VRM loading, VRMA animation |
| wlipsync (wLipSync, hecomi; Web port by Noeri Huisman) | MIT | Vowel estimation for lip sync |
| zod | MIT | Schemas |
| hono, @hono/node-server, ws | MIT | Servers |
| vite, vitest, tsx | MIT | Tooling |
| TypeScript | Apache-2.0 | Tooling |
| yaml | ISC | Manifests |

Python groups (`pyproject.toml`) pull in packages under their own licenses; `uv.lock` lists exact versions.

## Code derived from other projects

| Origin | License | Where |
|---|---|---|
| [AITuberKit](https://github.com/tegnike/aituber-kit) | Custom: non-commercial use license or a separate commercial license. Text in `licenses/AITuberKit-LICENSE.txt`. | The streaming sentence segmenter, tag extractors and the speech cancellation semantics in `packages/orchestrator` are derived from its speech pipeline. Each such file says so in its header. The license requires the notice to travel with the code and permits non-commercial use only, which this repository's license also does. |
| wLipSync (hecomi), Web port by Noeri Huisman | MIT, text in `licenses/wLipSync-LICENSE.txt` | Used through the `wlipsync` npm package. |

Files that only re-implement behaviour (the stage's look-at smoother, expression controller, VRMA helpers) are written
from scratch and are not derived work.

## Assets are not included

No 3D models, motions, dance choreography, music or voice weights are distributed with this
repository. Whatever you load must be licensed for your use. Some third-party motion datasets carry
non-commercial or share-alike terms (for example CC BY-NC-SA); check them before use.

## To be completed before the first release

A per-package license audit (`npm ls --all` and `uv pip list` with license metadata) belongs here.
