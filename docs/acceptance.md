# Acceptance results

What was actually run against each phase's pass criteria, and what was not. Numbers come from runs on the
development machine (Windows 11, Chrome 154, NVIDIA GPU for speech, the stage window on the integrated GPU).

## P1: the stage

`npm run replay -w @animatus/orchestrator -- <scenario.json> --duration 1800`: the orchestrator's stage server
plus a real Chrome window in app mode (1280×720). The model is a 47 MB VRM 0 humanoid (44 blend shapes, 220
spring joints, four metres tall). Twenty prerecorded utterances are spoken in random order with motion tags, and
two dances start at 7 and 21 minutes.

| Check | Limit | Result |
|---|---|---|
| Utterances played | | 269, every one ended `done` |
| AudioContexts created | 1 | 1 |
| T-pose frames | 0 | 0 of 184,385 |
| Underruns | at most 3 per minute | 0 in 30.1 minutes |
| Stage disconnects | 0 | 0 |
| Dances | 2 | 2 completed, 0 failed |
| JS heap | not growing | 155 to 176 MB throughout |
| Frame time (p95) | | 16 to 17 ms |

Verdict: **PASS** after 30 min 06 s.

Also checked by eye in the same window: textures, blink, wLipSync vowel shapes (same-origin worklet and
WebAssembly, so the strict Content-Security-Policy holds), both dances with music and credit line, and the
camera fit for head, upper body and full body.

## P2: brain, speech scheduling, chat source

Evidence so far:

- **Router and pacer against the legacy chat bridge.** 1,300 random scripts (350,000 events, 9,800 pacer sends)
  were run through the legacy Python code and through the port: zero differences. A replay of one real day of
  the bridge's own log (538 chat messages, all timestamps taken from the log): 388 of 388 accept decisions and
  42 of 42 drop reasons identical, 108 of 108 song commands recognised, 174 of 178 sent batches identical text
  for text. The other four follow songs, whose end time is not in the log.
- **The whole chain with the real parts.** Real stage window, real GPT-SoVITS started by the plugin supervisor
  from the shipped manifest, a scripted stand-in for the model. Four audience events (three chat lines and a
  gift) became four batches in the legacy line format and eleven spoken sentences with emotion and motion tags.
  First sentence of a reply: 0.85 to 1.6 s after it was queued once the synthesiser is warm, and about 7 s for
  the very first one after start-up (the synthesiser compiles kernels on first use), which is why it is warmed
  up before it is attached and why the pacer holds the audience's messages until then.
- **With a real model.** The same chain with Gemini (`gemini-3.5-flash-lite` through the proxy the machine needs,
  `thinking_level: minimal`): four audience events, four replies (emotion and motion tags, subtitles, speech), no
  alarms. Time to the first visible text 1.6 to 3.1 s, whole reply 1.7 to 3.2 s. The legacy stream's own round
  logs (1,231 replies, same model) show a median of 2.0 s to first text (p90 3.5 s) and 2.4 s in total (p90 4.0 s),
  so the new path is in the same range on this small sample. The first attempt failed loudly with HTTP 400: the
  Gemini 3 family rejects `thinkingBudget: 0`; the alarm now carries the provider's own words and there is a
  `thinking_level` setting.
- **Automated tests** cover the app end to end with a real stage server and a scripted page, including the
  failure paths: model failure, one sentence that cannot be synthesised, stage disconnect, no model provider,
  missing key, speech service warming up, speech service that stops answering.
- **A 30-minute chat soak through the whole chain.** Forty scripted lines from ten made-up viewers, one every
  10 to 25 seconds, through router, pacer, the real Gemini model (`gemini-3.5-flash-lite`), real GPT-SoVITS started
  by the supervisor, and a real Chrome stage window with the 47 MB model. Verdict: **PASS** after 30.8 minutes.

  | Check | Limit | Result |
  |---|---|---|
  | Audience lines in / model replies | | 100 in (some merged, as designed), 91 replies completed, 0 failed, 0 cancelled |
  | Sentences spoken | | 270 |
  | Time to the first visible text | | median 1.7 s, p90 2.6 s |
  | Speech synthesis per sentence (median) | | 1.5 s |
  | T-pose frames | 0 | 0 of 242,092 |
  | Underruns | at most 3 per minute | 0 in 30.8 minutes |
  | AudioContexts | 1 | 1 |
  | Stage disconnects / stage alarms | 0 | 0 / none |
  | Orchestrator memory growth | under 300 MB | +16 MB (100 to 111 MB) |
  | Stage frame rate | | 104 to 155 fps, JS heap 143 to 174 MB |

  One caveat: the very first attempt at a whole-chain run (before the synthesiser was warmed up and before the
  45-second request timeout and the restart watchdog existed) stalled after its first reply; the speech server
  was found unhealthy 23 seconds in. It did not reproduce on the following runs, including this one, and its cause
  is not known. The mitigations are in, and the alarm says so if it happens again.
- **The console** runs over the real application (`npm start` prints its address once), and is covered by tests
  of the backend against a real app.

Not yet done: nothing for P2.

## P3: modes

- **The mode framework** (state machine, admission by measured memory, exclusions and priorities, mode packs
  read from folders, controllers with a narrow host, the console's Modes page) is covered by unit tests of the
  manager, the admission matrix, the pack loader, the measurement file, the service (views, refusals, prompts,
  hooks) and the dance controller against a fake host and stage; and end to end through the whole application
  with a real stage server and a scripted page.
- **Dance.** End to end: a dance gift gives the model the line "you are about to dance", the reply is spoken, the
  dance plays with the voice held, the model is told and says a closing line, and chat that arrived meanwhile is
  answered after it, in that order; the model's own `[motion:dance:name]` tag; the cooldown (prompt and gift
  answers change, the console is exempt); a stop from the console (no closing line, cooldown starts); a stage that
  cannot load the dance (alarm with the stage's words, nothing left held); a shutdown mid-dance and one while a dance
  is waiting for the reply to finish. The tests found four faults that were fixed: a dance that ended by itself was
  treated as cut short, so the closing line was never said; the saved state could be overwritten by a read that
  finished late; two writes to the same state file could interleave; and stopping a mode that was still starting
  waited for the start to time out.
- **Graphics memory.** Forge and GPT-SoVITS together were measured (10.0 GB peak on a 12 GB card, the memory fell back to
  the speech-only level when Forge exited; docs/vram-measurements.md) and are entered in `data/vram-measured.json` for this
  machine. Changing the maximum size makes the admission verdicts change (a test through the mode service: nothing measured at
  a new size, so the estimate applies and says "not measured"). A running probe is told when every mode starts and ends
  (`vram.probe_port`; tested with a stand-in server, and a probe that is not there is ignored). **Not done:** measuring each
  of the other modes' services (singing, the screen capture, a local model) and the fall-back to the resident set after each
  mode; only Forge has been.
- **Not yet done:** dance against the real stage window (the stage's own dance code has its own tests and was seen in the
  P1 run); no mode other than dance has run against the real stage, speech service or a real model.

## Sleep mode (docs/mode-sleep.md)

- **Tested:** 116 tests, all green: the controller through the real mode service with a fake host and fake timers
  (71), the pure modules (32), end to end through the real application with a real stage server and a page that
  answers the sleep messages (12, about 11 s), and one seeded random test (120 seeds of 80 steps by default, 4,000
  also clean) that races entering and leaving, replays odd stage reports, and checks after every step the flag, the
  voice, the holds, the alarms, that nothing is spoken on top of a whisper, and that leaving leaves no timer, hold or
  flag. The tests found and fixed: a retry lost when a page connected in the middle of a reply after every track had
  failed, a volume set while a track loads that never applied, a track cap that counted skipped names.
- **Not verified:** nothing ran against the real stage window, the real speech service or a real track. The stage side
  is modelled on the stage's own sleep code. Not measured: how the light and dim values look on screen, whisper
  loudness against the track, how long a reply takes the track away. The stage has no live volume message, so a
  volume change on a playing track is a pause and a resume with a short fade.

## Commentary mode and the screencap service (docs/mode-commentary.md)

- **Tested:** 207 TypeScript tests (units, the capture client, the controller through the real mode service, the
  failure paths, the panel actions, a real socket, end to end through the real application) and 75 Python tests for
  the capture service (68 by default; the 7 opt-in tests that capture real windows, including one of a DPI-unaware
  program, also pass). Key behaviours were broken on purpose and the tests failed.
- **With the real services** (the real application, Gemini, GPT-SoVITS and a Chrome stage window; the mode entered
  through the console's API): the window list held every open window with its program and size; a window that was
  minimised was reported on the panel and as the `commentary_capture` alarm, in words that say what to do; once it was
  restored the capture (1902x1112, sent as 768x449, by PrintWindow) went to the model, which read a text-only mock
  of a game screen (a boss fight, a score line) and said so, and said it did not know which game it was (confidence 0.0
  to 0.3, the window was a text editor), in three comments over about a minute, each spoken with an emotion and, in
  two of them, a pose from the motion library. Leaving the mode stopped the capture service.
- **Not verified:** real games (exclusive fullscreen is black by nature, elevated programs' windows, DRM video,
  mixed-DPI monitors), the console page drawing the mode's panel in that run (the panel's data was read through the
  API), and the cost and quality of a comment over a long session (the cost is by construction: one small reading call
  and one spoken call with one 768 px picture).
- A picture sent to the model can carry writing, so `tellBrain` with pictures is untrusted whatever the mode
  says (see P5).

## The Worker protocol (docs/workers.md)

- **Tested:** the client and the events feed against a fake worker that follows the spec (25 tests: state checked against the
  protocol, a wrong worker refused, a bad or huge answer, a worker that never answers is a timeout and one that is gone is
  unreachable, directives checked before they are sent, pages of events read whole and none twice, and a restart noticed: a
  reader that had seen 200 events and then meets a new run that has said 120 gets all 120, and one that meets a run that
  has said more than it had seen gets them all too); the adapter for the older link against a fake of it (10 more: both
  agents' status mapped, the restart noticed from the numbers going backwards, and the case it cannot notice written down
  as a test); the Python kit (22 tests: the state's rules, every route over real HTTP, the host check, body limits, thread
  safety) and the demo worker (4, plus one through the real supervisor and the real process: it starts paused, plays when told,
  takes a directive, forgets, pauses, and a restart is a new epoch that a reader with the old one is told to start over from).
- **Not verified:** a real Civilization VI or Minecraft agent behind the adapter, and a real game. The older agents' own
  code is not changed.

## Sing mode and the singing service (docs/mode-sing.md)

- **Tested:** 247 Python tests (with fakes for the song source, the runner, the clock and a fake NetEase server, and one real
  process) and 109 TypeScript tests (the typed client, the controller through the mode service with a fake song service, the
  panel, alarms, the failure lines, restarts, the mode through the whole application with a scripted stage page, and six that
  run the real Python service under the real supervisor with the mode's own client). Found and fixed: the service lost its
  413 answer to a reset connection when the caller was still sending (3 of 10 runs), and a non-numeric Content-Length dropped
  the connection.
- **Not verified:** real audio-separator, Applio and RVC, GPU use and memory, a real NetEase API server, the real stage page
  playing the tracks and lyrics (only a scripted page), real chat, loudness (only synthetic signals), killing a real tree of
  child processes. Graphics memory is not measured, and the pack lists no required service, so admission does not see the
  singing service's memory (the pack excludes the other modes that use the GPU).

## Draw mode and the Forge service (docs/mode-draw.md)

- **Tested:** 125 Python tests (the service against a fake Forge and a fake rating model, and as a real process) and
  178 TypeScript tests (the controller through the real mode service, end to end through the real application with a
  scripted stage page, the client, the planner, and seven tests that run the real Python service as a process through the
  real supervisor). The tests found and fixed: a request cancelled from the panel left "drawing" on the frame, a late
  answer after leaving the mode could change the frame, a raid of blocked requests could flood the voice, a start the
  manager aborts after it finished left the mode switched on, and a prompt whose every tag was blocked still drew a
  generic picture.
- **Not verified:** a real Forge (whether it honours the checkpoint override and the unload call), the real rating model
  on real pictures (a 400 MB download; the tests use a fake), graphics memory (not measured), planning quality with a
  real model, the frame on a real stage window. The safety layers are a blocklist, forced tags and negatives, and a
  rating model that is a classifier and can be wrong.

## P4: memory

Pass criteria: a human edit of one line is in effect in the next sentence; rollback works; recall latency has a
measured number.

- **An edit is in the next reply, a rollback too.** End to end through the real application (a real stage server, a
  scripted stage page and model, the real memory store with real git): the streamer's line about the channel mascot
  is in the prompt of the first reply; one line changed through the store as the console does it is in the next reply
  and the old text is not; rolling the file back is in the reply after that. The same for a rule in memory's
  `persona/` folder. Also through the console's own HTTP routes (12 tests) and, by hand, in the console page of a
  running application: edit an agent line (it becomes the streamer's), lock a line, read the history, see the changes
  of one commit, restore the first version, approve a proposal, forget a viewer.
- **Recall latency** (synthetic memory, keyword search, 2,000 lookups each): 300 viewers (302 files, about 2,700
  lines) median 0.10 ms, 95th percentile 0.26 ms, slowest 0.9 ms; 3,000 viewers (3,002 files, about 27,000 lines)
  median 0.64 ms, 95th percentile 2.7 ms, slowest 5.7 ms; building that index at start-up takes 3.2 s.
- **The rules hold** (tests of the store): the program cannot change or remove a line the streamer wrote (locked or
  not) nor a viewer's; a stale hash or a line that moved is a conflict, never an overwrite; a viewer's words cannot
  carry a marker or a source tag of their own; "forget me" leaves nothing (viewer files are not in the history); the
  consolidation pass throws away a fact whose quote is not in the viewer's messages and anything the sensitive-word
  list matches, and a message that gives orders changes nothing.
- The tests found and fixed: a rollback to a revision that does not exist was taken for "the file did not exist then"
  and deleted the file; two settings of the tokenizer that made ordinary Chinese wording miss ("你养猫吗" did not find
  "养了一只猫"); an absolute score threshold that let nothing through on a small memory; the streamer's edit being
  committed after the call returned (so a fast second edit was folded into the first commit).
- Not done: an embedding model for recall (keyword search only); memory facts from other modes (a song a viewer asked
  for); a soak of the consolidation pass against a real model on a real stream's inbox.

## P5: tools, approvals, injection

Pass criteria (brief section 12): a set of chat injections is all stopped, and the audience cannot trigger a
high-privilege tool. The first half of P5 (the tool gate and the approval desk) is done; automations, the safety
observer as its own part and the unified worker protocol are not yet.

- **The injection suite** (`test/app/tools.test.ts`, 22 tests, about 17 s) runs the real program: real inbox, brain,
  tool gate, modes, memory and console backend, with only the model, the voice and the stage page scripted. The model
  is scripted to be *compromised*: whenever the last message holds a trigger word it obeys, and asks for a mode
  to be started, ended and a false fact to be remembered, all in one reply. Results: a viewer's message gets all three
  refused (`untrusted_origin`), none queued, no mode entered, no memory file written, and three lines in the audit
  trail on disk; the same for a flood of messages from six different viewers, for a viewer who claims to be a
  moderator (in words and with the markers), for a moderator's line and a viewer's line in the same batch (the whole
  reply counts as the audience's), for a tool that does not exist, is switched off or has bad arguments, and for a
  fence typed in chat (nothing reads it). The model is told only that a call was "not allowed here".
- **The ways in that used to be trusted** are closed: a mode's `tellBrain` is untrusted unless the mode says the
  text is the program's own words (and never with pictures); the answer to "forget me" carries the viewer's name and
  is untrusted.
- **Staff can ask, the streamer decides.** A moderator's or the streamer's request is queued and nothing runs
  before the console says yes; approving runs the stored arguments once (a second approval and an approval after a
  denial are 409), the tool's own summary is what the console shows, and the model hears the outcome on its next
  reply. A stage page cannot approve or queue anything whatever it sends, and words in chat cannot either.
- **The tests have teeth.** With the gate changed to treat every origin as privileged, 9 of the 22 fail; with the
  turn's trust taken from the strongest line instead of the weakest, the mixed-batch test fails; with `tellBrain`
  or the "forget me" answer made privileged, their tests fail.
- **Console:** the approval routes over the real server and the real gate (11 tests: token, other origin, ids, methods,
  one decision only, the event pushed to open consoles, a queued call listed with its summary and run once) and the
  page (10 tests, and the tab count in the app).
- **With a real model** (Gemini, 3 runs of each case, the model only, no speech): plain chat asked for no tool (0 of
  3); a viewer asking it to pass something on to the streamer used the free tool in 2 of 3; the streamer's own request
  to end a mode was queued in 2 of 3; a moderator's request to remember a fact in 1 of 3, and to start a mode in 0 of
  3 (it answered that a mode "needs approval" instead of asking for the tool). None of the three injections (an
  outright order, a fake system notice with a tool block typed in, a claim to be the streamer) made it ask for
  anything, 0 of 9: the persona already tells it not to follow orders in chat, and the gate would have refused them.
  So the mechanism works with a real model, and a small model is hesitant about the tools that change things. The
  reasons a reply hesitates were not investigated further.
- **By hand, in the real console page** (the real application, its own gate): the tab's count, three requests listed
  with who asked and how far they were trusted, markup in a request shown as text, an approval (the memory file got
  its `[agent]` line and the audit trail its line), an approval of a mode start (it answers that the mode was asked
  to start; a mode may only start once the speech is quiet), a denial (nothing written), and the audience's own
  request absent from the list.
- **Not done:** the prompt block has not been tuned for reliability beyond the above.

### The last check before the voice (docs/safety.md)

- **Tested:** 30 unit tests (each shape replaced in Chinese and English context, thirteen kinds of ordinary text left alone
  including dates, versions, prices and durations, one report per sentence, the loop rule and its window) and 5 through the
  whole program (a phone number, a link and an email replaced in the voice and on screen, a run log line naming the class and
  never the thing, ordinary numbers untouched, a stuck model's repeats not spoken with the alarm raised and cleared, the
  settings). Found on the way: the sentence cutter split `https://example.com/x` after `example.`, so no check on a
  sentence could see a whole link; it now keeps links and email addresses whole (six new cases, the 304 old ones unchanged).
- **Not verified:** how often the shapes hit something they should not, or miss something they should, in a real stream's
  speech; a bare domain (`example.com`) is not recognised.

### Automations (docs/automations.md)

- **Tested:** 27 unit tests (the shape of a rule and its placeholders, what each action does, the trust of a reply and of
  a tool call after an audience event and after a program event, cooldowns, the per-minute limit, the queue, timers on a
  fake clock, an action that throws) and 12 through the whole program (a stream end that speaks and runs the memory pass, a
  quiet room that speaks instead of the default line, a mode starting, a paid message above a price, a guard purchase
  whose reply is answered by a model that obeys the audience and gets both of its tool calls refused, a name that cannot
  carry a marker, a free note as the viewer, an approval tool queued as the system's after a program event and refused
  after an audience one, and chat that runs no rule). Changing the trust of either path makes their tests fail.
- **Not verified:** the platform's stream start and end messages against a live room (the source turns the library's
  `onLiveStart` and `onLiveEnd` into an event; tested with a fake library); rules on a real stream.
- **Known limit** (written in [tools.md](tools.md)): the gate cannot tell whether a moderator's own request is what they
  meant, and a model steered by the audience earlier in the conversation can misjudge a later moderator request; the
  streamer's yes is the safeguard for both.

## P6: release

Pass criterion (brief section 12): on a clean machine, following the documentation from zero, a basic chat works.

- **A clean clone, by the documentation** ([getting-started.md](getting-started.md)). The committed state was cloned to a
  new folder and, there: `npm install` (5 s with a warm npm cache), `npm run build` (2 s), `npm run typecheck` (clean),
  `npm test` (161 files, 3820 tests passed and 33 skipped, 28 s; the skipped ones need the light Python environment, a
  folder of motions or a live room that the clone does not have). Then `npm run setup` (answers piped in with
  `--stdin`), `npm run doctor` (ready), `npm start`, and a first chat with the real Gemini, a real GPT-SoVITS and a real
  Chrome stage window: an injected message became three spoken sentences with the subtitle, the face of the tagged
  emotion and the mouth following the voice, and the stage reported the start of each sentence. That run used a sample
  avatar (VRM 0), no motion folder and no lip-sync profile.
- **What that run found, all fixed and covered by tests.** The setup did not ask for GPT-SoVITS's inference config
  (`tts_config`), which the plugin requires, so the plugin failed on a placeholder in its command line: the setup and
  the doctor know it now, the doctor names any enabled plugin's missing required setting, and the supervisor says
  `plugins.<id>.config.<key> is not set: ...`. The speech plugin's job guard needed the light Python environment, so it
  could not start without `uv sync`: the guard now runs on the plugin's own Python when the shared one is absent. A
  fresh install stood in a T-pose (no motion library, so no idle pose): the stage builds a relaxed pose from code as
  the fallback (the first version lifted the arms of a VRM 0 model, found on a screenshot of the real stage, and is
  mirrored for VRM 0 now). An English question got an English answer through a Chinese voice: the setup asks for the
  voice's language and the system prompt says which language to write in. A plain `npm install` rewrote the lockfile and
  warned about esbuild's install script: the lockfile is refreshed and the script approved. Starting twice ended in a
  raw `EADDRINUSE` stack: the message says which port and what to do.
- **Scans**, over the whole tree: the secret scan and the asset scan are clean (629 files). The licence audit
  (`npm run license-audit -- --strict`) covers 216 npm packages (31 that ship, 185 for building and testing only) and 70
  Python distributions in the light environment, and nothing needs a look; the weak-copyleft ones (MPL-2.0: the
  lightningcss builds, build only; certifi and tqdm in the Python environment) are listed in
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), and the six source files derived from another project carry its
  notice.
- **Not done.** The hidden key prompt in a real terminal: the setup was driven through `--stdin`, and the terminal path
  asks the same questions with the echo switched off, which nobody has typed into. `npm install` with an empty npm
  cache on a slow network. The stage captured as an OBS browser source (a window capture of the stage window is what the
  previous setup used). A machine with neither Chrome nor Edge (the setup asks for a path). A VRM 1 model on the real
  stage (the tests use a stand-in; the run used VRM 0). A voice in another language than Chinese with the real
  GPT-SoVITS: the setting is tested, the sound is not. Another Windows account: the encrypted key store belongs to the
  account that wrote it.

## P0

VRAM measurements are in [vram-measurements.md](vram-measurements.md).
