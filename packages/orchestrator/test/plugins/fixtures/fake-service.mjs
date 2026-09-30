// A tiny stand-in for a plugin service, used by the supervisor and guard tests.
// Plain ESM with no dependencies so it runs under any `node`.
//
//   node fake-service.mjs --port N [flags]
//
// Flags
//   --health-mode ok|loading|broken|ok-false|garbage|hang|leaky   what /health answers (default ok); POST /control changes it
//   --leak-env NAME          in mode leaky, the environment variable whose value the error text contains
//   --ready-after MS         in mode ok, answer ready:false until this long after listening
//   --never-ready            in mode ok, always answer ready:false
//   --startup-delay MS       wait before listening
//   --no-listen              never listen (the process just idles)
//   --exit-after MS          exit this long after listening ...
//   --exit-code N            ... with this code (default 1)
//   --crash-first N          with --state-file: exit 1 shortly after listening on the first N runs
//   --crash-after MS         how soon a --crash-first crash happens (default 100)
//   --state-file PATH        counts how many times the service was started (also used by --crash-first)
//   --grandchild             start a long-lived child process; its pid is reported in /info and the info file
//   --stop-path PATH         polite stop endpoint (default /shutdown)
//   --ignore-stop            answer 200 to the stop request but keep running
//   --stop-delay MS          exit this long after a polite stop (default 20)
//   --marker-file PATH       written when a polite stop is handled
//   --info-file PATH         JSON with pid, argv, cwd, env and the grandchild pid, written once listening
//   --echo-env NAME          print NAME=<value> to stdout after listening
//   --stdout-line TEXT       print TEXT to stdout after listening (repeatable)
//   --stderr-line TEXT       print TEXT to stderr after listening (repeatable)
//   --many-lines N           print N numbered lines to stdout after listening
//
// Endpoints: GET|HEAD /health, GET /docs (HTML), GET /info, POST /control {mode?, exit?}, POST <stop-path>.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : fallback
}
const values = (name) => argv.flatMap((arg, i) => (arg === `--${name}` ? [argv[i + 1]] : []))

const port = Number(value('port', '0'))
const readyAfter = Number(value('ready-after', '0'))
const stopPath = value('stop-path', '/shutdown')
const stopDelay = Number(value('stop-delay', '20'))
let mode = value('health-mode', 'ok')
let listeningSince = 0
let grandchild

const send = (res, status, body, type = 'application/json') => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const info = () => ({
  pid: process.pid,
  ppid: process.ppid,
  argv: process.argv,
  cwd: process.cwd(),
  env: { ...process.env },
  grandchildPid: grandchild?.pid ?? null,
})

const killGrandchild = () => {
  try {
    grandchild?.kill()
  } catch {
    // already gone
  }
}

function health(req, res) {
  const head = req.method === 'HEAD'
  const answer = (status, body, type) =>
    head ? send(res, status, '', type) : send(res, status, body, type)
  switch (mode) {
    case 'loading':
      return answer(200, { ok: true, ready: false, service: 'fake' })
    case 'broken':
      return answer(503, { ok: false, ready: false, service: 'fake', detail: 'broken on purpose' })
    case 'ok-false':
      return answer(200, { ok: false, ready: true, service: 'fake', detail: 'ok is false' })
    case 'garbage':
      return answer(200, 'this is not json', 'text/plain')
    case 'leaky':
      // a careless service that puts a credential into its own error text
      return answer(503, {
        ok: false,
        ready: false,
        service: 'fake',
        detail: `upstream refused the key ${process.env[value('leak-env', 'LEAK')] ?? ''}`,
        config: { token: process.env[value('leak-env', 'LEAK')] ?? '' },
      })
    case 'hang':
      return // never answers
    default: {
      const ready = !has('never-ready') && Date.now() - listeningSince >= readyAfter
      return answer(200, {
        ok: true,
        ready,
        service: 'fake',
        version: '1.2.3',
        config: { flavour: 'test' },
      })
    }
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/health') return health(req, res)
  if (path === '/docs')
    return send(
      res,
      200,
      '<!doctype html><html><body><h1>docs</h1></body></html>',
      'text/html; charset=utf-8'
    )
  if (path === '/info') return send(res, 200, info())
  if (path === '/control' && req.method === 'POST') {
    const body = await readJson(req)
    if (typeof body.mode === 'string') mode = body.mode
    send(res, 200, { ok: true, mode })
    if (typeof body.exit === 'number') setTimeout(() => process.exit(body.exit), 10)
    return
  }
  if (path === stopPath) {
    send(res, 200, { ok: true })
    if (has('ignore-stop')) return
    setTimeout(() => {
      const marker = value('marker-file')
      if (marker) writeFileSync(marker, 'graceful\n')
      killGrandchild()
      process.exit(0)
    }, stopDelay)
    return
  }
  send(res, 404, { error: { code: 'not_found', message: 'no such path', retryable: false } })
})

function afterListening() {
  listeningSince = Date.now()
  if (has('grandchild')) {
    grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  }
  const infoFile = value('info-file')
  if (infoFile) writeFileSync(infoFile, JSON.stringify(info()))

  const echo = value('echo-env')
  if (echo) {
    console.log(`${echo}=${process.env[echo] ?? '(unset)'}`)
    console.error(`${echo}=${process.env[echo] ?? '(unset)'}`)
  }
  for (const line of values('stdout-line')) console.log(line)
  for (const line of values('stderr-line')) console.error(line)
  const many = Number(value('many-lines', '0'))
  for (let i = 1; i <= many; i++) console.log(`line ${i}`)

  const stateFile = value('state-file')
  if (stateFile) {
    // counts how many times this service has been started, whatever else it does
    const previous = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) || 0 : 0
    writeFileSync(stateFile, String(previous + 1))
    if (previous < Number(value('crash-first', '0')))
      setTimeout(() => process.exit(1), Number(value('crash-after', '100')))
  }
  if (has('exit-after'))
    setTimeout(
      () => process.exit(Number(value('exit-code', '1'))),
      Number(value('exit-after', '0'))
    )
}

if (has('no-listen')) {
  setInterval(() => {}, 1000)
} else {
  setTimeout(
    () => server.listen(port, '127.0.0.1', afterListening),
    Number(value('startup-delay', '0'))
  )
}
