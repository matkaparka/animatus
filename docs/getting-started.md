# Getting started

From a fresh copy of the repository to the first spoken answer. About twenty minutes if the voice is already installed.

The program ships empty: no model file, no voice, no API key, no character. You bring those; the setup asks for them.

## What you bring

| | |
|---|---|
| Windows 10 or 11 | Process supervision and the GPU-memory probe are Windows-specific for now. |
| [Node.js](https://nodejs.org) 24 or newer | `node --version` |
| Chrome or Edge | The program opens the stage in its own window with it. |
| A VRM model | A `.vrm` file (VRM 0 or 1). Any folder; the program reads it from there and never copies it. |
| A model to write the words | A Gemini API key, or any OpenAI-compatible server (a local one works). |
| A voice | [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS), installed by its own instructions, and a reference recording of the voice (a `.wav`, a few seconds) with the words it says written out. GPT-SoVITS is what needs a GPU; the program itself does not. |

Without a working voice the character cannot speak: the model still answers, but every sentence is dropped when synthesis fails, so nothing appears on the stage (the console's Run page says so). Set the voice up first.

Not needed for a first chat: `uv` and the Python environments in `pyproject.toml`. Those are for plugins that ship their own service (image generation, the game demo, screen capture). Everything the speech plugin needs comes with your GPT-SoVITS install.

## 1. Install

```bash
git clone <address of this repository> animatus
cd animatus
npm install
npm run build
```

`npm run build` builds the two pages, the stage and the console.

## 2. Set it up

```bash
npm run setup
```

It asks a few questions and writes `config/animatus.config.yaml`. Press Enter to take the answer in brackets.

1. **The character.** The folder that holds your `.vrm` (it lists the files and asks which), an optional folder of motions, and the persona folder (`personas/example` is a generic example; copy it and write your own).
2. **The stage window.** It looks for Chrome or Edge; say yes to use what it found.
3. **The language model.** Gemini, an OpenAI-compatible server, or later. The model name as the provider calls it, a proxy address if you need one, and the API key. Typing the key is hidden and it goes into the encrypted store (`data/secrets.dpapi.json`, readable only from your Windows account), never into the configuration file. Leave it empty to enter it on the console's Keys page instead.
4. **The voice.** Start GPT-SoVITS for you, or use one that is already running, or later. The reference recording and what it says, the language (Chinese, English, Japanese, Korean, Cantonese), and for the first case the GPT-SoVITS folder, its `python.exe` and its inference config (the `.yaml` that names your weights; `GPT_SoVITS/configs/tts_infer.yaml` in a stock install).
5. **The audience.** A Bilibili live room number, or none: the console can inject fake messages, which is all a first try needs.

Nothing is changed until the last answer, and nothing you type is sent anywhere. If a configuration exists already, the new one is written next to it as `animatus.config.new.yaml` unless you say replace.

To do it by hand instead, copy [`config.example/`](../config.example/) to `config/` and edit `animatus.config.yaml`; every option is there with a comment.

## 3. Check

```bash
npm run doctor
```

Prints a checklist and, for each problem, what to do about it:

```
[ ok ] Node.js (version 24.19.0)
[ ok ] The configuration is valid (...)
[ ok ] The stage is built
[ ok ] The model file is there (my-model.vrm)
[ ok ] A model provider is ready (1 of 1)
[ ok ] The reference recordings are there (neutral)
[ ok ] GPT-SoVITS is there (C:/tools/GPT-SoVITS)
[ ok ] The GPT-SoVITS inference config is there (...)
[warn] No live room is connected (sources.bilibili.enabled is off: nothing reads chat)
         That is fine for a first try: the console can inject fake audience messages.
[ ok ] Port 5810 is free (the stage)

Ready to run. 1 thing(s) worth a look.
```

`[FAIL]` lines must be fixed before the program can run; `[warn]` lines are for a look. The exit code is 1 when something failed, so npm prints a few `npm error` lines after the report: that is npm remarking on the exit code, not a second problem. `npm run doctor -- --online` also asks the servers the configuration points at (the model provider's proxy, a speech server you started yourself) whether they answer.

## 4. Start

```bash
npm start
```

Watch the terminal:

- The speech server starts (it loads its models: ten seconds to a minute; up to four minutes is allowed).
- A Chrome window opens with the stage: the character on a plain background, a relaxed pose, nothing else. It has no menus and no settings on purpose, so it can be captured on stream.
- The console's address is printed once:

  ```
  Console: http://127.0.0.1:5811/#token=...
  ```

  Open **that whole address** in an ordinary browser window, not in the stage window. The token is new at every start and lets that page, and nothing else, change settings and approve things; the page removes it from the address bar at once. Opening the console without the token, or after a restart with an old one, only shows a page that explains this.

`npm start -- --no-browser` does not open the stage window (open `http://127.0.0.1:5810/` yourself, in a window that nothing else uses: only one stage page can be connected at a time, and a second one replaces the first). `npm start -- --config <file>` uses another configuration.

## 5. First chat

In the console, on the **Run** page, find **Inject a fake audience event**. Leave the kind at `danmaku`, type a name and a message, and press **Inject**. It enters like a real viewer's message, as untrusted text; nothing is sent to any platform.

A second or two later the model's answer is cut into sentences and the character speaks them, one after the other, with the subtitle under it, a face that fits the sentence's emotion tag and the mouth moving with the voice. The Run page shows the same in **Live events** and **Speech trace**.

To try the voice alone, without the model, use **Say a line** on the same page.

## 6. Real chat

To read a Bilibili live room, set in the configuration

```yaml
sources:
  bilibili:
    enabled: true
    room_id: 123456
    cookie_secret: bili_cookie   # optional: a logged-in cookie, entered on the Keys page, shows real names
```

and restart. Chat and paid messages arrive as untrusted viewer text: they can make the character talk, but they cannot make it run anything that needs your yes. Read [`safety.md`](safety.md) and [`tools.md`](tools.md) before you give the model tools.

## Normal warnings

- `lipsync_profile_missing`: the mouth follows the volume only. Set `paths.lipsync` to a folder that holds a wLipSync `profile.json` to get vowel shapes.
- No live room: see above.
- The character does not move much: without a folder of motions (`paths.motions`) it has only the built-in relaxed pose, breathing, blinking, gaze and small head movements. Motions (`idle/`, `talk/`, `poses/`, ...) are yours to bring; the folder layout is in [`motions.md`](motions.md).

## When something is wrong

| What you see | Likely cause | What to do |
|---|---|---|
| `npm run doctor` fails | as it says | do what the `[FAIL]` line says, run it again |
| `Port 5810 is already in use` | Animatus is already running, or something else has the port | close the other one, or change `servers.stage_port` and `servers.console_port` |
| The console page only explains the token | opened without the address, or after a restart | copy the whole `Console:` address from the terminal again |
| The stage window is blank | the pages are not built, or the model file is not where `paths.models` and `stage.model` say | `npm run build`; the Run page's stage card says `Model: error` and why |
| The character does not speak, or the answer shows in the console but not on the stage | the speech server did not start or is not ready | Plugins page: the state and the log of the speech plugin; check `plugins.gptsovits.config` (root, python, tts_config) |
| The Run page's language model card counts failures | wrong key or model name, or the provider needs a proxy | Keys page, `llm.providers[].model`, `llm.providers[].proxy`; the alarm above says what the provider answered |
| The answers are in the wrong language | `tts.text_lang` | it is the language the voice speaks; the model is told to write in it |
| The character flickers between two states | two stage pages are open | close the extra one |

## Next

- [`motions.md`](motions.md): the folder of idle, talk and pose motions, and how a clip is chosen.
- [`modes.md`](modes.md): modes that take over the stream for a while (dance, sing, sleep, draw, commentary) and how to switch them on.
- [`memory.md`](memory.md): what the character remembers between streams, and the editor for it.
- [`tools.md`](tools.md), [`automations.md`](automations.md), [`safety.md`](safety.md): what the model may ask for, rules of the form "when this happens, do that", and what is checked before the voice.
- [`plugins.md`](plugins.md): the services the program starts, and how to write one.
- [`console.md`](console.md): the console's pages and how it protects itself.
