/**
 * First-run setup:   npm run setup
 *
 * A few questions, then a working configuration in config/ and the model's key in the encrypted store.
 * See wizard.ts for what it asks and what it never does.
 */
import { createInterface } from 'node:readline/promises'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Writable } from 'node:stream'
import { DpapiFileSecretStore } from '../plugins/secrets.ts'
import { runSetup } from './wizard.ts'
import type { Fs, Prompter } from './wizard.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const fs: Fs = {
  async exists(p) {
    try {
      return (await stat(p)).isDirectory() ? 'dir' : 'file'
    } catch {
      return null
    }
  },
  async listDir(p) {
    try {
      return await readdir(p)
    } catch {
      return []
    }
  },
  async mkdirp(p) {
    await mkdir(p, { recursive: true })
  },
  async writeFile(p, text) {
    await writeFile(p, text, 'utf8')
  },
}

/** The terminal as a Prompter. The secret is read with the echo switched off. */
function terminal(): Prompter & { close(): void } {
  // one interface for everything; its output goes through a valve that is shut while a secret is typed, so nothing echoes
  let hidden = false
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) process.stdout.write(chunk, encoding)
      callback()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  return {
    say: (t) => console.log(t),
    async ask(question, opts) {
      const a = await rl.question(`${question}${opts?.default ? ` [${opts.default}]` : ''}: `)
      return a.trim() === '' && opts?.default ? opts.default : a
    },
    async askSecret(question) {
      process.stdout.write(`${question}: `)
      hidden = true
      try {
        return await rl.question('')
      } finally {
        hidden = false
        process.stdout.write('\n')
      }
    },
    async confirm(question, defaultYes) {
      const a = (await rl.question(`${question} [${defaultYes ? 'Y/n' : 'y/N'}]: `))
        .trim()
        .toLowerCase()
      return a === '' ? defaultYes : a.startsWith('y')
    },
    async choose(question, options, defaultIndex = 0) {
      console.log(question)
      options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`))
      for (;;) {
        const a = (await rl.question(`Number [${defaultIndex + 1}]: `)).trim()
        if (a === '') return defaultIndex
        const n = Number(a)
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1
        console.log(`  Enter a number from 1 to ${options.length}.`)
      }
    },
    close: () => rl.close(),
  }
}

/**
 * The answers taken from standard input, one per line: for scripts and for trying the wizard out without a terminal.
 * Nothing is hidden here (there is no terminal to hide it on), so a key typed this way is visible to whoever made the
 * input. Running out of lines is an error, not a wait.
 */
async function stdinPrompter(): Promise<Prompter & { close(): void }> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const next = (question: string): string => {
    const line = lines.shift()
    if (line === undefined) throw new Error(`The answers on standard input ran out at: ${question}`)
    return line
  }
  return {
    say: (t) => console.log(t),
    async ask(question, opts) {
      const a = next(question)
      console.log(`${question}${opts?.default ? ` [${opts.default}]` : ''}: ${a}`)
      return a.trim() === '' && opts?.default ? opts.default : a
    },
    async askSecret(question) {
      const a = next(question)
      console.log(`${question}: (read, not shown)`)
      return a
    },
    async confirm(question, defaultYes) {
      const a = next(question).trim().toLowerCase()
      console.log(`${question} [${defaultYes ? 'Y/n' : 'y/N'}]: ${a}`)
      return a === '' ? defaultYes : a.startsWith('y')
    },
    async choose(question, options, defaultIndex = 0) {
      const a = next(question).trim()
      console.log(question)
      options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`))
      console.log(`Number [${defaultIndex + 1}]: ${a}`)
      if (a === '') return defaultIndex
      const n = Number(a)
      if (!Number.isInteger(n) || n < 1 || n > options.length)
        throw new Error(`"${a}" is not a number from 1 to ${options.length}: ${question}`)
      return n - 1
    },
    close: () => {},
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      stdin: { type: 'boolean', default: false },
      root: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log(
      [
        'Usage: npm run setup -- [--stdin] [--root <folder>]',
        '',
        '  --stdin  read the answers from standard input, one per line (for scripts; a key typed this way is not hidden)',
        '  --root   set up another folder than this repository (to try it out)',
      ].join('\n')
    )
    return 0
  }
  if (!process.stdin.isTTY && !values.stdin) {
    console.error(
      'npm run setup asks questions and needs a terminal. Run it in a terminal window, or copy config.example/ to config/ and edit it.'
    )
    return 2
  }
  const root = values.root
    ? path.resolve(process.env.INIT_CWD ?? process.cwd(), values.root)
    : repoRoot
  const prompt = values.stdin ? await stdinPrompter() : terminal()
  try {
    const dataDir = path.join(root, 'data')
    const secrets =
      process.platform === 'win32'
        ? new DpapiFileSecretStore(path.join(dataDir, 'secrets.dpapi.json'))
        : undefined
    await runSetup({ root, prompt, fs, secrets })
    return 0
  } finally {
    prompt.close()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
)
