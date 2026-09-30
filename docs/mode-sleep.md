# Sleep mode

Pack: `modes/sleep/`, controller `packages/orchestrator/src/modes/controllers/sleep.ts` (plus `sleepTracks.ts`,
`sleepRound.ts`, `sleepPanel.ts`). A long prerendered whisper track plays on the stage, the character looks calm, and
chat is answered only now and then, in a whisper. It interrupts every other mode while it runs, and no other mode can
start until it ends (`priority: 100`, `preempts: true`).

The tracks are made offline (a script writes the lines, a voice model whispers them, the pieces are joined); making them
is not part of this program. Real-time whisper synthesis beyond the model's normal reply is not attempted either: the
whisper of a reply is the speech service speaking in a reference recording called `whisper`.

## Switching it on

```yaml
# config/animatus.config.yaml
paths:
  asmr: C:/path/to/asmr                # the tracks, see below

tts:
  styles:
    neutral: { ref_audio: C:/path/to/reference/neutral.wav, ref_text: What the recording says. }
    whisper: { ref_audio: C:/path/to/reference/whisper.wav, ref_text: What the whispered recording says. }
  default_style: neutral

stage:
  presets:
    backgrounds:
      night: { kind: image, url: /asset/models/night.png, dim: 0.3 }    # or { kind: color, color: "#0a1020" }

inbox:
  sleep:                               # when chat is answered while it runs (already part of the inbox)
    enabled: true
    first_reply_after_sec: 30          # the first reply this long after the mode starts
    reply_interval_sec: 90             # then at most one per this long
    max_age_sec: 180                   # a chat line that has waited longer than this is dropped

modes:
  sleep:
    enabled: true
    config:                            # all optional, the numbers below are the defaults
      volume: 1
      fade_in_s: 1.5
      fade_s: 1
      reply_resume_delay_s: 1.5
      reply_max_wait_s: 120
      start_timeout_s: 20
      shuffle: false
      loop: true
      captions: true
      whisper_style: whisper
```

Without a `whisper` entry in `tts.styles` the mode still runs, but the speech service falls back to its default voice,
so a whispered reply would be spoken normally in the middle of the night: an alarm (`sleep_whisper_style`) is raised the
moment the mode starts and stays until it ends, and the panel says so. Without a `night` background preset there is a
`mode_stage_preset` alarm while the mode runs; the rest of the look still applies, and `dim` (below) darkens the stage
without a picture.

## Settings (`modes.sleep.config`)

A strict object: an unknown key or a value out of bounds stops the program at start-up with a message that names it.

| Key | Default | Bounds | Meaning |
|---|---|---|---|
| `volume` | 1 | 0 to 1 | How loud the track is. The console can change it while the mode runs; that lasts until the program restarts. |
| `fade_in_s` | 1.5 | 0 to 10 | Fade-in of a track when it starts and when it comes back after a reply. |
| `fade_s` | 1 | 0 to 10 | Fade-out when the track gives way to a reply and when the mode ends. The voice is held for this long so the whisper never lands on the fading track. |
| `reply_resume_delay_s` | 1.5 | 0 to 30 | How long everything must stay quiet after a reply before the track comes back. |
| `reply_max_wait_s` | 120 | 5 to 600 | The longest a reply may keep the track waiting; after this it comes back whatever is going on. |
| `start_timeout_s` | 20 | 5 to 120 | The stage must report a track as playing within this long, or the track counts as failed and the next is tried. |
| `shuffle` | false | | Random order, each track once per round; a round never starts with the track heard last. |
| `loop` | true | | Start over after the last track. `false` stops there; whispered replies still work. |
| `captions` | true | | Send each track's caption timeline to the stage (it shows on the `subtitle` overlay while that is switched on in `stage.subtitle`). |
| `whisper_style` | `whisper` | 1 to 32 characters | The key in `tts.styles` that everything is spoken in while the mode is active. |

## The tracks

```
C:/path/to/asmr/
  rain.mp3            one track, "rain": of several formats the first of mp3, ogg, m4a, flac, wav is used
  rain.wav            (not used: the mp3 is smaller and streams better)
  rain.json           the timings of rain (optional)
  night/ocean.ogg     a track called "night/ocean": folders down to three levels are read
  _drafts/, .old/     ignored: a folder or file whose name starts with "_" or "."
```

The stage fetches a track from `/asset/asmr/<path>` (served with `Range`, so a long track is streamed, not loaded whole).
Files whose names the asset route would refuse (`:`, `?`, a trailing dot, a device name...) are left out and listed on the
panel with the reason, as are empty files, names longer than 120 characters, folders deeper than three levels and anything
beyond the first 500 tracks. The list is read again when the mode starts, and at most every 15 seconds while the console
looks at the panel.

The timing file is JSON: `lines` is a list of `{ "text": "...", "start": 1.5, "end": 4.2 }` (seconds from the start of
the track) and `duration_s` is optional; every other field is ignored. Lines with no text, times that are not numbers or
not in order are dropped, the rest are sorted by start (at most 5000 lines, 2000 characters each: the protocol's limits),
and what was dropped is noted on the track's row. A file that is not JSON, is not an object, or is bigger than 4 MiB is
not used and the track plays without captions.

## What it does

**Entering** (console, hotkey `ctrl+alt+n`, or `POST /api/modes/sleep/enter`): the manager first interrupts every other
mode. Then, in one step: `flags.sleeping` goes up (the pacer now serves only the one chat line at a time, marked `【助眠】`;
paid messages, gifts and songs wait for the mode to end), what is being said stops, the voice style becomes `whisper`, and
the first track is sent (`sleep.play`). The mode is active as soon as that is done (the framework then gives the stage the
calm look from the pack); it does not wait for the stage to say the track is playing. The first track is the one after the last that played
(remembered in `data/sleep-state.json`), so the next night does not always begin the same way; with `shuffle`, or a track
named by the console, or `loop: false`, that rule is not used.

**The look** is the pack's `stage:` section, applied and taken away by the mode framework: `calm 1`, `motion_scale 1`,
`mouth_scale 0.4`, `lip_range {min -2.6, max -1.0}` are the legacy values measured on a real whisper (0.4 for the motion
made the character look frozen; the default analyser window saturated 45 % of the frames of a whisper), `light 0.6` and
`dim 0.4` are a dim night look that has not been measured on the real stage (the stage lays a translucent deep-blue veil
of strength `dim × 0.65` over the background, a picture included). There are no motion tags or talk gestures while the
look is calm (the stage ignores a motion tag then), and the mode's prompt tells the model not to write any. To change the
look, copy `modes/sleep/mode.yaml` to `config/modes/sleep/mode.yaml` and edit the copy.

**The playlist**: when the stage reports a track ended, the next starts (`sleep.play` with `fade_in_s`); after the last,
the first again, unless `loop` is off. A track the stage reports as failed, or does not start within `start_timeout_s`, is
skipped and noted in the run log; it is tried again in the next round. When every track has failed in a row it stops trying
and raises `sleep_tracks` (error) with the last reason; the mode stays up for the whispers, and playing a track from the
console (or a new stage page) tries again. With no track at all (`paths.asmr` not set, an empty folder) the mode runs as
"whispered replies only", says so on its panel, and raises `sleep_tracks` (warn); a track that appears later starts playing
by itself.

**A reply**: when the pacer's chat line reaches the controller, the track fades out (`sleep.pause`, `fade_s`), the voice
is held until the fade is over, the model is given the pack's `reply` prompt (see below) for that one reply and answers in
the whisper voice, and once nothing has been said, generated or queued for a moment (`whenQuiet`) plus
`reply_resume_delay_s`, the track comes back from where it was (`sleep.resume`, `fade_in_s`). A reply that never gets
spoken (the model failed, the reply was dropped) still lets the track come back, and so does one that takes longer than
`reply_max_wait_s`. Two replies at once are one pause and one resume; if something starts talking again during the wait,
the track waits for that too. A track that ends or fails during a reply is followed by the next one after it, never on
top of it.

**The stage page coming and going**: commands are not re-sent to a page that connects later, so the controller sends the
current track again from its beginning when a page connects (a page that replaces another gets it too). Nothing is lost if
the page is away when a reply ends: the track is sent when it returns.

**Leaving** (console, `POST /api/modes/sleep/exit`, a shutdown): `sleep.stop` with `fade_s`, the voice style and the flag
go back, the look and the background are put back by the framework, alarms are cleared, nothing is left held. A reply that
was being whispered is cut off rather than finished in the normal voice.

## The console

The Modes page shows a panel: a status line, facts (tracks found and where, whether the whisper voice exists, volume, when
chat is answered, order), and four buttons: **Next track**, **Set the volume** (input 0 to 1), **Whisper a test line**
(input: the line, by default the pack's `whisper_test` prompt; it goes through the same pause and resume and needs no
model) and **Stop sleep mode**; the tracks are a list with two buttons on each row: **Play now**, which also starts the
mode from that track when it is not running, and **Skip**: on the track that is playing it moves on (as **Next track**
does), on one that is still to come in this round it leaves that track out of the rest of the round (it is back in the
next), and on any other it says why it is off. The volume of a track that is playing changes by a pause and a resume with a half-second
fade (the stage has no live volume message), so it dips and swells back; a track that is loading or waiting for a reply
gets the new volume when it plays or comes back.

Through the API (all `POST`, body `{ "params": { ... } }`, a refusal is HTTP 409 with the reason as its message):

| Request | Effect |
|---|---|
| `/api/modes/sleep/enter` | Start the mode. `params.track` (a track's name, case does not matter) starts on that track; an unknown name is refused (`there is no track "x"`); when the mode is running it jumps to it. |
| `/api/modes/sleep/exit` | Leave the mode. |
| `/api/modes/sleep/act` with `params.action` | `next`, `play` (with `row` or `track`), `skip` (with `row` or `track`; without one it is the track that plays; refused when nothing is playing, when the track does not exist, or when it is not coming up in this round), `volume` (`params.volume`, a number 0 to 1: it is clamped, anything else is refused), `whisper_test` (`params.text` optional, at most 200 characters), `stop`. `next`, `skip`, `whisper_test` and `stop` are refused with `sleep mode is not running` when it is not. |

## What the model is told

Prompts of the pack (`modes/sleep/prompts/`; an operator replaces one by a file of the same name in
`config/modes/sleep/prompts/`, without copying the rest). None of them names the character or the streamer, and none
carries a viewer's words.

| File | When |
|---|---|
| `active.md` | With every reply while the mode is active: it is sleep time, only lines marked `【助眠】` are for you, hushed and short, nothing that could wake anyone, emotion tags only `[neutral]` or `[relaxed]`, never a motion tag. |
| `reply.md` | Added to the one reply that answers a chat line: one or two very short whispered sentences, about five to sixteen characters (or three to eight words) each, end by telling them to sleep, no questions, exclamations, emoji or brackets, say only the readable part of the viewer's name. |
| `whisper_test.md` | The default text of the console's test line. |

The chat line itself reaches the model as the user message, `【助眠】<name>：<text>`; the router has already replaced any
`【】` in what a viewer typed, so a viewer cannot forge the marker.

## Alarms

| Code | Level | Raised | Cleared |
|---|---|---|---|
| `sleep_whisper_style` | warn | the mode starts and `tts.styles` has no `whisper_style` entry | the mode ends |
| `sleep_tracks` | warn | there is no track to play (no `paths.asmr`, an empty folder, a folder that cannot be read) | a track is found, or the mode ends |
| `sleep_tracks` | error | every track failed in a row | a track is played from the console, a stage page connects (it comes back if those fail too), or the mode ends |

A mode that fails to start is the manager's `mode_start_failed`; a stage that is not connected is the application's
`stage_disconnected`. A folder that cannot be read for a moment (a network share) keeps the list it had and shows the
reason on the panel; reading it is given up after 10 seconds.

## Files

`data/sleep-state.json`: `{ "last_track": "rain" }`, the track that played last. A file that is torn, holds something
else, or names a track that is gone is ignored. Nothing else is kept; the volume set from the console is not.

## Limits, and what has not been measured

- The controller and the stage are tested against a stand-in for the page that follows the real stage's rules (`pause`
  only acts on a playing track, reports arrive after the change); nothing here has been run against the real stage window,
  the real speech service or a real track.
- `light 0.6` and `dim 0.4` of the look are not measured. The whisper voice's quality and loudness against the track are the
  operator's to judge; use the test-line button before going live.
- The track is away for the whole reply and the quiet after it (a moment of quiet that the application waits for, then
  `reply_resume_delay_s`), not for the length of the audio alone. How long that feels was not measured.
- Chat replies are the pacer's (`inbox.sleep`); to switch them off set `inbox.sleep.enabled: false` (the panel says so).
  A reply is not skipped by this mode: a chat line that reaches the model always gets its pause and resume.
- A second stage page connecting while the first is playing moves the track to the new page from its beginning.
- The position of a paused track is the stage's; a page that reloads loses it.
