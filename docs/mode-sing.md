# Sing mode: song requests

Pack `modes/sing/`, controller `packages/orchestrator/src/modes/controllers/sing.ts` (with `src/modes/singing/`),
plugin `plugins/singing/`. Viewers type `点歌 <song name>` in chat; the character sings the song, in the
voice you trained, over the original band, with the lyrics on screen, and says a line about it afterwards.

Two halves, on purpose:

| Half | Does | Never does |
|---|---|---|
| **The singing plugin** (Python service, `plugins/singing`) | keeps the queue; finds the song (a folder of your own audio files, or a NetEase API server you run); separates the vocals; converts the voice with RVC (your own Applio install); mixes; keeps the result in the songs library | play anything; talk to the model or the stage |
| **The mode** (TypeScript controller) | turns the audience's commands into calls to the service and the answers into lines for the model; when a song is ready and the stage is free, sends it to the stage, holds the voice for its length, tells the service how it ended, and gives the model a closing line | keep a second copy of the queue; look inside a song's files |

Nothing of the models ships with Animatus: no song, no separation model, no voice model. You bring them.

## Songs and rights

Animatus ships no songs, no vocals and no API server for any music service. The NetEase source talks to an API server that
you run yourself, with your own account, and it is off until you configure it; the local folder of your own audio files is the
default source and needs no network.

Whether you may download a song from a streaming service and convert its vocals depends on that service's terms and on the
law where you are and where you stream. Singing over a copyrighted recording on a public stream may also need licences that
the platform you stream on, or the rights holders, have to give you. That is yours to check. The program's own limits (one
queue, a pause between requests, a download budget, a breaker that stops on a risk-control answer) are there to protect your
account and the service; they do not make any of this permitted.

```
chat 点歌 X ─▶ router ─▶ mode.onSongCommand ──POST /request──▶ singing service ──▶ queue
                                  │ answer becomes a line for the model            │ one song at a time:
                                  │ (queued at #2, or why not)                     │ fetch, separate, pitch, convert, mix
                                  ▼                                                ▼
   poll GET /queue ─▶ a song is ready ─▶ wait for the voice ─▶ enter mode ─▶ POST /claim ─▶ songs library
                                                                   │
                                     sing.play (two tracks, lyrics) ▼          sing.state reports
                                                                 the stage ◀──────────────────────────▶ mode
                                     song over ─▶ POST /done ─▶ leave mode ─▶ closing line by the model
```

## Turning it on

```yaml
# config/animatus.config.yaml
paths:
  songs: C:/path/to/songs            # the songs library: the stage fetches the two tracks of a song from here

plugins:
  singing:
    enabled: true
    config:
      python: C:/path/to/audio-env/python.exe       # has PyYAML, numpy, scipy, soundfile and audio-separator
      songs_dir: C:/path/to/songs                   # MUST be the same folder as paths.songs (an alarm says so if not)
      settings: C:/path/to/singing.yaml             # see below; may be missing while you try things out

modes:
  sing:
    enabled: true
    config:                          # all optional; the numbers are the defaults (the full table is below)
      poll_sec: 2
      start_timeout_sec: 60
      outro: true
      lyrics: true
      credit: true
      announce_failures: true
```

```dotenv
# config/.env (or the console's write-only key page, name ncm_cookie). Only for a NetEase membership account.
NCM_COOKIE=
```

1. Copy `plugins/singing/settings.example.yaml` to the place `plugins.singing.config.settings` names and edit it:
   at least `paths.applio`, `rvc.model_pth`, `paths.ffmpeg` and one source (`paths.local_music` or `ncm.base_url`).
2. Start the program. The console shows the plugin as `starting`, then `ready`. If the setup cannot work (a missing
   model file, an unknown key in the settings file) it stays out of `ready` and the reason is in its health detail,
   for example `rvc.model_pth: no model file at ...`.
3. Send `点歌 <a song from your folder>` in chat, or use the console. The first song takes long (the separation
   models are downloaded once; raise `timeouts.separate_sec` for it), the following ones take as long as the
   separation and the conversion take on your card. `python -m singing_service.prefetch` (below) prepares songs before
   the show.

The plugin is started with the program, not with the mode: the queue has to live while nobody is singing. That is why
the pack says `requires.services: []` (the mode manager would stop a service of a mode when the mode ends).

## What viewers and the operator can do

The router recognises these before anything else sees the message (words are data, in `inbox/router.ts`):

| Chat | Effect | Who |
|---|---|---|
| `点歌 <name> [artist]` | asks the service to find and queue the song; the model is told how it went | anybody |
| `取消点歌` | takes the sender's latest waiting song off the queue; if only their song is being sung, stops it | anybody |
| `取消点歌 <n>` | takes queue entry n off | room owner, moderators (`inbox.singing.admins_can_skip`), `inbox.singing.owner_uids` |
| `切歌` | cuts the song being sung | the same |
| `歌单` | the model reads out what is being sung and what waits | anybody |

The model is told what happened (`songLine`, texts from `inbox/formats.ts`): queued at position n (and whether the song
is already prepared), refused with the reason, cancelled, removed, cancelled while being sung, the list, "the song
system is off" when the service cannot be reached. The `available` prompt tells it how to react, and never to promise
a song outside the command.

The console's Modes page shows the mode with a panel. Facts: the service (reachable or not), the song source, the queue
(waiting, ready, limits), what is being prepared and at which step, the songs folder. Buttons: **Stop singing** (cuts the
song, keeps the queue, and pauses), **Pause singing** / **Resume singing** (nothing starts while paused), **Resume the song
source** (lifts the NetEase circuit breaker, only when it is tripped). Rows: **Skip** on the song being sung, **Remove** on
a waiting entry; a section "Failed lately" shows what went wrong with the operator's own words. The **Enter** of
the Modes page (`POST /api/modes/sing/enter`) starts the first ready song now, even while paused; `replace` ends a
conflicting mode (a dance) first, `force` ignores the exclusivity and fit checks. The generic **Exit** stops the song and
also pauses, so it does not start again by itself. The pack's `ctrl+alt+s` is only the shortcut hint the Modes page shows.

The mode is `exclusive_with: [dance, draw, commentary, game]` (the manager reads exclusivity both ways, so the dance
pack's own `exclusive_with: [sing]` counts as well) and has priority 60: while one of those runs, a ready song waits and
is tried again after `retry_after_sec`. A mode that preempts (sleep) ends a song being sung, as `interrupted`, and blocks
new ones until it is over.

## The life of a request

An entry in the service is in one of these states: `queued` (waiting to be prepared), `downloading`, `processing`,
`ready`, `playing` (claimed by the mode), `failed` (kept for `queue.failed_keep_sec` so the failure can be announced).
One song is prepared at a time. A song that is ready sings when the stage is free, in the order asked.

A request is checked twice: before the search (to spare it) and again at the insert, both times under one lock hold, so
two requests of one viewer cannot both get in. Rejections, each with a code and a viewer text (table below):
empty, blacklisted, per-viewer limit, queue full, not found, already queued, being sung now, sung recently
(`queue.repeat_cooldown_min`), too long (`qc.max_duration_sec`), no vocals (a song found to be instrumental stays
refused, unless you lower `qc.min_vocal_ratio`), NetEase VIP or paid-album songs, no audio, a spent download budget.

How a song ends, reported by the mode with `POST /done`:

| Outcome | When | What the service does |
|---|---|---|
| `done` | the stage said the song ended by itself | records it as sung |
| `skipped` | a viewer's `切歌`, the singer's own `取消点歌`, the console's Skip | records it as sung |
| `stopped` | the console's Stop or Exit | records it as sung |
| `interrupted` | the stage went away, said an error, or never said the end; a restart | records it as sung |
| `failed` | it never sounded (the stage could not load it) | the entry stays in "Failed lately" for a while; it does not count as sung, so it can be asked for again at once |
| `released` | the mode was stopped while the song was still being started | the entry goes back to the front of the queue as `ready` |

A song nobody reports on is taken to be over after its length plus 120 seconds. After a restart of the service only
requests newer than `queue.restore_within_min` (20) come back: last show's queue must not start singing.

## What the mode does with one song

`idle → pending → loading → playing → ending → after → idle`.

1. A watcher looks at the queue every `poll_sec`. A ready song and a connected stage and no pause and no recent refusal:
   it waits for the voice to be quiet (at most `quiet_timeout_sec`), so the reply being spoken is not cut off.
2. It enters the mode. Entering claims the song (`POST /claim`, with a claim id: a repeated claim after a lost answer gets
   the same song), holds the voice, puts the lyrics and credit overlays up, and sends `sing.play` with the two track
   addresses under the songs library and the lyrics. The audience's chat waits from here (`flags.singing`), and starts
   to age only when the song is over.
3. The stage must report `playing` within `start_timeout_sec`. It reports `idle` with a reason when it ends: `done`,
   `stopped` (after our `sing.stop`), or `error` (an alarm with the stage's words).
4. Leaving the mode reports the outcome to the service, hides the overlays, releases the voice, and, after `done` or
   `skipped`, tells the model to say one closing line (`outro.md`, `outro_skipped.md`). The audience's queue is released
   as soon as the model starts answering, or after `outro_window_sec`.

Things that cannot get stuck: a stage that never answers (`start_timeout_sec`, then the song is given back), one that
never says the end (a watchdog at the song's length plus `watchdog_extra_sec`, then `sing.stop` and `interrupted`), one
that does not finish stopping (`stop_timeout_sec`), a stage that disconnects (the song is over, `interrupted`), a service
that dies (calls have `call_timeout_sec`; the song still ends on the stage), a shutdown in the middle (the mode leaves,
the overlays and the voice hold are cleared). The mode never leaves a hold, a flag or an overlay behind.

A request from a viewer that takes too long is given up on (`request_timeout_sec` plus `request_slack_sec`) and taken
back from the service (`POST /abandon`), so it can never appear in the queue afterwards. Sending the same request id
twice is the same entry.

### Alarms (console)

| Id | Level | Raised when | Cleared when |
|---|---|---|---|
| `sing_service` | warn | the service has been unreachable for `service_alarm_after_sec` | it answers |
| `sing_songs_dir` | error | `paths.songs` is unset, or is not the folder the service keeps songs in | the two agree |
| `sing_source` | warn | the song source stopped itself (NetEase circuit breaker) | resumed from the panel |
| `sing_failed` | warn | the stage refused a song, said an error, or never reported the end | the next song starts |

While the service is down a request is answered "the song system is off" to the model, so viewers hear something.

## Settings

### `modes.sing.config`

Strict: an unknown key is an error that names it. Seconds unless the key says otherwise.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `poll_sec` | 2 | 0.1 to 60 | how often the queue is looked at; a song that became ready is noticed within this long |
| `request_timeout_sec` | 20 | 1 to 100 | how long a viewer's request may take; also the most the service is told to wait |
| `request_slack_sec` | 5 | 0.1 to 60 | how much longer than that the mode waits before it gives up on a service that does not answer |
| `call_timeout_sec` | 5 | 0.5 to 60 | every other call to the service |
| `quiet_timeout_sec` | 30 | 1 to 60 | how long a ready song waits for the voice to be quiet before trying again on the next look |
| `start_timeout_sec` | 60 | 1 to 100 | the stage must report the song playing within this long (it loads two long tracks) |
| `stop_timeout_sec` | 10 | 1 to 60 | after a stop, the fade plus this long for the stage to report it is done |
| `watchdog_extra_sec` | 45 | 1 to 600 | a song not reported over this long after it should have ended is given up on |
| `max_song_sec` | 900 | 30 to 3600 | the length assumed for a song whose length is unknown |
| `retry_after_sec` | 10 | 1 to 600 | after a refusal (a dance is on) or a failure to start, how long before the next try |
| `outro` | true | | the model says a closing line after a song |
| `outro_window_sec` | 8 | 0.5 to 60 | how long the model has to start it before the audience's queue is released anyway |
| `lyrics` | true | | show the lyrics overlay |
| `credit` | true | | show the overlay with the song, artists and who asked |
| `start_delay_s` | 0.2 | 0 to 5 | both tracks start this long after the stage gets the command |
| `stop_fade_s` | 0.6 | 0 to 5 | how long a song fades out when it is cut short |
| `announce_failures` | true | | tell the model when a song a viewer asked for could not be prepared |
| `service_alarm_after_sec` | 30 | 1 to 3600 | how long the service must have been unreachable before it is an alarm |

### `plugins.singing.config`

| Key | Meaning |
|---|---|
| `python` | the interpreter that runs the service and the separation and mix steps: PyYAML, numpy, scipy, soundfile and `audio-separator`; also `pedalboard` for a song whose band has to be transposed and for the reverb |
| `songs_dir` | the songs library; the same folder as `paths.songs` |
| `settings` | the YAML file below |

The secret `ncm_cookie` (environment name `NCM_COOKIE`) is optional, only used by the NetEase source, sent in a request
header and never logged.

### The service's settings file

Every key has a default and bounds; a key that is not listed is an error that names it (`queue.max_lenght: unknown
setting`). Relative paths are relative to the file's folder. The file is read when the plugin starts; a change needs a
restart of the plugin. A commented example is `plugins/singing/settings.example.yaml`.

| Key | Default | Meaning |
|---|---|---|
| `source` | `auto` | `local`, `netease`, or `auto` (NetEase when `ncm.base_url` is set, otherwise the local folder) |
| `keep_intermediate` | false | keep the separation's intermediate files (about 250 MB a song) |
| `messages` | `{}` | replacement viewer texts by code (table below) |

`paths`

| Key | Default | Meaning |
|---|---|---|
| `local_music` | empty | the folder of audio files of the `local` source |
| `ffmpeg` | `ffmpeg` | on the PATH, or a full path (a relative path with a slash is relative to the file) |
| `models` | empty | where the separation models are kept (downloaded on first use); empty means `models/` in the state folder |
| `applio` | empty | the Applio folder (the one with `core.py`) |
| `applio_python` | empty | Applio's interpreter; empty means the `.venv` inside the Applio folder |

`ncm` (only for `source: netease`)

| Key | Default | Range | Meaning |
|---|---|---|---|
| `base_url` | empty | http(s) | the NetEase API server you run, for example `http://127.0.0.1:3300` |
| `min_interval_sec` | 3.0 | 0.5 to 60 | every request, downloads included, waits this long after the last, across processes |
| `timeout_sec` | 20 | 1 to 120 | one request to the API server |
| `level` | `exhigh` | `standard`, `higher`, `exhigh`, `lossless` | audio quality asked for |
| `search_limit` | 10 | 1 to 30 | candidates looked at per search |
| `max_new_downloads_per_session` | 30 | 0 to 1000 | new downloads per run of the service; songs already in the library do not count |

`separation`: `vocal_model` (`vocals_mel_band_roformer.ckpt`), `split_backing` (true: only the lead is converted, the
backing vocals stay in the band), `karaoke_model` (`mel_band_roformer_karaoke_becruily.ckpt`), `dereverb_model`
(`dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt`).

`voice`

| Key | Default | Range | Meaning |
|---|---|---|---|
| `f0_median_hz` | 0 | 0 to 2000 | median pitch of the voice's training material; 0 means unknown, songs are sung at their own pitch |
| `comfort_low_hz` | 0 | 0 to 2000 | the range the voice is comfortable in ... |
| `comfort_high_hz` | 0 | 0 to 4000 | ... a song that lands outside it too often gets a warning (shown on the queue entry) |

`rvc`

| Key | Default | Range | Meaning |
|---|---|---|---|
| `model_pth` | empty | | the voice model file (required) |
| `index` | empty | | its index file (optional) |
| `f0_method` | `rmvpe` | | pitch extractor |
| `index_rate` | 0.5 | 0 to 1 | |
| `protect` | 0.33 | 0 to 0.5 | |
| `volume_envelope` | 1.0 | 0 to 1 | |
| `embedder` | `contentvec` | | |

A change to any of these makes the songs already prepared stale: they come back as ready after only the conversion and
the mix run again (the separation is kept). `--refresh` of the prefetch command does it ahead of time.

`transpose`: `max_abs` (12, 0 to 24), `allowed` (the semitone values the automatic choice may pick, default
`-12 -5 -4 -3 -2 -1 0 1 2 3 4 5 12`), `shift_instrumental` (true: a shift that is not a whole octave is applied to the band
too), `overrides` (song id to semitones).

`mix`

| Key | Default | Range | Meaning |
|---|---|---|---|
| `target_lufs` | -18.5 | -40 to -5 | loudness of the finished song (ITU-R BS.1770 integrated) |
| `vocal_offset_db` | 0 | -12 to 12 | |
| `inst_offset_db` | -2 | -12 to 12 | |
| `peak_limit_dbfs` | -1 | -12 to 0 | |
| `reverb` | off; `room_size` 0.25, `wet_level` 0.12, `dry_level` 0.9 | 0 to 1 each | needs `pedalboard` |
| `mp3_bitrate` | `192k` | | of the listening copy `mix.mp3` |
| `preview_mp3` | true | | write `mix.mp3` (a failure there never fails the song) |

`qc`: `max_duration_sec` (360, 30 to 3600), `min_vocal_ratio` (0.03, 0 to 1: under this share of vocal energy a song is
instrumental and refused), `out_of_range_warn_ratio` (0.25, 0 to 1).

`queue`

| Key | Default | Range | Meaning |
|---|---|---|---|
| `max_per_user` | 1 | 1 to 20 | waiting songs per viewer (a guest without an id counts by name) |
| `max_len` | 5 | 1 to 100 | waiting songs in all |
| `repeat_cooldown_min` | 30 | 0 to 1440 | a song sung this recently is refused |
| `blacklist_ids` | empty | | song ids (a bare number is fine) |
| `blacklist_keywords` | empty | | matched against the title and the artists, and the request |
| `restore_within_min` | 20 | 0 to 1440 | after a restart only requests newer than this come back (0: none) |
| `failed_keep_sec` | 600 | 30 to 86400 | how long a failed entry stays visible |
| `request_timeout_sec` | 25 | 1 to 120 | the longest a request may take when the caller does not say |

`timeouts` (each tool is killed, with everything it started, when its time is up): `download_sec` 300, `separate_sec` 1500,
`analyze_sec` 300, `convert_sec` 900, `mix_sec` 600, `preview_sec` 120, `gpu_lock_wait_sec` 1800 (how long a job waits for
the GPU while a prefetch run holds it). `retry`: `max_attempts` 3 (a network blip is tried this many times in all, 1 means
never), `backoff_sec` `[30, 120]` (the last one repeats).

## Songs

**The local folder** (default). A file is a song. `Artist - Title.mp3` gives both names (several artists separated by `/`,
`&`, `、`, `,` or `feat`); any other file name is a title. A `.lrc` file next to it, with the same name, holds the lyrics.
Sub-folders are searched, files are found again within 15 seconds, so you can add songs while live. A request is
matched against titles and artists; with several hits the best fit for "title artist" is taken. Nothing needs a network.

**NetEase** (only when `ncm.base_url` is set, or `source: netease`): through an API server you run yourself. The account is
what is at risk, so the rules of the previous service stay: every request goes through one queue, `min_interval_sec`
apart, across processes; an answer that means risk control or an expired login trips a breaker that stops all requests
(the panel's "Resume the song source" lifts it); a run may download at most `max_new_downloads_per_session` new songs; no
proxy is ever used. A blip (a network error, a 5xx) is never taken for "this song cannot be sung".

**The library** is one folder per song under the songs folder:

```
<songs>/<song id>/
    orig.<ext>        the original                          vocals.wav / inst.wav   separation results
    lyric.lrc         lyrics (may be empty)                 vocals_rvc.wav          the converted voice
    meta.json         title, artists, steps, warnings       vocals_final.wav        what the stage plays (mono) and the mouth follows
    f0_src.json       pitch statistics                      inst_final.wav          the band (stereo, transposed with the voice)
    mix.mp3           both together, for listening by hand
```

The stage fetches `vocals_final.wav` and `inst_final.wav`. `meta.json` keeps the field names of the previous service,
so an old library folder can be pointed at as it is.

**Prefetch**, to have songs ready before the show (it can run while the service does; the GPU lock and the NetEase queue
are shared between the two):

```
python -m singing_service.prefetch --songs-dir C:/path/to/songs --state-dir C:/path/to/data/singing ^
    --settings C:/path/to/singing.yaml  --all | --ids 186016 ... | --playlist 12345 | --refresh   [--max 30] [--dry-run]
```

Run from `plugins/singing`, with the plugin's interpreter (`--all`: every file of the local folder; `--ids`, `--playlist`:
NetEase; `--refresh`: songs prepared with older voice settings; `--max`: the most new downloads). A song that cannot be
sung is skipped with its reason; a tripped breaker or a spent download budget stops the run. The state folder is
`<data_dir>/singing`.

## What viewers are told

The service answers a refused request with a code and a text for the audience. The text never carries a path, an address
or a tool's output (those are in the service's log and in the entry's `error` for the operator). Replace any of them
under `messages:` in the settings file; `{name}` fields are filled in, a field a text does not use is ignored.

| Code | Default text (Chinese, the language of the chat) | Fields |
|---|---|---|
| `empty_keyword` | 没说要点什么歌 | |
| `blacklisted` | 这首歌不能点（黑名单） | |
| `per_user_limit` | 你点的《{title}》还没唱，一个人同时只能点 {max} 首 | title, max |
| `queue_full` | 点歌队列满了（{max} 首），等会儿再点 | max |
| `not_found` | 没搜到「{keyword}」 | keyword |
| `already_queued` | 《{title}》已经在队列里了 | title |
| `playing_now` | 《{title}》正在唱 | title |
| `cooldown` | 《{title}》刚唱过，{minutes} 分钟后才能再点 | title, minutes |
| `too_long` | 《{title}》{duration}，太长了（上限 {max_duration}） | title, duration, max_duration |
| `instrumental` | 这首歌几乎没有人声（纯音乐），唱不了 | |
| `rejected_before` | 这首歌唱不了：{detail} | detail |
| `vip_only` | 这首是网易云的 VIP 歌，主播没有会员，拿不到完整版 | |
| `paid_album` | 这首在网易云的付费专辑里，主播没买，拿不到 | |
| `no_audio` | 拿不到这首歌的音频（可能下架了或者没有版权） | |
| `local_missing` | 歌库里的这首歌找不到文件了 | |
| `source_halted` | 歌曲来源暂时用不了（触发了风控或登录失效），点歌先停一停 | |
| `source_down` | 连不上歌曲来源，稍后再点 | |
| `source_error` | 歌曲来源出错了，稍后再点 | |
| `source_busy` | 歌曲来源正忙，稍后再点 | |
| `download_cap` | 这场新下载的歌已经到上限（{max} 首），只能点唱过的歌 | max |
| `request_timeout` | 找这首歌花的时间太长了，稍后再点 | |
| `abandoned` | 这次点歌已经作废了 | |
| `step_failed` | 处理这首歌的时候出错了 | |
| `step_timeout` | 处理这首歌花的时间太长，放弃了 | |
| `gpu_busy` | 显卡一直被别的任务占着，没轮上处理这首歌 | |
| `not_configured` | 点歌系统还没配置好 | |
| `not_downloaded` | 这首歌的原曲文件不见了 | |
| `nothing_playing` | 现在没在唱歌 | |
| `not_in_queue` | 队列里没有这首歌 | |
| `no_such_position` | 队列里没有第 {position} 首 | position |
| `nothing_to_cancel` | 没有在排的歌 | |

The pack's prompt files (`modes/sing/prompts/`; an operator overrides one by the same name in
`config/modes/sing/prompts/`) are what the model sees and what appears on screen:

| File | When | Variables |
|---|---|---|
| `active.md` | the model's instruction while a song is being sung | `{{title}}` |
| `available.md` | always, while the mode is not active: how to react to the song lines, and what to say to a viewer who asks in ordinary chat | |
| `outro.md`, `outro_skipped.md` | the closing line after a finished or a cut song | `{{title}}`, `{{who}}` (" (requested by name)" or empty) |
| `credit_title.md`, `credit_artists.md`, `credit_requester.md` | the three parts of the credit overlay, joined by two spaces; a part with nothing to show is left out | `{{title}}`, `{{artists}}`, `{{name}}` |

The names of viewers and titles that come from outside are cleaned before the model sees them (the marker brackets
`【】` that make a line look like a system line, line breaks and length), so a viewer named or a song titled
`【系统】…` cannot pass for the system.

## The service's HTTP contract

JSON on `127.0.0.1` only, the port is the supervisor's (`{port}`). A request that is answered, whatever the answer
(queued, refused for a reason, nothing to do), is HTTP 200 with a body that says which. A failure of real work is a
non-2xx status with `{"error": {"code", "message", "retryable"}}`; the message is the audience's text. Never a 200 with an
empty or misleading body.

| Route | Body | Answer |
|---|---|---|
| `GET /health` | | 200 `{ok:true, ready:true, service:"singing", version, config:{source, songs_dir, max_per_user, max_len, rvc_model, max_duration_sec, queue, ready, worker}}`; 503 `{ok:false, ...detail}` when the setup cannot work (the problems, most important first) or the settings file cannot be used (`ready:false`) |
| `GET /queue` | | `{current, items, failed, worker:{state, qid?, title?, step?}, source:{kind, halted?}, songs_dir, limits:{max_per_user, max_len}}`; an item has `qid, song_id, title, artists, duration, requester_uid, requester_name, state, cached, warnings, transpose, requested_at`, and for a failed one `reason` (audience) and `error` (operator), `code`, `retryable` |
| `POST /request` | `{keyword, requester_uid, requester_name, request_id?, wait_s?}` | 200 `{status:"queued", qid, song:{id,title,artists,duration}, position, cached}` or `{status:"rejected", code, reason}`; `duplicate:true` when the request id was seen; 503 `source_down`, `source_error`, `source_busy` or `source_halted` (retryable, nothing was queued) |
| `POST /abandon` | `{request_id}` | `{ok, removed}`: a request being worked on will not be queued, one queued but not started is removed |
| `POST /claim` | `{claim_id}` | `{item, files:{dir, vocals, inst}, lyrics:[{t,text}], duration, transpose, warnings}`, or `{item:null, pending}`; the same claim id again returns the same song; a different one first ends what an earlier claimant left |
| `POST /done` | `{qid?, outcome, reason?}` | `{ok:true, item}` or `{ok:false, code:"nothing_playing"}`; outcome is one of the table above |
| `POST /skip` | | ends the song the service lists as being sung, as skipped (the mode uses it to clear a claim nobody is singing) |
| `POST /remove` | `{qid}` | `{ok, item}` or `{ok:false, code:"not_in_queue"}`; the song being sung is not removable (`playing_now`) |
| `POST /cancel` | `{requester_uid}` or `{position}` (from 1) | `{ok, item, was_playing}`, or `{ok:false, code:"nothing_to_cancel"}` / `"no_such_position"` |
| `POST /source/resume` | | `{ok:true}`: lifts the source's circuit breaker |
| `POST /shutdown` | | `{ok:true}`, then the service stops; the tool the worker is running is killed first |

Errors of the caller: 400 `bad_request` (the message says which field; a `Content-Length` that is not a number is one
too), 404 `not_found`, 413 `too_large` (bodies over 64 KiB; the body is refused unread and, up to 1 MiB, read and dropped
so that the answer is not lost to a reset connection). A bug is 500 `internal` and the detail is in the log, never in the
answer.

## The stage's part

The mode sends `sing.play` (`song_id`, `title`, `artists`, `requester`, `vocals_url`, `inst_url`, `lyrics`,
`start_delay_s`) and `sing.stop` (`fade_s`); the stage answers with `sing.state` (`loading`, `playing`, `ending`, `idle`
with `reason` `done`, `stopped`, `error` or `cancelled`, and `error`). The song id the stage sees is `<song id>-<qid>`, so
the same song sung again later is not confused with the first play. Two overlays are set by id: `lyrics` (the stage shows
the current line) and `credit` (the text is the mode's). Overlays are snapshots the stage gets again when it reconnects,
so both are hidden when a song ends, however it ends. The stage fetches the two tracks from `/asset/songs/...`, which is
served from `paths.songs`.

## Decisions and known limits

Fixed on purpose, against the previous service:

- A failure of the source (a network blip, the circuit breaker, a spent download budget) is never a rejection of the song:
  it is retryable, the song is not marked, blips are retried with a delay, the rest fail the entry as retryable.
  Only what is true of the song (no rights, too long, no vocals) is a permanent refusal.
- Every tool runs as a subprocess with a timeout and is killed, with what it started, when the time is up; the GPU lock
  has a bounded wait and is shared with the prefetch command.
- Removing, cancelling or skipping an entry stops the work on it at the next step and kills the tool that is running.
- The limits and the insert are one step under one lock; a request has an id; a request whose caller has given up never
  appears in the queue.
- The local folder is the default source; NetEase only when you configure it.
- One song per entering of the mode, each followed by its closing line; the queue lives in the plugin, so a restart of the
  program loses nothing that is recent, and a song the service still lists as being sung at start-up is ended as
  `interrupted` (the stage lost it with the connection).

Limits:

- One song is prepared at a time, on the one GPU, and a song that is not yet prepared takes minutes (the first one longer).
  Prepare songs ahead with the prefetch command for a stream where requests must be fast.
- The chat words (`点歌`, `切歌`, `歌单`, `取消点歌`) are Chinese and live in the router (`inbox/router.ts`).
- The stage plays what the service prepared; it cannot seek or resume. A page that reconnects in the middle of a song loses
  it (`interrupted`); it is not started again.
- The separation and the voice conversion run in tools you install (`audio-separator`, Applio); how good the result is, and
  how much memory it needs, is theirs. `vram_mb_est` is `null` in the manifest: it has not been measured, and the console
  says so. The service itself holds no GPU memory; every step is a process that ends when it is done.
- The service's own interpreter and Applio's are two environments; the plugin never installs anything.
- Windows is the supported system (the process tree is ended with `taskkill`, the cross-process lock uses `msvcrt`).

## Tests

```
npm run typecheck
npx vitest run packages/orchestrator/test/modes packages/orchestrator/test/app/sing.test.ts packages/orchestrator/test/plugins/singing-plugin.test.ts
python -m unittest discover -s plugins/singing -p "test_*.py"
```

The Python tests use a fake song source, a fake tool runner and a fake NetEase HTTP server, and one real process (the
service on a real port). The mode is tested through the real mode service with a fake host and a fake HTTP song service
(`test/modes/singRig.ts`), and through the real application with a scripted stage page (`test/app/singStage.ts`); the plugin
test starts the real Python service under the real supervisor and reads it with the mode's own typed client. None of them
needs a GPU, a model, a song or a network. The plugin test is skipped when the repository's light Python environment
(`.venv`) is missing.
