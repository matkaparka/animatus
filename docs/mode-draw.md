# Draw mode

Viewers write the command word and what they want in chat (`画 a dragon asleep in a crater`). The program plans a prompt
with the model, draws the picture on your own Forge server under a strict all-ages policy, shows it in a frame on the
stage, and the character comments on it (the model is shown the picture). Pack: `modes/draw/`, controller
`packages/orchestrator/src/modes/controllers/draw.ts` and `src/modes/draw/`, image service `plugins/forge/`.

```
chat "画 …"  ->  layer 1: blocklist  ->  planner (2 model calls, may refuse)  ->  image service:
                 (before any model)                                              layer 2: forced safe tags, blocklist again
                                                                                 draw on Forge (one at a time)
                                                                                 layer 3: rating model looks at the picture
      <-  the frame shows it, the character comments  <-  saved to data/generated  <-  picture (or refused / blocked / error)
```

The service is the last line of defence: it enforces the safety layers itself, even though the mode does too. It does
not plan and never calls a model; the orchestrator is the only holder of model keys.

## What you need

- **A Forge server** (Stable Diffusion WebUI Forge, or a fork such as Forge Neo) that you start yourself with `--api`.
  The service does not start it. It uses the A1111 API: `/sdapi/v1/sd-models`, `/loras`, `/txt2img`, `/interrupt`,
  `/options`, and `/unload-checkpoint` when the service stops.
- **The rating model** (WD tagger v3, about 400 MB), fetched once into a folder. It runs on the CPU (onnxruntime).
  The first start downloads it in the background; fetch it ahead of time with the service's `--prepare` (see
  [First run](#first-run-and-operation)).
- **A blocklist** (a text file; the one that ships is a starting point) and **a settings file** for the service.
- The light Python environment of the repository (`uv sync`): aiohttp, pyyaml, pillow, numpy, onnxruntime and
  huggingface-hub are already in its `light` group.

## Enabling it

`config/animatus.config.yaml` (everything not written has the default in the tables below):

```yaml
plugins:
  forge:
    enabled: true
    config:
      settings_file: C:/path/to/forge-settings.yaml   # start from plugins/forge/settings.example.yaml
      max_long_side: 1024                              # multiple of 64, 512 to 2048; the console panel can change it

modes:
  draw:
    enabled: true
    config:
      blocklist_files: [plugins/forge/blocklist.default.txt, C:/path/to/my-words.txt]   # keep the same in the service settings
      frame:
        text_overlay: notice        # until the stage draws text on the frame (see "Stage"), then: frame
      routes:
        default:                     # the fallback; the model picks among these checkpoints and LoRAs
          checkpoints:
            - name: my-anime-checkpoint          # as Forge names it, or a fragment that matches only one
              desc: all-round anime
              style: anime
              guide: illustrious                 # prompts/guide_<name>.md of the pack: how to write for this model
              prefix: masterpiece, best quality, absurdres
              negative: lowres, bad anatomy, watermark
              params: { steps: 40, cfg_scale: 4.5, sampler_name: Euler a, scheduler: Automatic }
          loras:
            - { name: my-style-lora, weight: 0.7, trigger: [my_trigger], desc: what it draws }
        self:                        # a picture of the streamer's own character: one model, one LoRA, fixed
          fixed: true
          keywords: [self-portrait, yourself]     # a request containing one of these; "exact" is for a bare "you"
          exact: [you]
          description: the streamer's own character, in a few words
          checkpoints: [{ name: my-anime-checkpoint, guide: illustrious }]
          loras: [{ name: my-character-lora, weight: 0.7, trigger: [my_character, mecha dragon] }]
        photo:                       # photographs and real-looking people
          keywords: [photo, photograph, realistic]
          checkpoints: [{ name: my-pony-checkpoint, guide: pony, prefix: "score_9, score_8_up, score_7_up" }]
        furry:
          keywords: [furry, anthro]
          checkpoints: [{ name: my-furry-checkpoint, guide: illustrious }]
      ambiguous_tags: { husky: [husky] }      # a tag that means something else to the models, dropped unless asked for
      planner_notes: '"bear" means a large, hairy man here, not the animal; draw him clothed.'
```

The service's settings file (see `plugins/forge/settings.example.yaml`, which is the reference for every key):

```yaml
forge_url: http://127.0.0.1:7860
blocklist_files: [C:/path/to/blocklist.default.txt, C:/path/to/my-words.txt]
families:                        # how a safe picture is asked for, per family of models
  illustrious:
    match: [my-anime-checkpoint, my-furry-checkpoint]    # fragments of the checkpoint name
    arch: sdxl
    rating_tag: general
    extra_negative: "(sensitive, questionable:1.2)"
  pony:
    match: [my-pony-checkpoint]
    arch: sdxl
    rating_tag: rating_safe
    extra_negative: "(rating_explicit, rating_questionable:1.3)"
lora_allowlist: [my-style-lora, my-character-lora]   # empty means no LoRA at all
allow_sensitive_routes: [self]   # a white breastplate reads as skin: the self route may pass "sensitive"
```

Then start the mode from the console's Modes page (or its hotkey, `ctrl+alt+p`). While it is active the command words are
taken out of the chat; while it is not, `画 …` is an ordinary chat message. The mode is exclusive with `sing`, `game`,
`sleep` and `commentary`, has priority 50, and moves the character to the right and the frame to the left (the layout
is in `modes/draw/mode.yaml`; override it with a `config/modes/draw/mode.yaml`, or set `frame.rect`).

## What viewers can do, and what they get

- `画 <request>` or `/画 <request>`. A command word that does not start with `/` needs a space, a colon or a measure word
  after it (`画一只猫`, `画个圈`), so `画风不错` stays chat. The words are `triggers.danmaku_prefix` in the manifest.
- A viewer waits `cooldown_sec` (5 minutes) between requests: a refused request counts too, a fault does not. The room
  owner may skip the wait (`owner_skips_cooldown`). At most `queue_max` (3) requests wait behind the one being drawn;
  more are ignored without a word. A request is cut at `max_chars` (60) characters.
- The frame has three states, and a refusal or an error leaves it as it was:
  **idle** (the hint `弹幕发送「画 + 内容」召唤作品`), **generating** (`作画中 · name：request`, shown only after layer 1 and
  the planner have passed the request, cut to `frame.max_*_chars`), **showing** (the picture and `点图：name`; it stays until
  the next picture or `show_sec`, 10 minutes, then the hint returns).
- The character comments in one or two sentences, once the voice is free (`reaction_wait_sec`). A refusal is a line of
  `prompts/refusals.md` (or, with `refusal: model`, the model refusing in character without being told the request); a
  fault is a line of `prompts/errors.md`. **Nothing that is said, shown or sent to the model for a refusal contains or
  hints at the request.** The names of viewers that hit the blocklist are replaced by the pack's anonymous name.
- Every text a viewer or the model sees is a file under `modes/draw/prompts/`; put a file of the same name in
  `config/modes/draw/prompts/` to replace one. The defaults for what is spoken and shown are Chinese (matching the
  default command word); the prompts for the model are English and work with any persona.

## Settings

### `modes.draw.config`

Only `routes` has no default. A typo or an out-of-range value stops the program at start-up with the key named.

| Key | Default | Meaning |
|---|---|---|
| `service` | `forge` | service name of the image plugin |
| `cooldown_sec` | 300 (0 to 86400) | one viewer's wait between requests |
| `owner_skips_cooldown` | true | the room owner may ask again at once |
| `queue_max` | 3 (1 to 20) | requests that may wait behind the one being drawn |
| `max_chars` | 60 (5 to 500) | longer requests are cut |
| `measure_words` | `一两个只条张幅位头匹棵朵把座艘辆群对副` | what may follow a command word that has no slash |
| `blocklist_files` | `[plugins/forge/blocklist.default.txt]` | layer 1, relative to the project root |
| `refusal` | `canned` | `canned` (a line of the pack) or `model` |
| `send_image` | true | show the model the picture; turn off for a model that cannot see images |
| `keep_pictures` | 50 (1 to 1000) | pictures kept in `data/generated`, the newest |
| `show_sec` | 600 (1 to 86400) | how long a picture stays in the frame |
| `plan_timeout_sec` | 30 (5 to 300) | one planning call to the model |
| `generate_timeout_sec` | 300 (10 to 3600) | one picture at the service; at least the service's own limit |
| `reaction_wait_sec` | 90 (0 to 600) | how long the comment waits for a free voice, then it is said anyway |
| `catalog_ttl_sec` | 60 (0 to 3600) | how long the service's list of checkpoints and LoRAs is remembered |
| `max_loras` | 2 (0 to 4) | LoRAs the planner may attach to one picture |
| `frame.text_overlay` | `frame` | where the frame's words go: `frame` or `notice` (see Stage) |
| `frame.rect` | none | frame position in percent; without it the layout of the pack decides |
| `frame.max_name_chars` / `max_request_chars` | 16 / 30 | cuts on the stage |
| `planner_notes` | empty | vocabulary of the stream, told to the planner |
| `ambiguous_tags` | none | tag to the words that make it allowed |
| `routes.<name>` | | see below |

A route is `default` (required), `self`, `photo` or `furry`; they are tried in the order self, photo, furry, default.
Each has `checkpoints` (1 to 10; `name`, `desc`, `style`, `guide` (default `sdxl`), `prefix`, `negative`, `params`:
`steps` 30, `cfg_scale` 5, `sampler_name` `Euler a`, `scheduler` `Automatic` or null, `width`/`height` 1024, optional
`sizes.portrait|landscape|square`), `loras` (`name`, `weight` 0.8, `trigger`, `desc`), `keywords` (words in the request that
select the route), `exact` (requests that are exactly one of these), `fixed` (use the first checkpoint and every LoRA as
written; the planner chooses neither) and `description`.

### `plugins.forge.config`

| Key | Meaning |
|---|---|
| `settings_file` | required: the service's settings file |
| `max_long_side` | required: longest side of a picture, a multiple of 64 from 512 to 2048. It is the memory-relevant setting: the mode's admission hashes it (`resources.config_keys`) |

### The service's settings file

`forge_url` (default `http://127.0.0.1:7860`), `blocklist_files` (default: the shipped list), `families` (required; each
`match`, `arch` default `sdxl`, `rating_tag`, `extra_negative`), `allowed_archs` (`[sdxl]`), `allowed_checkpoints` (empty:
every checkpoint of an allowed family), `lora_allowlist` (empty: no LoRA), `max_loras` (2), `extra_positive` (`clothed`;
never `underwear`, which asks for it to be shown), `extra_negative` (`(nsfw, explicit, nude, naked, nipples, genitals,
sex:1.4)`), `allow_sensitive_routes` (none), `tagger.repo` (`SmilingWolf/wd-vit-tagger-v3`), `tagger.dir` (default
`<data>/forge/tagger`), `tagger.max_questionable_plus_explicit` (0.15), `tagger.retries` (1), `limits.queue_max` (3),
`limits.queue_wait_sec` (600), `limits.generate_timeout_sec` (300), `limits.max_steps` (100), `unload_on_stop` (true),
`thumb_side` (512), `forge_check_sec` (10). Every problem in the file is reported at once and the service exits with 2.
Relative paths in it are relative to the file.

## The safety layers

1. **Request, before any model** (mode): the request goes through the blocklist. English entries match whole words
   (`sex` does not hit "Essex"), Chinese ones as substrings, also with spaces or dots put between the characters. A hit is
   refused at once: no model, no service, nothing on the stage. Then the planner's two prompts carry the public-broadcast
   rules and answer `{"refuse": true}` for anything sexual, gory, political, hateful or about a real person; an answer that
   is not JSON counts as a refusal too (a provider's filter answers nothing). A model that cannot be reached is an error,
   not a refusal.
2. **Prompt** (service): the prompt is stripped of `<lora:…>` and every other `<…>` tag (only the service attaches LoRAs, from
   its allowlist), tags that hit the blocklist are deleted (nothing left of the model's words: refused), and only then are the
   forced tags put in at the front: the family's rating tag (`general`, `rating_safe`) and `clothed`, then the caller's
   prefix, then the prompt; the forced negatives go first in the negative prompt. The finished prompt is scanned again. A checkpoint that matches no family is refused (no tags could be chosen
   for it); the settings are refused if the blocklist would delete a forced tag.
3. **Picture** (service): the rating model must call the picture `general` (or `sensitive` on a route in
   `allow_sensitive_routes`) and questionable + explicit must stay under the limit. Otherwise it is drawn once more with
   another seed, then `blocked`; the picture is never written anywhere and never returned. Hires, ControlNet and scripts
   cannot be asked for: the service builds the Forge request itself and refuses unknown fields.

A missing or unreadable blocklist, or a rating model that cannot be loaded, is an error (`/health` answers 503, the mode
will not start, requests are refused with an alarm), never an empty layer.

## Stage

The frame is the `frame` overlay: `overlay.set` with `visible`, `image` (`/asset/generated/…`), `text` and, with
`frame.rect`, `rect`. Every message carries the whole state, because the stage keeps only the latest per overlay.

**The stage draws no `text` on the frame yet, and shows the frame only when it has a picture.** What the draw mode
needs of the `frame` overlay: a message is its whole state; `visible` without `image` is a frame with only its `text`
on a dark plate (and the previous picture is dropped); with `image` it is the picture with `text` as a caption under
it, fading in; `visible: false` hides it. Until the stage does that, set `frame.text_overlay: notice`: the frame overlay
then carries the picture only (hidden when there is none) and the words go to the banner at the top (the `notice`
overlay), which the stage does draw.

The mode's layout (`stage.layout` in the pack) is applied while it is active and taken back when it is left.

## Console panel

Status, facts (image service, Forge, rating model, longest side, queue, cooldown, last problem), the last picture, the
queue (the running request and the waiting ones, each with **Cancel**), and buttons: **Draw a picture now** (the operator's
own request, no cooldown), **Clear the frame**, and **Longest side of a picture** (calls the service's `/config`; a
multiple of 64 from 512 to 2048). The console's Modes page also enters the mode (`POST /api/modes/draw/enter`).

## The service's HTTP contract

Bound to 127.0.0.1, JSON only, bodies up to 64 KiB. A failure of real work is a non-2xx answer with
`{"error": {"code", "message", "retryable"}}` (and, for `/generate`, also `"status": "error"` and `"reason": <code>`); a
refusal of the content is a normal answer that says so. Nothing answers 200 with an empty result.

- `GET /health`: `200 {ok, ready, service, version, config, detail?}`. `ready: false` while the rating model loads;
  `503 ok: false` when a safety layer is broken (blocklist, rating model). Forge being away is reported (`config.forge_reachable:
  false`, `detail`) and does not make the service unready: a request then fails with `forge_unreachable`. `config`: `max_long_side`,
  `forge_url`, `forge_reachable`, `forge_error`, `rating_model` (`loading`/`ready`/`failed`), `queue_waiting`, `queue_max`, `busy`,
  `blocklist_words`, `last_error`. Never waits for Forge.
- `POST /config` `{"max_long_side": 768}`: `200 {ok, config}`; `400` (`invalid_config`, `invalid_request`), `500 state_not_saved`. Saved in
  `<data>/forge/state.json` and applied to the next picture. The saved value counts only while the configuration still holds the
  number it was saved against (editing the configuration file later wins).
- `GET /catalog`: `200 {checkpoints: [{name, title, family, allowed, why_not?}], loras: [{name, alias?, allowed}], families,
  max_long_side}`; `502 forge_unreachable`, `504`.
- `POST /generate` `{checkpoint, prompt, prefix?, negative_prompt?, width, height, steps, cfg_scale, sampler_name, scheduler?,
  seed? (-1 random), loras: [{name, weight}], route}`, nothing else. `prompt` is what the model wrote, `prefix` what the
  caller's configuration adds in front of it (quality words, trigger words): kept apart so that a model whose every tag is on
  the blocklist gets no picture (`rejected`, `empty_prompt`) instead of one made of the quality words alone. `200 {status: "ok", image_b64, thumb_b64, width, height, seed,
  attempts, ratings, checkpoint, family, scrubbed, elapsed_ms}`; `200 {status: "rejected", reason}` (`empty_prompt`); `200
  {status: "blocked", reason: "rating", attempts, ratings}`; errors: `400 invalid_request`, `422` (`checkpoint_not_found`,
  `unknown_family`, `checkpoint_not_allowed`, `lora_not_allowed`, `lora_not_found`), `500` (`safety_config`, `internal_error`), `502`
  (`forge_unreachable`, `forge_error`), `503` (`busy`, `not_ready`, `unavailable`), `504 forge_timeout`. One picture at a time under one
  lock; at most `queue_max` requests wait, none longer than `queue_wait_sec`. A caller that hangs up, or a picture that takes
  longer than `generate_timeout_sec`, makes the service tell Forge to interrupt.
- `POST /shutdown`: `200`, then the service stops (asking Forge to unload the checkpoint when `unload_on_stop`).

## First run and operation

- **The rating model** downloads on the first start (about 400 MB, through `HTTPS_PROXY` of the orchestrator if you need a
  proxy) into `tagger.dir`. While it does, the service is up but not ready, so the mode cannot start (the mode manager waits
  120 s, the plugin's health timeout is 10 minutes). Fetch it once by hand and the first start is quick:
  `C:/path/to/.venv/Scripts/python.exe plugins/forge/service.py --data-dir C:/path/to/data --settings C:/path/to/forge-settings.yaml --max-long-side 1024 --prepare`.
  Or put `model.onnx` and `selected_tags.csv` from the model's page into `tagger.dir`.
- **Memory.** The mode requires the `forge` service, so entering starts the plugin and leaving stops it; on the way out
  the service asks Forge to unload the checkpoint (`unload_on_stop`) so that the graphics memory can fall back for the mode
  manager's settle check. The service's memory cost is Forge's and is not measured for this service's settings
  (`vram_mb_est: null`, "not measured"); measure it with the probe, keyed `forge`, for the `max_long_side` you use.
- **Checkpoint switching** is Forge's own: the request carries `override_settings.sd_model_checkpoint` and the checkpoint stays
  loaded afterwards. Routes with different checkpoints cost a reload each time they alternate.
- **Alarms** (`draw_failed`, `draw_blocklist`, subject `draw`) carry the reason in the service's own words and clear on the next
  success or when the mode is left.

## Decisions and differences from the legacy feature

- Routes, the `ambiguous_tags` and the notes for the planner are configuration, not code, and nothing here names a model. The
  legacy checks that chose a route from the model's own words after writing the prompt (a third check on the written
  prompt for furry tags) are not ported; the request's words, the model's `self` flag, its `photo` style and a furry subject are.
- The legacy tagger download happened inside the generation lock and the lock had no queue bound or timeout; here the
  download is in the background before the service is ready, and the queue is bounded with timeouts.
- A missing catalog no longer switches the second layer off: the family of a checkpoint comes from the service's settings,
  and a checkpoint with no family is refused.
- The legacy page polled the service for the request text; here the mode shows it itself, only after layer 1 and the planner passed.
- Refusal lines and fault lines wait for a free voice like every comment, and at most three wait at a time (a raid of blocked
  requests must not keep the voice busy).
- Requests that could not be looked at (blocklist unreadable) cost the viewer their turn; a fault after that does not.

## Known limits

- Layer 1 matches English entries as whole words only: `n u d e` gets past it. The forced tags, the forced negatives and the
  rating model are what stand behind it, and the rating model is a classifier that can be wrong.
- The stage draws no frame text or fade yet (see Stage); the picture appears at once.
- The panel's last picture is an asset URL of the stage server; the console page is another origin (its content
  security policy allows `'self'` and `data:` images), so it cannot show it until it loads it from the stage's address.
- A size changed from the panel is applied by the service and remembered, but the mode's admission still hashes the number
  in the configuration file: it follows the panel only once the plugin's reported `config` is merged into what the
  admission reads.
- A model provider that cannot take images needs `send_image: false`; the comment is then made from the words alone.
- Not verified here: a real Forge (whether Forge Neo honours `override_settings` for the checkpoint and `unload-checkpoint`),
  the real rating model on real pictures (the tests use a fake one), the graphics memory at other sizes, the quality of the
  planning prompts with a real model, and the frame on a real stage window.

## Tests

- Service (stdlib `unittest`): `C:/path/to/.venv/Scripts/python.exe -m unittest discover -s plugins/forge -p "test_*.py"`.
- Mode: `npx vitest run --project orchestrator packages/orchestrator/test/modes/draw packages/orchestrator/test/app/draw`;
  the tests against the real service process run with the repository's `.venv` (or `ANIMATUS_TEST_PYTHON`) and are skipped without it.
