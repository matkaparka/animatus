/**
 * Dance mode, ported from the legacy page's dance module.
 *
 * Flow: a request (a gift that means "dance", the model's `[motion:dance]` tag, the console) is checked and, if it
 * can happen, waits until the reply that carried it has been spoken; then the mode is entered, the dance is sent
 * to the stage, and the voice is held for its length. When the stage reports the dance over, the mode is left,
 * the model is told ("you just finished a dance") so it can say a closing line, and only when it has started
 * answering (or a few seconds have passed) is the audience's queue released again.
 *
 * What the legacy page also did but is the stage's job here: fade in and out, the fixed happy face, damped
 * spring bones, keeping the root inside a radius, the credit line. Nothing of that is decided here.
 */
import path from 'node:path'
import { z } from 'zod'
import type { ModePanelInput, PanelActionInput } from '@animatus/protocol'
import type { Batch } from '../../inbox/types.ts'
import { toDancePlay } from '../../library/motionLibrary.ts'
import type { DanceInfo } from '../../library/motionLibrary.ts'
import type { ModeControllerFull, ModeHost } from '../host.ts'
import { readJson, writeJson } from '../jsonfile.ts'
import type { ModeContext } from '../manager.ts'

export const DanceSettings = z.strictObject({
  /** Seconds after a dance ends before the next may start. */
  cooldown_sec: z.number().min(0).max(3600).default(180),
  /** How long a request waits for the reply that carried it to be spoken before it is dropped. */
  pending_timeout_sec: z.number().min(5).max(600).default(90),
  /** After the dance the model is told and given this long to start answering before the audience's queue is released. */
  outro_window_sec: z.number().min(1).max(60).default(8),
  /** The stage must report the dance as playing within this long of being sent. */
  start_timeout_sec: z.number().min(5).max(120).default(30),
})
export type DanceSettings = z.infer<typeof DanceSettings>

export type DanceSource = 'tag' | 'gift' | 'console'
export type DanceRequestResult = 'ok' | 'busy' | 'cooldown' | 'none' | 'notfound'
export type DanceRequest = (req: {
  source: DanceSource
  name?: string
  requester?: string
  /** A trial run from the tuning panel: no closing line, and it does not start the cooldown. */
  trial?: boolean
  /** From the console's "replace" and "force" options: passed on when the mode is entered. */
  replace?: boolean
  force?: boolean
}) => Promise<DanceRequestResult>

export interface DanceStatus {
  phase: string
  current: string | null
  cooldownLeft: number
  lastName: string | null
}

type Phase = 'idle' | 'pending' | 'loading' | 'playing' | 'ending' | 'after'

interface StageDance {
  phase: string
  reason?: string
  error?: string
}

interface Persisted {
  last_end_at?: number
  last_name?: string
  /** Per dance: the operator's live tuning (offset and speed), applied on top of meta.json. */
  tuning?: Record<string, { offset?: number; speed?: number }>
}

const minutes = (sec: number) => Math.max(1, Math.ceil(sec / 60))

export function createDanceController(
  host: ModeHost
): ModeControllerFull & { request: DanceRequest; status(): DanceStatus } {
  const cfg = DanceSettings.parse(host.config.modes.dance?.config ?? {})
  const stateFile = path.join(host.dataDir, 'dance-state.json')

  let phase: Phase = 'idle'
  let current: DanceInfo | null = null
  let requester: string | undefined
  let trial = false
  let enterOpts: { replace?: boolean; force?: boolean } = {}
  /** Set when the dance was cut short or failed: no closing line then. */
  let noOutro = false
  let danceId = ''
  let counter = 0
  let token = 0
  let lastEndAt = 0
  let lastName: string | null = null
  let tuning: NonNullable<Persisted['tuning']> = {}
  let loading: Promise<void> | null = null
  let waiters: ((s: StageDance) => void)[] = []
  let outroTimer: NodeJS.Timeout | null = null
  /** The dances the advertisement names, refreshed ahead of time because `advertise` has to answer at once. */
  let advertised: DanceInfo[] = []
  /** Every dance folder, switched off or not, for the console's list. */
  let known: DanceInfo[] = []

  /** Reads the saved state once; every caller waits for the same read, so nothing can run on half-loaded state. */
  const load = (): Promise<void> =>
    (loading ??= (async () => {
      const raw = await readJson<unknown>(stateFile, {})
      const p: Persisted = raw && typeof raw === 'object' ? (raw as Persisted) : {}
      lastEndAt =
        typeof p.last_end_at === 'number' && Number.isFinite(p.last_end_at) ? p.last_end_at : 0
      lastName = typeof p.last_name === 'string' ? p.last_name : null
      // the file is edited by hand now and then: keep only numbers the stage can be sent
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      tuning = {}
      if (p.tuning && typeof p.tuning === 'object') {
        for (const [name, t] of Object.entries(p.tuning)) {
          const offset = num(t?.offset)
          const speed = num(t?.speed)
          if (offset !== undefined || speed !== undefined)
            tuning[name] = {
              ...(offset !== undefined ? { offset } : {}),
              ...(speed !== undefined ? { speed } : {}),
            }
        }
      }
    })())
  const save = () =>
    void writeJson(
      stateFile,
      {
        last_end_at: lastEndAt,
        ...(lastName ? { last_name: lastName } : {}),
        tuning,
      } satisfies Persisted,
      (m) => host.log('warn', m)
    )

  const cooldownLeft = () => Math.max(0, (lastEndAt + cfg.cooldown_sec * 1000 - host.now()) / 1000)

  const allDances = async (): Promise<DanceInfo[]> => {
    const lib = host.motions
    if (!lib) return []
    try {
      // refresh() is cheap when the folder was read a moment ago, and picks up a dance folder added while running
      return (await lib.refresh()).dances
    } catch {
      return lib.current?.dances ?? []
    }
  }
  const enabledDances = async () => (await allDances()).filter((d) => d.meta.enabled)

  const idle = () => {
    phase = 'idle'
    current = null
    requester = undefined
    trial = false
    enterOpts = {}
    noOutro = false
    host.flags.dancing = false
    if (outroTimer) clearTimeout(outroTimer)
    outroTimer = null
  }

  /** Wait for the stage to report a state of this dance that `want` accepts, for at most `ms`. */
  const waitStage = (want: (s: StageDance) => boolean, ms: number, signal: AbortSignal) =>
    new Promise<StageDance>((resolve, reject) => {
      const finish = (err?: Error, s?: StageDance) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters = waiters.filter((w) => w !== waiter)
        if (err) reject(err)
        else resolve(s as StageDance)
      }
      const timer = setTimeout(() => finish(new Error('the stage did not answer in time')), ms)
      const onAbort = () => finish(new Error('aborted'))
      const waiter = (s: StageDance) => {
        if (want(s)) finish(undefined, s)
      }
      waiters.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })

  // ─────────────────────────────── requests ───────────────────────────────

  const request: DanceRequest = async (req) => {
    await load()
    if (phase !== 'idle') return 'busy'
    const fromConsole = req.source === 'console'
    if (!fromConsole && (host.flags.sleeping || host.modeState('sleep') !== 'IDLE')) return 'busy'
    const all = await allDances()
    let pick: DanceInfo | undefined
    if (req.name) {
      pick = all.find((d) => d.name === req.name)
      if (!pick) return 'notfound'
      if (!fromConsole && !pick.meta.enabled) return 'none'
    } else {
      const list = all.filter((d) => d.meta.enabled)
      const pool = list.length > 1 ? list.filter((d) => d.name !== lastName) : list
      pick = pool[Math.floor(Math.random() * pool.length)]
    }
    if (!pick) return 'none'
    if (!fromConsole && cooldownLeft() > 0) return 'cooldown'
    if (phase !== 'idle') return 'busy' // something else got in while the list was being read
    current = pick
    requester = req.requester
    trial = req.trial === true
    enterOpts = { ...(req.replace ? { replace: true } : {}), ...(req.force ? { force: true } : {}) }
    noOutro = trial
    phase = 'pending'
    host.flags.dancing = true
    host.event(
      'mode',
      `dance "${pick.name}" requested (${req.source}${req.requester ? `, ${req.requester}` : ''})`
    )
    void waitThenEnter(++token, pick)
    return 'ok'
  }

  /** From accepted to being on stage: wait for the reply that carried the request to be spoken, then enter the mode. */
  const waitThenEnter = async (mine: number, info: DanceInfo) => {
    const quiet = await host.whenQuiet(cfg.pending_timeout_sec * 1000)
    if (mine !== token || phase !== 'pending') return
    if (!quiet) {
      host.log('warn', 'dance: waited too long for the speech to end; request dropped')
      host.event(
        'mode',
        `dance "${info.name}" dropped: the speech did not end within ${cfg.pending_timeout_sec} s`
      )
      idle()
      return
    }
    const r = await host.enterMode('dance', enterOpts)
    if (mine !== token) return
    if (!r.ok) {
      host.event('mode', `dance "${info.name}" could not start: ${r.reason ?? 'refused'}`)
      idle()
    }
  }

  const send = (info: DanceInfo) => {
    danceId = `dance-${++counter}`
    const msg = toDancePlay(info, danceId)
    const t = tuning[info.name]
    if (t?.offset !== undefined) msg.offset = Math.min(30, Math.max(-30, t.offset))
    if (t?.speed !== undefined) msg.speed = Math.min(3, Math.max(0.25, t.speed))
    host.hub.send(msg)
  }

  // ─────────────────────────────── the mode ───────────────────────────────

  return {
    request,
    status: () => ({
      phase,
      current: current?.name ?? null,
      cooldownLeft: cooldownLeft(),
      lastName,
    }),

    attach() {
      const onState = (m: { dance_id: string; phase: string; reason?: string; error?: string }) => {
        if (m.dance_id !== danceId) return
        for (const w of [...waiters]) w(m)
        if (m.phase === 'idle' && phase === 'playing') {
          // The dance is over on the stage: leave the mode. Moving to 'ending' first is what tells `exit` this was
          // not a cut short from outside (which would send a stop and skip the closing line).
          if (m.reason !== 'finished') noOutro = true
          phase = 'ending'
          void host.exitMode('dance', m.reason ?? 'finished')
        }
      }
      host.hub.on('dance.state', onState)
      void load()
      const refresh = () =>
        void allDances().then((all) => {
          known = all
          advertised = all.filter((d) => d.meta.enabled)
        })
      refresh()
      const timer = setInterval(refresh, 15_000)
      timer.unref?.()
      return () => {
        clearInterval(timer)
        host.hub.off('dance.state', onState)
        // a request still waiting for the reply to be spoken must not start a dance after shutdown
        token++
        if (phase === 'pending') idle()
      }
    },

    async enter(ctx: ModeContext) {
      await load()
      const info = current
      if (!info) throw new Error('no dance was requested')
      phase = 'loading'
      host.holdSpeech('dance', true)
      try {
        const started = waitStage(
          (s) => s.phase === 'playing' || s.phase === 'idle',
          cfg.start_timeout_sec * 1000,
          ctx.signal
        )
        send(info)
        const s = await started
        if (s.phase === 'idle')
          throw new Error(
            s.error ?? `the stage ended the dance at once (${s.reason ?? 'no reason'})`
          )
      } catch (e) {
        host.holdSpeech('dance', false)
        host.hub.send({ type: 'dance.stop', fade_s: 0.2 })
        // stopped from outside while it was starting: that is not a failure worth an alarm
        if (!ctx.signal.aborted)
          host.alarm(
            'dance_failed',
            'warn',
            `the dance "${info.name}" could not start: ${(e as Error).message}`,
            'dance'
          )
        idle()
        throw e
      }
      host.clearAlarm('dance_failed', 'dance')
      phase = 'playing'
      lastName = info.name
      save()
    },

    async exit(_ctx: ModeContext, reason: string) {
      const info = current
      if (phase === 'playing' || phase === 'loading') {
        // cut short from outside (console, another mode, shutdown): the stage fades it out
        host.hub.send({ type: 'dance.stop', fade_s: 0.5 })
        noOutro = true
      }
      phase = 'ending'
      host.holdSpeech('dance', false)
      if (!trial) {
        lastEndAt = host.now()
        save()
      }
      host.event('mode', `dance ${info ? `"${info.name}" ` : ''}over (${reason})`)
      if (noOutro || !info) return idle()

      // the closing line: tell the model, and keep the audience's queue closed until it starts answering
      phase = 'after'
      const who = requester ? ` (requested by ${requester})` : ''
      const text =
        host.prompt('dance', 'outro', { title: info.meta.title, who }) ??
        `【系统】You have just finished a dance "${info.meta.title}"${who}. Say one closing line in character.`
      void host
        .tellBrain(text)
        .catch((e) => host.log('warn', `dance: could not tell the model: ${(e as Error).message}`))
      const until = host.now() + cfg.outro_window_sec * 1000
      const release = () => {
        if (phase !== 'after') return
        if (host.brainBusy() || host.now() >= until) return idle()
        outroTimer = setTimeout(release, 200)
      }
      outroTimer = setTimeout(release, 200)
    },

    advertise() {
      if (phase !== 'idle' || host.flags.sleeping || advertised.length === 0) return null
      const left = cooldownLeft()
      const vars: Record<string, string> =
        left > 0
          ? { minutes: String(minutes(left)) }
          : { dances: advertised.map((d) => `${d.name} (${d.meta.title})`).join(', ') }
      return { prompt: left > 0 ? 'cooldown' : 'available', vars }
    },

    async onBatch(batch: Batch) {
      const lines: string[] = []
      for (const part of batch.parts) {
        if (part.kind !== 'dance') continue
        const result = await request({
          source: 'gift',
          ...(part.uname ? { requester: part.uname } : {}),
        })
        host.event('mode', `dance gift from ${part.uname ?? 'someone'} -> ${result}`)
        const which =
          result === 'ok'
            ? 'gift_ok'
            : result === 'cooldown'
              ? 'gift_cooldown'
              : result === 'busy'
                ? 'gift_busy'
                : 'gift_none'
        const text = host.prompt('dance', which, { minutes: String(minutes(cooldownLeft())) })
        if (text) lines.push(text)
      }
      return lines
    },

    async onModelRequest({ name }) {
      const result = await request({ source: 'tag', ...(name ? { name } : {}) })
      host.event('mode', `the model asked for a dance${name ? ` (${name})` : ''} -> ${result}`)
    },

    panel(): ModePanelInput {
      const running = phase === 'pending' || phase === 'loading' || phase === 'playing'
      const left = cooldownLeft()
      const status =
        phase === 'pending'
          ? `waiting for the reply to be spoken, then "${current?.title}"`
          : phase === 'loading' || phase === 'playing'
            ? `dancing "${current?.title}"${requester ? ` (asked by ${requester})` : ''}`
            : phase === 'after'
              ? 'finished; the closing line is being said'
              : left > 0
                ? `resting: the next dance can be asked for in ${Math.ceil(left)} s`
                : 'ready'
      const tuned = current ? tuning[current.name] : undefined
      const stop: PanelActionInput = {
        id: 'stop',
        label: 'Stop the dance',
        confirm: 'Stop the dance now? There will be no closing line.',
        ...(running ? {} : { disabled: 'no dance is running' }),
      }
      const tune: PanelActionInput = {
        id: 'tune',
        label: 'Tune the running dance',
        inputs: [
          {
            name: 'offset',
            label: 'Motion offset (s)',
            kind: 'number',
            min: -30,
            max: 30,
            step: 0.05,
            value: tuned?.offset ?? current?.meta.offset ?? 0,
          },
          {
            name: 'speed',
            label: 'Speed',
            kind: 'number',
            min: 0.25,
            max: 3,
            step: 0.01,
            value: tuned?.speed ?? current?.meta.speed ?? 1,
          },
        ],
        ...(phase === 'playing' || phase === 'loading' ? {} : { disabled: 'no dance is playing' }),
      }
      const busyWhy =
        running || phase === 'ending' || phase === 'after'
          ? 'a dance is already running'
          : undefined
      return {
        status,
        facts: [
          { label: 'Cooldown', value: `${cfg.cooldown_sec} s after each dance` },
          ...(lastName ? [{ label: 'Last dance', value: lastName }] : []),
        ],
        actions: [stop, tune],
        sections: [
          {
            title: 'Dances',
            empty: 'No dance folders were found in the motion library (dance/<name>/motion.vrma).',
            rows: known.map((d) => ({
              id: d.name,
              text: d.meta.title,
              detail: `${d.name}${d.meta.enabled ? '' : ' - switched off in meta.json'}${d.meta.bpm ? `, ${d.meta.bpm} BPM` : ''}${d.music ? '' : ', no music'}`,
              active: current?.name === d.name && phase !== 'idle',
              actions: [
                {
                  id: 'play',
                  label: 'Play',
                  inputs: [],
                  ...(busyWhy ? { disabled: busyWhy } : {}),
                },
                {
                  id: 'trial',
                  label: 'Trial run',
                  inputs: [],
                  ...(busyWhy ? { disabled: busyWhy } : {}),
                },
              ],
            })),
          },
        ],
      }
    },

    async onConsoleRequest(req) {
      const action = typeof req.action === 'string' ? req.action : 'play'
      if (action === 'stop') {
        if (phase !== 'pending' && phase !== 'loading' && phase !== 'playing')
          return { ok: false, reason: 'no dance is running' }
        if (phase === 'pending') {
          token++ // the request that is still waiting for the speech to end is withdrawn
          idle()
          host.event('mode', 'the waiting dance was withdrawn from the console')
        } else {
          await host.exitMode('dance', 'console')
        }
        return { ok: true }
      }
      if (action === 'tune') {
        const name = current?.name
        if (!name || (phase !== 'playing' && phase !== 'loading'))
          return { ok: false, reason: 'no dance is playing' }
        const t = {
          ...(typeof req.offset === 'number' ? { offset: req.offset } : {}),
          ...(typeof req.speed === 'number' ? { speed: req.speed } : {}),
        }
        tuning[name] = { ...tuning[name], ...t }
        save()
        host.hub.send({ type: 'dance.tune', ...t })
        return { ok: true }
      }
      // a button on a row of the list names the dance in `row`; the API can also send `name`
      const name =
        typeof req.row === 'string' ? req.row : typeof req.name === 'string' ? req.name : undefined
      const result = await request({
        source: 'console',
        ...(name !== undefined ? { name } : {}),
        trial: req.trial === true || action === 'trial',
        replace: req.replace === true,
        force: req.force === true,
      })
      return result === 'ok' ? { ok: true } : { ok: false, reason: result }
    },
  }
}
