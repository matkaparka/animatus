// Stands in for collector.ps1 in tests: same JSON-lines protocol, scripted GPU activity.
// GPT-SoVITS (pid 100) loads first, then Forge (pid 200) loads and generates; the stage's Chrome GPU
// process (pid 300) sits on the integrated GPU. Runs at FAKE_INTERVAL_MS per sample.
const A = 'luid_0x00000000_0x00010615' // AMD iGPU
const N = 'luid_0x00000000_0x000122ab' // NVIDIA
const W = 'luid_0x00000000_0x00012279' // software
const interval = Number(process.env.FAKE_INTERVAL_MS ?? 15)

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
out({
  type: 'adapters',
  interval_s: 1,
  adapters: [
    { luid: A, name: 'AMD Radeon(TM) 610M', vendor: '0x1002', dedicated_mb: 2019, flags: 0 },
    { luid: N, name: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU', vendor: '0x10de', dedicated_mb: 11944, flags: 0 },
    { luid: W, name: 'Microsoft Basic Render Driver', vendor: '0x1414', dedicated_mb: 0, flags: 2 },
  ],
})

const procs = {
  90: { ppid: 4, name: 'cmd.exe', cmd: 'cmd /c start_voice.bat' },
  100: { ppid: 90, name: 'python.exe', cmd: 'python.exe api_v2.py -p 9880' },
  199: { ppid: 4, name: 'cmd.exe', cmd: 'cmd /c launch forge-neo --api' },
  200: { ppid: 199, name: 'python.exe', cmd: 'python.exe launch.py --api (forge-neo)' },
  299: { ppid: 4, name: 'chrome.exe', cmd: 'chrome.exe --user-data-dir=X:\\animatus-stage --app=http://127.0.0.1:5810' },
  300: { ppid: 299, name: 'chrome.exe', cmd: 'chrome.exe --type=gpu-process' },
}
const announced = new Set()
const announce = (pid) => {
  let p = pid
  while (procs[p] && !announced.has(p)) {
    announced.add(p)
    out({ type: 'proc', pid: p, ...procs[p] })
    p = procs[p].ppid
  }
}

// [gsv MiB, forge MiB] on NVIDIA per step
const plan = [
  [0, 0], [0, 0], [0, 0],
  [1200, 0], [2400, 0], [2400, 0],
  [2400, 3000], [2400, 3000],
  [2400, 7600], [2400, 10100], [2400, 10100],
  [2400, 3100], [2400, 3100], [2400, 3100],
  [2400, 0], [2400, 0], [2400, 0],
]
let step = 0
const timer = setInterval(() => {
  const [gsv, forge] = plan[Math.min(step, plan.length - 1)]
  const list = []
  if (gsv > 0) list.push({ pid: 100, luid: N, mb: gsv })
  if (forge > 0) list.push({ pid: 200, luid: N, mb: forge })
  list.push({ pid: 300, luid: A, mb: 70 })
  list.push({ pid: 999, luid: N, mb: 40 }) // an unrelated process, never announced
  for (const p of list) announce(p.pid)
  out({
    type: 'sample',
    t: Date.now(),
    adapters: { [A]: 850, [N]: gsv + forge + 40, [W]: 0 },
    procs: list,
  })
  step++
}, interval)
process.on('SIGTERM', () => {
  clearInterval(timer)
  process.exit(0)
})
