# Third-party notices

Animatus itself is licensed under the PolyForm Noncommercial License 1.0.0 (see `LICENSE`).
Dependencies keep their own licenses. The main ones:

| Component | License | Use |
|---|---|---|
| three | MIT | 3D rendering (stage) |
| @pixiv/three-vrm, @pixiv/three-vrm-animation | MIT | VRM loading, VRMA animation |
| wlipsync (wLipSync, hecomi; Web port by Noeri Huisman) | MIT | Vowel estimation for lip sync |
| zod | MIT | Schemas |
| ws, undici | MIT | WebSocket and HTTP |
| blive-message-listener | MIT | Chat messages of a live room (Bilibili) |
| react, react-dom | MIT | The console page |
| vite, vitest, tsx | MIT | Tooling |
| TypeScript | Apache-2.0 | Tooling |
| yaml | ISC | Manifests |

Python groups (`pyproject.toml`) pull in packages under their own licenses; `uv.lock` lists exact versions. The table at the end of this file
is written by `npm run license-audit -- --write` (see `tools/license-audit`): run it again before every release.

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

## Dependency licence audit

<!-- license-audit:begin (written by tools/license-audit/audit.mjs) -->
_Audit of 2026-09-30: 216 npm packages (31 that ship, 185 for building and testing only) and 70 Python distributions in the light environment._

### npm, what ships

| Licence | Packages | Examples |
|---|---:|---|
| MIT | 27 | @pixiv/three-vrm, @pixiv/three-vrm-animation, @pixiv/three-vrm-core, @pixiv/three-vrm-materials-hdr-emissive-multiplier, @pixiv/three-vrm-materials-mtoon, @pixiv/three-vrm-materials-v0compat, @pixiv/three-vrm-node-constraint, @pixiv/three-vrm-springbone, ... |
| (MIT AND Zlib) | 1 | pako |
| Apache-2.0 | 1 | long |
| BSD-3-Clause | 1 | protobufjs |
| ISC | 1 | yaml |

npm, what ships: nothing needs a look.

### npm, build and test tools only (not distributed)

| Licence | Packages | Examples |
|---|---:|---|
| MIT | 139 | @babel/code-frame, @babel/compat-data, @babel/core, @babel/generator, @babel/helper-compilation-targets, @babel/helper-globals, @babel/helper-module-imports, @babel/helper-module-transforms, ... |
| Apache-2.0 | 26 | @dimforge/rapier3d-compat, @typescript/typescript-aix-ppc64, @typescript/typescript-darwin-arm64, @typescript/typescript-darwin-x64, @typescript/typescript-freebsd-arm64, @typescript/typescript-freebsd-x64, @typescript/typescript-linux-arm, @typescript/typescript-linux-arm64, ... |
| MPL-2.0 | 12 | lightningcss, lightningcss-android-arm64, lightningcss-darwin-arm64, lightningcss-darwin-x64, lightningcss-freebsd-x64, lightningcss-linux-arm-gnueabihf, lightningcss-linux-arm64-gnu, lightningcss-linux-arm64-musl, ... |
| ISC | 5 | electron-to-chromium, lru-cache, picocolors, semver, yallist |
| BSD-2-Clause | 1 | entities |
| BSD-3-Clause | 1 | source-map-js |
| CC-BY-4.0 | 1 | caniuse-lite |

npm, build and test tools: nothing needs a look.
npm dev weak copyleft (fine to depend on, keep the notice): lightningcss, lightningcss-android-arm64, lightningcss-darwin-arm64, lightningcss-darwin-x64, lightningcss-freebsd-x64, lightningcss-linux-arm-gnueabihf, lightningcss-linux-arm64-gnu, lightningcss-linux-arm64-musl, lightningcss-linux-x64-gnu, lightningcss-linux-x64-musl, lightningcss-win32-arm64-msvc, lightningcss-win32-x64-msvc.

### Python (light environment)

| Licence | Packages | Examples |
|---|---:|---|
| MIT | 22 | annotated-doc, annotated-types, anyio, attrs, charset-normalizer, fastapi, filelock, h11, ... |
| BSD-3-Clause | 14 | click, fsspec, httpcore, httpcore2, httpx, httpx2, idna, pycparser, ... |
| Apache-2.0 | 10 | frozenlist, google-genai, hf-xet, huggingface_hub, openai, opentelemetry-api, propcache, python-multipart, ... |
| Apache 2.0 | 4 | aiosignal, flatbuffers, google-auth, tenacity |
| BSD | 2 | colorama, pyasn1_modules |
| PSF-2.0 | 2 | aiohappyeyeballs, typing_extensions |
| 3-Clause BSD License | 1 | protobuf |
| Apache License 2.0 | 1 | multidict |
| Apache License, Version 2.0 | 1 | distro |
| Apache-2.0 AND MIT | 1 | aiohttp |
| Apache-2.0 OR BSD-2-Clause | 1 | packaging |
| Apache-2.0 OR BSD-3-Clause | 1 | cryptography |
| BSD 3-Clause License | 1 | soundfile |
| BSD-2-Clause | 1 | pyasn1 |
| BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | 1 | numpy |
| MIT License | 1 | onnxruntime |
| MIT OR Apache-2.0 | 1 | sniffio |
| MIT-0 | 1 | cffi |
| MIT-CMU | 1 | pillow |
| MPL-2.0 | 1 | certifi |
| MPL-2.0 AND MIT | 1 | tqdm |
| PSF | 1 | pywin32 |

Python: nothing needs a look.
Python weak copyleft (fine to depend on, keep the notice): certifi, tqdm.

### Files derived from other projects (by their headers)

- **AITuberKit** (https://github.com/tegnike/aituber-kit), used under its Non-Commercial Use License; licence text in `licenses/AITuberKit-LICENSE.txt`. 6 file(s), each with the notice and a note of what was changed: `packages/orchestrator/src/brain/segmenter.ts`, `packages/orchestrator/src/brain/stream.ts`, `packages/orchestrator/src/brain/tags.ts`, `packages/orchestrator/src/brain/types.ts`, `packages/orchestrator/test/brain/segmenter.test.ts`, `packages/orchestrator/test/brain/tags.test.ts`.

<!-- license-audit:end -->
