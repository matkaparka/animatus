/**
 * The first-run wizard behind `npm run setup`: a handful of questions, then a working configuration file and the
 * model's key in the encrypted store.
 *
 * It asks for as little as a first chat needs (a model, a persona, a voice, a model provider and its key) and leaves the
 * rest at the defaults, so that a person who has never seen the configuration file has one that runs and that they can
 * then read and change (`config.example/animatus.config.yaml` lists every option). It never overwrites a configuration
 * that is already there, never writes a key into the file, and never prints one.
 *
 * All input and output goes through a `Prompter`, and the disk through a small `Fs`, so the tests run whole sessions
 * from a script of answers.
 */
import path from 'node:path'
import YAML from 'yaml'
import { parseConfig } from '../config.ts'
import type { SecretStore } from '../plugins/secrets.ts'

export interface Prompter {
  /** Show a line of text. */
  say(text: string): void
  /** Ask a question; an empty answer is the default (or empty when there is none). */
  ask(question: string, opts?: { default?: string }): Promise<string>
  /** Ask for something that must not be shown or kept (a key). */
  askSecret(question: string): Promise<string>
  confirm(question: string, defaultYes: boolean): Promise<boolean>
  /** Pick one of a few; returns the index. */
  choose(question: string, options: readonly string[], defaultIndex?: number): Promise<number>
}

export interface Fs {
  exists(p: string): Promise<'file' | 'dir' | null>
  listDir(p: string): Promise<string[]>
  mkdirp(p: string): Promise<void>
  writeFile(p: string, text: string): Promise<void>
}

export interface SetupDeps {
  root: string
  prompt: Prompter
  fs: Fs
  /** Where the model's key goes: the encrypted store on Windows. Absent where there is none. */
  secrets?: SecretStore | undefined
  /** Where a browser for the stage window may be found on this machine, best guess first. */
  browserCandidates?: readonly string[]
  platform?: NodeJS.Platform
  now?: () => Date
}

export interface SetupResult {
  /** The configuration file written, or null when nothing was. */
  file: string | null
  /** True when a key was stored. */
  keyStored: boolean
  /** What to do next, in words. */
  next: string[]
}

const slash = (p: string): string => p.replace(/\\/g, '/')

/** Ask until the answer passes the check (an empty answer passes only when `allowEmpty`). */
async function askValid(
  prompt: Prompter,
  question: string,
  check: (answer: string) => Promise<string | null>,
  opts: { default?: string; allowEmpty?: boolean } = {}
): Promise<string> {
  for (let tries = 0; tries < 5; tries++) {
    const a = (
      await prompt.ask(question, opts.default !== undefined ? { default: opts.default } : {})
    ).trim()
    if (a === '' && opts.allowEmpty) return ''
    const problem = a === '' ? 'An answer is needed here.' : await check(a)
    if (problem === null) return a
    prompt.say(`  ${problem}`)
  }
  throw new Error(`no usable answer to: ${question}`)
}

const VOICE_LANGUAGES = [
  { name: 'Chinese', code: 'zh' },
  { name: 'English', code: 'en' },
  { name: 'Japanese', code: 'ja' },
  { name: 'Korean', code: 'ko' },
  { name: 'Cantonese', code: 'yue' },
] as const

const DEFAULT_BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

interface Answers {
  modelsDir: string | null
  model: string | null
  motionsDir: string | null
  persona: string
  browser: string | null
  llm: {
    kind: 'gemini' | 'openai-compatible'
    model: string
    proxy: string | null
    baseUrl: string | null
    secret: string
    key: string
  } | null
  tts:
    | {
        kind: 'start'
        root: string
        python: string
        inferConfig: string
        refAudio: string
        refText: string
        lang: string
      }
    | { kind: 'attach'; url: string; refAudio: string; refText: string; lang: string }
    | null
  bilibiliRoom: number | null
}

/** The configuration as data, from the answers. Only what was answered, and the choices a first run needs. */
export function buildConfig(a: Answers): Record<string, unknown> {
  const cfg: Record<string, unknown> = { version: 1 }
  const paths: Record<string, string> = { data_dir: './data' }
  if (a.modelsDir) paths.models = slash(a.modelsDir)
  if (a.motionsDir) paths.motions = slash(a.motionsDir)
  cfg.paths = paths
  const stage: Record<string, unknown> = {
    ...(a.model ? { model: a.model } : {}),
    background: { kind: 'color', color: '#1f2a44' },
    camera: { fit: 'upper_body' },
  }
  if (a.browser)
    stage.browser = {
      executable: slash(a.browser),
      profile_dir: './data/animatus-stage-profile',
      window_size: [1280, 720],
    }
  cfg.stage = stage
  cfg.persona = slash(a.persona)
  if (a.llm) {
    cfg.llm = {
      providers: [
        {
          id: 'primary',
          kind: a.llm.kind,
          model: a.llm.model,
          api_key: `\${secret:${a.llm.secret}}`,
          ...(a.llm.baseUrl ? { base_url: a.llm.baseUrl } : {}),
          ...(a.llm.proxy ? { proxy: a.llm.proxy } : {}),
        },
      ],
      order: ['primary'],
    }
  }
  if (a.tts) {
    cfg.tts = {
      styles: { neutral: { ref_audio: slash(a.tts.refAudio), ref_text: a.tts.refText } },
      default_style: 'neutral',
      text_lang: a.tts.lang,
      prompt_lang: a.tts.lang,
    }
    cfg.plugins =
      a.tts.kind === 'start'
        ? {
            gptsovits: {
              enabled: true,
              config: {
                root: slash(a.tts.root),
                python: slash(a.tts.python),
                tts_config: slash(a.tts.inferConfig),
              },
            },
          }
        : { 'gptsovits-attach': { enabled: true, config: { url: a.tts.url } } }
  }
  cfg.sources = a.bilibiliRoom
    ? { bilibili: { enabled: true, room_id: a.bilibiliRoom } }
    : { bilibili: { enabled: false, room_id: 1 } }
  return cfg
}

const HEADER = (when: string) =>
  `# Animatus configuration, written by \`npm run setup\` on ${when}.
# This holds only what a first chat needs. config.example/animatus.config.yaml lists every option (modes, memory, tools,
# automations, ...). Secrets are never written here: keys are referred to as \${secret:name} and live in the encrypted store
# (enter or change them on the console's Keys page). Relative paths are relative to the repository folder.

`

export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const { prompt, fs, root } = deps
  const say = prompt.say.bind(prompt)
  const dir = (p: string) => path.resolve(root, p)
  const configDir = path.join(root, 'config')
  const target = path.join(configDir, 'animatus.config.yaml')

  say(
    'Animatus first-run setup. Answer the questions; press Enter to take the default in [brackets].'
  )
  say('Nothing is changed until the end, and nothing you type is sent anywhere.')
  say('')

  // ── an existing configuration is never overwritten
  let file = target
  if ((await fs.exists(target)) === 'file') {
    say(`There is a configuration already: ${slash(target)}`)
    if (await prompt.confirm('Replace it?', false)) file = target
    else {
      file = path.join(configDir, 'animatus.config.new.yaml')
      say(`It stays as it is. The new one is written to ${slash(file)}.`)
    }
  }

  const answers: Answers = {
    modelsDir: null,
    model: null,
    motionsDir: null,
    persona: './personas/example',
    browser: null,
    llm: null,
    tts: null,
    bilibiliRoom: null,
  }

  // ── the character
  say('')
  say('1. The character: a VRM model file.')
  const modelsDir = await askValid(
    prompt,
    'Folder that holds your .vrm model (leave empty to set it later)',
    async (a) => ((await fs.exists(dir(a))) === 'dir' ? null : `That folder does not exist: ${a}`),
    { allowEmpty: true }
  )
  if (modelsDir) {
    answers.modelsDir = modelsDir
    const vrms = (await fs.listDir(dir(modelsDir))).filter((f) => /\.vrm$/i.test(f)).sort()
    if (vrms.length === 0)
      say('  That folder has no .vrm file yet; add one and set stage.model in the configuration.')
    else if (vrms.length === 1) {
      answers.model = vrms[0] as string
      say(`  Using ${answers.model}.`)
    } else answers.model = vrms[await prompt.choose('Which model?', vrms, 0)] as string
  }
  const motions = await askValid(
    prompt,
    'Folder of motions (idle/, talk/, poses/, ...; leave empty for none)',
    async (a) => ((await fs.exists(dir(a))) === 'dir' ? null : `That folder does not exist: ${a}`),
    { allowEmpty: true }
  )
  if (motions) answers.motionsDir = motions
  answers.persona = await askValid(
    prompt,
    'Persona folder (holds persona.md)',
    async (a) =>
      (await fs.exists(path.join(dir(a), 'persona.md'))) === 'file'
        ? null
        : `There is no persona.md in ${a}`,
    { default: './personas/example' }
  )

  // ── the stage window
  say('')
  say(
    '2. The stage window (a browser window that shows the character; you capture it in your streaming software).'
  )
  const candidates = deps.browserCandidates ?? DEFAULT_BROWSERS
  let found: string | null = null
  for (const c of candidates)
    if ((await fs.exists(c)) === 'file') {
      found = c
      break
    }
  if (found && (await prompt.confirm(`Use ${found}?`, true))) answers.browser = found
  else {
    const b = await askValid(
      prompt,
      'Path of chrome.exe or msedge.exe (leave empty to open the stage page yourself)',
      async (a) => ((await fs.exists(a)) === 'file' ? null : `There is no file at ${a}`),
      { allowEmpty: true }
    )
    if (b) answers.browser = b
  }

  // ── the model
  say('')
  say('3. The language model that writes what the character says.')
  const kind = await prompt.choose(
    'Which provider?',
    [
      'Google Gemini',
      'An OpenAI-compatible server (OpenAI, a local server, ...)',
      'Set it up later',
    ],
    0
  )
  if (kind !== 2) {
    const gemini = kind === 0
    const model = await askValid(prompt, 'Model name (as the provider calls it)', async () => null)
    let baseUrl: string | null = null
    if (!gemini)
      baseUrl = await askValid(
        prompt,
        'Base address, for example https://api.openai.com/v1 or http://127.0.0.1:8081/v1',
        async (a) => (/^https?:\/\//.test(a) ? null : 'It should start with http:// or https://')
      )
    const proxy = await askValid(
      prompt,
      'Proxy address if you need one to reach it, for example http://127.0.0.1:7890 (empty for none)',
      async (a) => (/^https?:\/\//.test(a) ? null : 'It should start with http:// or https://'),
      { allowEmpty: true }
    )
    const secret = gemini ? 'gemini' : 'openai'
    const key = (
      await prompt.askSecret(
        `The API key (typing is hidden; it goes into the encrypted store, not the file; empty to enter it later)`
      )
    ).trim()
    answers.llm = {
      kind: gemini ? 'gemini' : 'openai-compatible',
      model,
      proxy: proxy || null,
      baseUrl,
      secret,
      key,
    }
  }

  // ── the voice
  say('')
  say('4. The voice (GPT-SoVITS, installed separately by its own instructions).')
  const voice = await prompt.choose(
    'How should it run?',
    [
      'Start it for me (I have GPT-SoVITS installed)',
      'I start it myself (it is already running)',
      'Set it up later',
    ],
    0
  )
  if (voice !== 2) {
    const ref = await askValid(
      prompt,
      'A reference recording of the voice (a .wav of a few seconds)',
      async (a) => ((await fs.exists(a)) === 'file' ? null : `There is no file at ${a}`)
    )
    const refText = await askValid(
      prompt,
      'What the reference recording says, word for word',
      async () => null
    )
    // GPT-SoVITS speaks one language per setting, and the model is told to write in it
    const chosen =
      VOICE_LANGUAGES[
        await prompt.choose(
          'What language is the voice (the recording, and what the character says)?',
          VOICE_LANGUAGES.map((l) => l.name),
          0
        )
      ]
    const lang: string = chosen?.code ?? 'zh'
    if (voice === 0) {
      const gsvRoot = await askValid(prompt, 'The GPT-SoVITS folder', async (a) =>
        (await fs.exists(a)) === 'dir' ? null : `That folder does not exist: ${a}`
      )
      const guess = path.join(gsvRoot, 'runtime', 'python.exe')
      const python = await askValid(
        prompt,
        'Its python.exe',
        async (a) => ((await fs.exists(a)) === 'file' ? null : `There is no file at ${a}`),
        (await fs.exists(guess)) === 'file' ? { default: slash(guess) } : {}
      )
      // the .yaml that names the GPT and SoVITS weights; a relative answer is read from the GPT-SoVITS folder, as it is when started
      const inferGuess = path.join(gsvRoot, 'GPT_SoVITS', 'configs', 'tts_infer.yaml')
      const inferConfig = await askValid(
        prompt,
        'Its inference config (the .yaml that names your GPT and SoVITS weights)',
        async (a) =>
          (await fs.exists(path.isAbsolute(a) ? a : path.join(gsvRoot, a))) === 'file'
            ? null
            : `There is no file at ${a}`,
        (await fs.exists(inferGuess)) === 'file' ? { default: slash(inferGuess) } : {}
      )
      answers.tts = {
        kind: 'start',
        root: gsvRoot,
        python,
        inferConfig,
        refAudio: ref,
        refText,
        lang,
      }
    } else {
      const url = await askValid(
        prompt,
        'Its address',
        async (a) => (/^https?:\/\//.test(a) ? null : 'It should start with http:// or https://'),
        { default: 'http://127.0.0.1:9880' }
      )
      answers.tts = { kind: 'attach', url, refAudio: ref, refText, lang }
    }
  }

  // ── the audience
  say('')
  say(
    '5. The audience. Chat can be read from a Bilibili live room; without one you can still try everything with fake messages from the console.'
  )
  const room = await askValid(
    prompt,
    'Live room number (empty for none)',
    async (a) => (/^\d{1,12}$/.test(a) ? null : 'A room number is digits only.'),
    { allowEmpty: true }
  )
  if (room) answers.bilibiliRoom = Number(room)

  // ── write it
  const cfg = buildConfig(answers)
  parseConfig(cfg, { root }) // what was built must be a configuration the program accepts
  const when = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
  await fs.mkdirp(configDir)
  await fs.writeFile(file, HEADER(when) + YAML.stringify(cfg, { lineWidth: 0 }))
  say('')
  say(`Written: ${slash(file)}`)

  let keyStored = false
  if (answers.llm?.key) {
    if (deps.secrets) {
      try {
        await deps.secrets.set(answers.llm.secret, answers.llm.key)
        keyStored = true
        say(`The key is stored (as "${answers.llm.secret}"), encrypted for your Windows account.`)
      } catch (e) {
        say(
          `The key could not be stored: ${(e as Error).message.split('\n')[0]}. Enter it on the console's Keys page instead.`
        )
      }
    } else
      say(
        `This machine has no encrypted store. Put the key in config/.env as ${answers.llm.secret === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'}=..., or enter it on the console's Keys page.`
      )
  }

  const next: string[] = []
  const built =
    (await fs.exists(path.join(root, 'packages', 'stage', 'dist', 'index.html'))) !== null
  if (!built) next.push('npm run build        (builds the stage and the console pages)')
  next.push('npm run doctor       (checks that everything is in place)')
  next.push('npm start            (starts the program; it prints the address of the console)')
  if (!answers.llm?.key) next.push("Enter the model key on the console's Keys page.")
  say('')
  say('Next:')
  for (const n of next) say(`  ${n}`)
  return { file, keyStored, next }
}
