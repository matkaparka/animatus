#!/usr/bin/env node
// VRAM probe command line. Run with plain Node (>= 24), no build step:
//
//   node packages/vram-probe/src/cli.ts adapters
//   node packages/vram-probe/src/cli.ts record --label draw-test --role "forge=cmd:launch.py" --role "stage=cmd:my_profile"
//   node packages/vram-probe/src/cli.ts mark "enter:draw"          (from another terminal, while recording)
//   node packages/vram-probe/src/cli.ts summarize probe-out/draw-test-....jsonl
//
// `record` runs until Ctrl+C (or --duration) and prints a summary. Marks named enter:<x> / exit:<x>
// are measured as windows: what mode <x> costs above the level just before it started.
import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DEFAULT_ROLES, mergeRoles, parseRoleSpec } from './roles.ts'
import { VramProbe } from './probe.ts'
import { measureAllWindows, measureWindow, summarizeRecording, toMeasurement } from './summary.ts'
import type { LogRecord, Mark, MetaRecord, Sample } from './types.ts'

const DEFAULT_PORT = 8777

const usage = `usage:
  cli.ts adapters
  cli.ts record [--label NAME] [--out DIR] [--interval SEC] [--duration SEC] [--luid LUID]
                [--role name=cmd:TEXT|name:IMAGE.EXE|pid:N]... [--port N] [--no-nvsmi] [--print-every SEC]
  cli.ts mark LABEL [--port N]
  cli.ts status [--port N]
  cli.ts stop [--port N]
  cli.ts summarize FILE.jsonl [--window enter:x..exit:x] [--json]
                [--key K --config-hash H --write-measurement FILE]`

const fmt = (n: number | null | undefined, w = 6) =>
  n === null || n === undefined ? '-'.padStart(w) : n.toFixed(0).padStart(w)

function describeSample(s: Sample, target: string): string {
  const roles = Object.entries(s.roles)
    .filter(([r, v]) => v > 0 || r !== 'other')
    .map(([r, v]) => `${r} ${v.toFixed(0)}`)
    .join(' | ')
  const others = Object.entries(s.other_gpus_mb)
    .filter(([, v]) => v > 1)
    .map(([n, v]) => `${n} ${v.toFixed(0)}`)
    .join(', ')
  const off = Object.entries(s.roles_off_target)
    .map(
      ([ad, rs]) =>
        `${ad}: ${Object.entries(rs)
          .map(([r, v]) => `${r} ${v.toFixed(0)}`)
          .join(', ')}`
    )
    .join('; ')
  return (
    `[${String(Math.round(s.elapsed_s)).padStart(5)}s] ${target} ${fmt(s.target_mb)} MiB (nvidia-smi ${fmt(s.nvsmi_mb)}) | ${roles}` +
    (off ? `   [off-target: ${off}]` : others ? `   [other GPUs: ${others}]` : '')
  )
}

async function control(port: number, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

function loadRecording(file: string): {
  meta: MetaRecord | null
  samples: Sample[]
  marks: Mark[]
} {
  const samples: Sample[] = []
  const marks: Mark[] = []
  let meta: MetaRecord | null = null
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let rec: LogRecord
    try {
      rec = JSON.parse(line) as LogRecord
    } catch {
      continue
    }
    if (rec.type === 'meta') meta = rec
    else if (rec.type === 'sample') samples.push(rec)
    else if (rec.type === 'mark') marks.push(rec)
  }
  return { meta, samples, marks }
}

function printSummary(
  samples: Sample[],
  marks: Mark[],
  targetName: string,
  json: boolean,
  windowSpec?: string
) {
  const overall = summarizeRecording(samples)
  const windows = windowSpec
    ? [measureWindow(samples, marks, ...(windowSpec.split('..') as [string, string]))].filter(
        (w) => w !== null
      )
    : measureAllWindows(samples, marks)
  if (json) {
    console.log(JSON.stringify({ target: targetName, overall, windows }, null, 2))
    return
  }
  console.log(`\n== ${targetName}: ${overall.samples} samples over ${overall.duration_s}s ==`)
  console.log(`            baseline     peak   steady   (MiB)`)
  const row = (name: string, s: { baseline_mb: number; peak_mb: number; steady_mb: number }) =>
    console.log(
      `${name.padEnd(12)}${fmt(s.baseline_mb, 8)}${fmt(s.peak_mb, 9)}${fmt(s.steady_mb, 9)}`
    )
  row('adapter', overall.target)
  for (const [r, s] of Object.entries(overall.roles)) if (s.peak_mb > 0) row(r, s)
  if (overall.max_nvsmi_gap_mb !== null)
    console.log(
      `largest gap between the adapter counter and nvidia-smi: ${overall.max_nvsmi_gap_mb} MiB`
    )
  for (const w of windows) {
    console.log(`\n-- ${w.from} .. ${w.to} (${w.duration_s}s, ${w.samples} samples)`)
    console.log(
      `   baseline ${w.baseline_mb} MiB, peak ${w.peak_mb} (+${w.peak_delta_mb}), steady ${w.steady_mb} (+${w.steady_delta_mb})`
    )
    if (w.residual_delta_mb !== null)
      console.log(
        `   after exit: ${w.residual_delta_mb >= 0 ? '+' : ''}${w.residual_delta_mb} MiB vs baseline`
      )
    const perRole = Object.entries(w.roles).filter(([, v]) => Math.abs(v.peak_delta_mb) >= 1)
    if (perRole.length)
      console.log(
        '   by role (peak delta): ' +
          perRole
            .map(([r, v]) => `${r} ${v.peak_delta_mb >= 0 ? '+' : ''}${v.peak_delta_mb}`)
            .join(', ')
      )
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      out: { type: 'string' },
      interval: { type: 'string' },
      duration: { type: 'string' },
      luid: { type: 'string' },
      role: { type: 'string', multiple: true },
      port: { type: 'string' },
      'no-nvsmi': { type: 'boolean' },
      'print-every': { type: 'string' },
      window: { type: 'string' },
      json: { type: 'boolean' },
      key: { type: 'string' },
      'config-hash': { type: 'string' },
      'write-measurement': { type: 'string' },
    },
  })
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port)

  switch (cmd) {
    case 'adapters': {
      const p = new VramProbe({ nvidiaSmi: false })
      await p.start()
      for (const a of p.adapters) {
        console.log(
          `${a.luid}  ${a.name}  vendor ${a.vendor}  ${a.dedicated_mb} MiB dedicated${a.flags & 2 ? '  (software)' : ''}${a === p.target ? '   <- target' : ''}`
        )
      }
      await p.stop()
      return 0
    }

    case 'record': {
      const extra = (values.role ?? []).map(parseRoleSpec)
      const probe = new VramProbe({
        intervalSec: values.interval ? Number(values.interval) : 1,
        roles: mergeRoles(DEFAULT_ROLES, extra),
        luid: values.luid,
        outDir: values.out ?? 'probe-out',
        label: values.label ?? 'vram',
        nvidiaSmi: !values['no-nvsmi'],
      })
      probe.on('collector-stderr', (d: string) => process.stderr.write(`[collector] ${d}`))
      probe.on('probe-error', (e: unknown) => console.error('probe error:', e))
      await probe.start()
      const target = probe.target
      console.log('adapters:')
      for (const a of probe.adapters)
        console.log(
          `  ${a.luid}  ${a.name}  ${a.dedicated_mb} MiB${a === target ? '   <- recording this one' : ''}`
        )
      if (!target) console.log('  (no usable adapter found)')
      console.log(`writing ${probe.files?.jsonl}\n`)

      const printEvery = Number(values['print-every'] ?? 5)
      let n = 0
      probe.on('sample', (s: Sample) => {
        if (n++ % printEvery === 0)
          console.log(
            describeSample(
              s,
              (target?.name ?? 'GPU').replace(/^NVIDIA GeForce /, '').replace(/ Laptop GPU$/, '')
            )
          )
      })
      probe.on('mark', (m: Mark) => console.log(`         ---- mark: ${m.label}`))

      let server: ReturnType<typeof createServer> | null = null
      let finished!: () => void
      const done = new Promise<void>((res) => (finished = res))
      if (port > 0) {
        server = createServer((req, res) => {
          const send = (code: number, obj: unknown) => {
            res.writeHead(code, { 'content-type': 'application/json' })
            res.end(JSON.stringify(obj))
          }
          if (req.method === 'GET' && req.url === '/status')
            return send(200, { latest: probe.latest(), marks: probe.marks.length })
          if (req.method === 'POST') {
            let body = ''
            req.on('data', (c) => (body += c))
            req.on('end', () => {
              if (req.url === '/mark') {
                try {
                  const { label } = JSON.parse(body) as { label?: string }
                  if (!label) return send(400, { error: 'label required' })
                  return send(200, probe.mark(String(label).slice(0, 80)))
                } catch {
                  return send(400, { error: 'bad json' })
                }
              }
              if (req.url === '/stop') {
                send(200, { stopping: true })
                finished()
                return
              }
              send(404, { error: 'not found' })
            })
            return
          }
          send(404, { error: 'not found' })
        })
        server.on('error', (e) =>
          console.error(
            `control port ${port} unavailable (${(e as Error).message}); marks only via stdin`
          )
        )
        server.listen(port, '127.0.0.1', () =>
          console.log(
            `control: POST http://127.0.0.1:${port}/mark {"label":...}  (or: cli.ts mark LABEL)\n`
          )
        )
      }
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (d: string) => {
        for (const line of d.split(/\r?\n/)) if (line.trim()) probe.mark(line.trim().slice(0, 80))
      })
      process.stdin.on('error', () => {})
      process.once('SIGINT', finished)
      process.once('SIGTERM', finished)
      if (values.duration) setTimeout(finished, Number(values.duration) * 1000)

      await done
      server?.close()
      await probe.stop()
      printSummary(probe.samples, probe.marks, target?.name ?? 'GPU', false)
      console.log(`\nfiles:\n  ${probe.files?.jsonl}\n  ${probe.files?.csv}`)
      return 0
    }

    case 'mark': {
      const label = positionals.join(' ')
      if (!label) throw new Error('mark needs a label')
      console.log(JSON.stringify(await control(port, '/mark', { label })))
      return 0
    }
    case 'status':
      console.log(JSON.stringify(await control(port, '/status'), null, 2))
      return 0
    case 'stop':
      console.log(JSON.stringify(await control(port, '/stop', {})))
      return 0

    case 'summarize': {
      const file = positionals[0]
      if (!file || !existsSync(file)) throw new Error(`file not found: ${file ?? '(none)'}`)
      const { meta, samples, marks } = loadRecording(file)
      printSummary(samples, marks, meta?.target?.name ?? 'GPU', !!values.json, values.window)
      if (values['write-measurement']) {
        const win = values.window
        const [from, to] = win ? (win.split('..') as [string, string]) : [null, null]
        if (!values.key || !values['config-hash'] || !from || !to)
          throw new Error('--write-measurement needs --window, --key and --config-hash')
        const w = measureWindow(samples, marks, from, to)
        if (!w) throw new Error(`window ${win} not found in ${file}`)
        const outFile = values['write-measurement']
        const store: { measurements: { key: string; config_hash: string }[] } = existsSync(outFile)
          ? JSON.parse(readFileSync(outFile, 'utf8'))
          : { measurements: [] }
        const m = toMeasurement(values.key, values['config-hash'], w, `probe ${file}`)
        store.measurements = store.measurements.filter(
          (x) => !(x.key === m.key && x.config_hash === m.config_hash)
        )
        store.measurements.push(m)
        writeFileSync(outFile, JSON.stringify(store, null, 2) + '\n')
        console.log(`\nwrote measurement ${m.key} (${m.config_hash}) to ${outFile}`)
      }
      return 0
    }

    default:
      console.error(usage)
      return cmd ? 2 : 0
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(String(e instanceof Error ? e.message : e))
    process.exit(1)
  }
)
