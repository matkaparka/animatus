/**
 * Draw mode, ported from the legacy page's picture-request feature.
 *
 * A viewer writes the command word and what they want (`画 一条龙`); while the mode is active that message is taken
 * out of the chat and becomes a request. Layer 1 (the blocklist) answers before any model is asked. Then, one request
 * at a time: the image service is asked whether it is ready, the model plans the picture (two calls, which can refuse),
 * the frame on the stage says who is being drawn for, the service draws it under its own safety layers, the picture is
 * kept in `data/generated` and shown, and the character comments on it (the model is shown the picture).
 *
 * What a viewer can never make happen: their words on the stage or in front of the model before layer 1 and the
 * planner have passed them, a refusal that repeats or hints at what was asked (a refusal is a line of the pack, or a
 * model that is not told the request), a hold on the voice that outlives an error, a stop or a shutdown (the mode
 * takes none: the reaction waits for a quiet voice and is dropped if the mode has been left).
 */
import path from 'node:path'
import type { ModePanelInput, PanelActionInput } from '@animatus/protocol'
import { truncateChars } from '../../inbox/text.ts'
import { BlocklistUnavailable, DrawBlocklist } from '../draw/blocklist.ts'
import { ForgeCallError, ForgeClient } from '../draw/client.ts'
import type { ForgeCatalog, ForgeHealth } from '../draw/client.ts'
import { Cooldowns, cooldownKey } from '../draw/cooldown.ts'
import { frameMessages } from '../draw/frame.ts'
import type { FrameState, FrameTexts } from '../draw/frame.ts'
import { parseLines, pickLine } from '../draw/lines.ts'
import { isPng, prunePictures, savePicture } from '../draw/pictures.ts'
import { PlanError, createPlanner } from '../draw/plan.ts'
import { parseDrawSettings } from '../draw/settings.ts'
import type { ChatCommand, ModeControllerFull, ModeHost } from '../host.ts'
import type { ModeContext } from '../manager.ts'

/** Every prompt file the controller uses; a pack that lacks one cannot start (better than a silent, empty line on stream). */
const REQUIRED_PROMPTS = [
  'active',
  'frame_idle',
  'frame_generating',
  'frame_showing',
  'name_anonymous',
  'name_host',
  'refusals',
  'errors',
  'refusal_model',
  'reaction_ok',
  'reaction_ok_blind',
  'reaction_self',
  'plan_rules',
  'plan_select_system',
  'plan_select',
  'plan_write_system',
  'plan_write',
  'notes_block',
  'note_self_rule',
  'note_self',
  'note_self_write',
  'note_photo',
  'note_photo_write',
  'note_furry',
  'guide_sdxl',
]

/** How often the panel's view of the image service is refreshed while the mode runs. */
const HEALTH_POLL_MS = 15_000
const NAME_IN_PROMPT_CHARS = 24
const MAX_PENDING_LINES = 3

export interface DrawDeps {
  /** What the image service is called with; for tests. */
  fetch?: typeof fetch
}

export interface DrawStatus {
  active: boolean
  queue: number
  /** Who the picture being made is for, or null. */
  current: string | null
  frame: FrameState['kind']
  maxLongSide: number | null
}

export type DrawSubmit =
  'queued' | 'empty' | 'cooldown' | 'full' | 'refused' | 'unavailable' | 'stopped'

interface Job {
  id: number
  key: string
  /** The name as shown: a name that hit the blocklist is replaced by the pack's anonymous one. */
  user: string
  text: string
}

interface Running {
  job: Job
  abort: AbortController
  epoch: number
  stage: 'planning' | 'drawing'
}

interface Picture {
  url: string
  thumb: { mime: string; base64: string }
  self: boolean
}

type Outcome =
  | { kind: 'ok'; picture: Picture }
  /** The planner, the service's rules or its rating model said no. */
  | { kind: 'refused'; reason: string }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'cancelled' }

type Reaction = { kind: 'ok'; job: Job; picture: Picture } | { kind: 'refused' } | { kind: 'error' }

const oneLine = (e: unknown, max = 300): string =>
  (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, max)
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const escapeForClass = (s: string): string => s.replace(/[\\\]^-]/g, '\\$&')

export function createDrawController(
  host: ModeHost,
  deps: DrawDeps = {}
): ModeControllerFull & {
  status(): DrawStatus
  submit(who: { uid: number; uname: string; owner: boolean }, text: string): DrawSubmit
} {
  const cfg = parseDrawSettings(host.config.modes.draw?.config, host.config.root)
  const blocklist = new DrawBlocklist(cfg.blocklist_paths, () => host.now())
  const planner = createPlanner(host, cfg)
  const cooldowns = new Cooldowns(
    path.join(host.dataDir, 'draw-state.json'),
    () => cfg.cooldown_sec * 1000,
    () => host.now(),
    (m) => host.log('warn', `draw: ${m}`)
  )
  const measureWords = cfg.measure_words
    ? new RegExp(`^[${escapeForClass(cfg.measure_words)}]`, 'u')
    : null

  let active = false
  /** Bumped when the mode is left: whatever started before must not act after. */
  let epoch = 0
  let command = '画'
  let counter = 0
  let frame: FrameState = { kind: 'idle' }
  let showTimer: NodeJS.Timeout | null = null
  let healthTimer: NodeJS.Timeout | null = null
  const queue: Job[] = []
  let current: Running | null = null
  let pumping = false
  /** Comments are said one after the other, each when the voice is free. */
  let speaking: Promise<void> = Promise.resolve()
  let last: { url: string; user: string } | null = null
  let lastHealth: ForgeHealth | null = null
  let healthProblem: string | null = null
  let lastProblem: string | null = null
  let catalog: { at: number; value: ForgeCatalog } | null = null

  // ─────────────────────────────── helpers ───────────────────────────────

  const prompt = (name: string, vars: Record<string, string> = {}): string => {
    const t = host.prompt('draw', name, vars)
    if (t === null) throw new Error(`the draw pack has no prompts/${name}.md`)
    return t
  }
  const client = (): ForgeClient | null => {
    const base = host.serviceUrl(cfg.service)
    return base
      ? new ForgeClient(base, {
          generateTimeoutMs: cfg.generate_timeout_sec * 1000 + 30_000,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        })
      : null
  }
  const shortName = (name: string, max = cfg.frame.max_name_chars): string =>
    truncateChars(name, max)

  // ─────────────────────────────── the frame ───────────────────────────────

  const texts = (): FrameTexts => ({
    idle: prompt('frame_idle', { command }),
    generating: (user, request) => prompt('frame_generating', { user, request }),
    showing: (user) => prompt('frame_showing', { user }),
  })

  const send = (state: FrameState | { kind: 'hidden' }): void => {
    try {
      for (const m of frameMessages(
        state,
        { textOverlay: cfg.frame.text_overlay, rect: cfg.frame.rect },
        texts()
      ))
        host.hub.setOverlay(m)
    } catch (e) {
      host.log('error', `draw: the frame could not be updated: ${oneLine(e)}`)
    }
  }

  const setFrame = (next: FrameState): void => {
    frame = next
    if (showTimer) clearTimeout(showTimer)
    showTimer = null
    if (next.kind === 'showing') {
      const at = next.at
      showTimer = setTimeout(() => {
        if (frame.kind === 'showing' && frame.at === at) setFrame({ kind: 'idle' })
      }, cfg.show_sec * 1000)
      showTimer.unref?.()
    }
    send(next)
  }

  /** What the frame showed before a request began, or the hint when that picture has been up for too long. */
  const restore = (before: FrameState): void => {
    // only the "drawing" state is this request's: if the frame never changed, or the operator cleared it, leave it
    if (frame.kind !== 'generating') return
    const expired = before.kind === 'showing' && host.now() - before.at >= cfg.show_sec * 1000
    setFrame(before.kind === 'showing' && !expired ? before : { kind: 'idle' })
  }

  // ─────────────────────────────── what the character says ───────────────────────────────

  const sayLine = (file: 'refusals' | 'errors'): void => {
    const line = pickLine(parseLines(prompt(file)))
    if (line) host.say({ text: line.text, emotion: line.emotion })
  }

  const speak = async (r: Reaction, mine: number): Promise<void> => {
    const live = () => active && mine === epoch
    if (!live()) return
    if (cfg.reaction_wait_sec > 0) await host.whenQuiet(cfg.reaction_wait_sec * 1000)
    if (!live()) return
    if (r.kind === 'ok') {
      const self = r.picture.self ? ` ${prompt('reaction_self')}` : ''
      const vars = { user: shortName(r.job.user, NAME_IN_PROMPT_CHARS), request: r.job.text, self }
      if (cfg.send_image)
        await host.tellBrain(prompt('reaction_ok', vars), { images: [r.picture.thumb] })
      else await host.tellBrain(prompt('reaction_ok_blind', vars))
    } else if (r.kind === 'refused') {
      // the model is never told what was asked: not for the words, not for the reason
      if (cfg.refusal === 'model') await host.tellBrain(prompt('refusal_model'))
      else sayLine('refusals')
    } else sayLine('errors')
  }

  /** Refusals and fault lines waiting to be said. A raid of blocked requests must not keep the voice busy for minutes. */
  let pendingLines = 0

  const react = (r: Reaction): void => {
    const isLine = r.kind !== 'ok'
    if (isLine) {
      if (pendingLines >= MAX_PENDING_LINES) {
        host.log(
          'info',
          'draw: a refusal or fault line was dropped: too many are waiting to be said'
        )
        return
      }
      pendingLines++
    }
    const mine = epoch
    speaking = speaking
      .then(() => speak(r, mine))
      .catch((e) => host.log('warn', `draw: the comment could not be made: ${oneLine(e)}`))
      .finally(() => {
        if (isLine) pendingLines--
      })
  }

  // ─────────────────────────────── the image service ───────────────────────────────

  const noteHealth = (h: ForgeHealth): void => {
    lastHealth = h
    healthProblem = null
  }

  const refreshHealth = async (): Promise<void> => {
    const c = client()
    if (!c) {
      lastHealth = null
      healthProblem = `the ${cfg.service} service is not running`
      return
    }
    try {
      noteHealth(await c.health())
    } catch (e) {
      lastHealth = null
      healthProblem = oneLine(e)
    }
  }

  const catalogOf = async (c: ForgeClient, signal: AbortSignal): Promise<ForgeCatalog> => {
    if (catalog && host.now() - catalog.at < cfg.catalog_ttl_sec * 1000) return catalog.value
    const value = await c.catalog(signal)
    catalog = { at: host.now(), value }
    return value
  }

  const maxLongSide = (): number | null => {
    const v = lastHealth?.config.max_long_side
    return typeof v === 'number' ? v : null
  }

  // ─────────────────────────────── one request ───────────────────────────────

  /** Plan, draw, keep. Never throws: every way it can end is an Outcome. */
  const produce = async (run: Running): Promise<Outcome> => {
    const { job } = run
    const signal = run.abort.signal
    try {
      const c = client()
      if (!c)
        return {
          kind: 'error',
          code: 'unavailable',
          message: `the ${cfg.service} service is not running`,
        }
      const health = await c.health(signal)
      noteHealth(health)
      if (!health.ok || !health.ready)
        return {
          kind: 'error',
          code: 'unavailable',
          message: `the image service is not ready${health.detail ? `: ${health.detail}` : ''}`,
        }
      if (health.config.forge_reachable === false)
        return {
          kind: 'error',
          code: 'forge_unreachable',
          message: `Forge is not reachable${typeof health.config.forge_error === 'string' ? `: ${health.config.forge_error}` : ''}`,
        }
      const known = await catalogOf(c, signal)
      if (signal.aborted) return { kind: 'cancelled' }
      const planned = await planner.plan(job.text, known, signal)
      // a model that took no notice of being stopped may still have answered: nothing more may happen then
      if (signal.aborted) return { kind: 'cancelled' }
      if (planned.kind === 'refused') return { kind: 'refused', reason: planned.reason }

      // Layer 1 and the planner have passed: only now may the request be put on the stage.
      run.stage = 'drawing'
      setFrame({
        kind: 'generating',
        user: shortName(job.user),
        request: truncateChars(job.text, cfg.frame.max_request_chars),
      })
      host.event('mode', `draw: drawing for ${job.user}: ${job.text}`)
      const drawn = await c.generate(planned.payload, signal)
      if (signal.aborted) return { kind: 'cancelled' }
      if (drawn.status !== 'ok') return { kind: 'refused', reason: drawn.reason }

      const png = Buffer.from(drawn.image_b64, 'base64')
      if (!isPng(png))
        return {
          kind: 'error',
          code: 'bad_answer',
          message: 'the image service returned a picture that is not a PNG',
        }
      const dir = host.libraryDir('generated')
      if (!dir)
        return {
          kind: 'error',
          code: 'no_folder',
          message: 'there is no folder for generated pictures',
        }
      const file = await savePicture(dir, png, host.now(), ++counter)
      await prunePictures(dir, cfg.keep_pictures)
      return {
        kind: 'ok',
        picture: {
          url: host.assetUrl('generated', file),
          thumb: drawn.thumb_b64
            ? { mime: 'image/jpeg', base64: drawn.thumb_b64 }
            : { mime: 'image/png', base64: drawn.image_b64 },
          self: planned.self,
        },
      }
    } catch (e) {
      if (signal.aborted) return { kind: 'cancelled' }
      if (e instanceof ForgeCallError) return { kind: 'error', code: e.code, message: e.message }
      if (e instanceof PlanError) return { kind: 'error', code: 'plan', message: e.message }
      return { kind: 'error', code: 'failed', message: oneLine(e) }
    }
  }

  const runJob = async (job: Job): Promise<void> => {
    const run: Running = { job, abort: new AbortController(), epoch, stage: 'planning' }
    current = run
    const before = frame
    /** The mode was left meanwhile: the frame is already gone and nothing may be shown, said or raised any more. */
    const gone = () => run.epoch !== epoch
    const cancelled = () => run.abort.signal.aborted
    try {
      const outcome = await produce(run)
      if (gone()) {
        cooldowns.refund(job.key) // the viewer did nothing wrong
        return
      }
      if (outcome.kind === 'cancelled' || cancelled()) {
        // cancelled from the panel: the frame goes back, nothing is said or raised, the viewer keeps their turn
        restore(before)
        cooldowns.refund(job.key)
        host.event('mode', `draw: the request from ${job.user} was cancelled`)
        return
      }
      if (outcome.kind === 'ok') {
        host.clearAlarm('draw_failed', 'draw')
        lastProblem = null
        last = { url: outcome.picture.url, user: job.user }
        setFrame({
          kind: 'showing',
          user: shortName(job.user),
          image: outcome.picture.url,
          at: host.now(),
        })
        host.event('mode', `draw: the picture for ${job.user} is up`)
        react({ kind: 'ok', job, picture: outcome.picture })
      } else if (outcome.kind === 'refused') {
        restore(before)
        host.event('mode', `draw: a request from ${job.user} was refused (${outcome.reason})`)
        react({ kind: 'refused' })
      } else {
        restore(before)
        cooldowns.refund(job.key) // a fault is not the viewer's doing: they may ask again at once
        lastProblem = outcome.message
        host.alarm(
          'draw_failed',
          'warn',
          `the picture for ${job.user} could not be made: ${outcome.message}`,
          'draw'
        )
        host.event('mode', `draw: could not draw for ${job.user}: ${outcome.message}`)
        react({ kind: 'error' })
      }
    } catch (e) {
      // a bug in this file must not stop the queue
      host.log('error', `draw: ${oneLine(e)}`)
      if (!gone()) {
        restore(before)
        cooldowns.refund(job.key)
        if (!cancelled())
          host.alarm(
            'draw_failed',
            'warn',
            `the picture for ${job.user} could not be made: ${oneLine(e)}`,
            'draw'
          )
      }
    } finally {
      if (current === run) current = null
    }
  }

  const pump = async (): Promise<void> => {
    if (pumping) return
    pumping = true
    try {
      while (active && queue.length > 0) await runJob(queue.shift() as Job)
    } finally {
      pumping = false
    }
  }

  // ─────────────────────────────── requests ───────────────────────────────

  const submit = (who: { uid: number; uname: string; owner: boolean }, raw: string): DrawSubmit => {
    if (!active) return 'stopped'
    const text = truncateChars(raw.trim(), cfg.max_chars, '')
    if (text === '') {
      host.event('mode', `draw: ${who.uname} sent the command word and nothing else`)
      return 'empty'
    }
    const key = cooldownKey(who.uid, who.uname)
    const skips = who.owner && cfg.owner_skips_cooldown
    const wait = skips ? 0 : cooldowns.left(key)
    if (wait > 0) {
      host.event(
        'mode',
        `draw: a request from ${who.uname} was ignored, ${Math.ceil(wait / 1000)} s of cooldown left`
      )
      return 'cooldown'
    }
    if (queue.length >= cfg.queue_max) {
      host.event('mode', `draw: a request from ${who.uname} was ignored, the queue is full`)
      return 'full'
    }
    // From here on the viewer waits, whatever comes of the request: a refused one counts too (it is what stops a viewer
    // from trying word after word), and so does one that could not be looked at (a raid must not flood the voice).
    if (!skips) cooldowns.start(key)
    // Layer 1, before any model is asked and before anything of the request goes on the stage.
    let hit: string | null
    let user = who.uname
    try {
      hit = blocklist.hit(text)
      if (user === '' || blocklist.hit(user) !== null) user = prompt('name_anonymous')
      host.clearAlarm('draw_blocklist', 'draw')
    } catch (e) {
      const message = e instanceof BlocklistUnavailable ? e.message : oneLine(e)
      host.alarm(
        'draw_blocklist',
        'error',
        `draw requests are refused until this is fixed: ${message}`,
        'draw'
      )
      host.event('mode', `draw: a request from ${who.uname} was not looked at: ${message}`)
      react({ kind: 'error' })
      return 'unavailable'
    }
    if (hit !== null) {
      host.log('info', `draw: a request from ${who.uname} hit the blocklist entry "${hit}"`)
      host.event('mode', `draw: a request from ${user} was refused by the blocklist`)
      react({ kind: 'refused' })
      return 'refused'
    }
    queue.push({ id: ++counter, key, user, text })
    host.event('mode', `draw: a request from ${user} is queued (${queue.length} waiting)`)
    void pump()
    return 'queued'
  }

  /** `画 xxx`, `/画 xxx`; but 画风不错 is chat: a word that does not start with "/" needs a space, a colon or a measure word after it. */
  const isRequest = (cmd: ChatCommand): boolean => {
    if (cmd.prefix.startsWith('/')) return true
    const rest = cmd.text.trim().slice(cmd.prefix.length)
    return /^[\s:：]/.test(rest) || (measureWords?.test(rest) ?? false)
  }

  const cancel = (id: string): { ok: boolean; reason?: string } => {
    if (current && String(current.job.id) === id) {
      current.abort.abort()
      return { ok: true }
    }
    const i = queue.findIndex((j) => String(j.id) === id)
    if (i < 0) return { ok: false, reason: 'that request is not waiting any more' }
    const [job] = queue.splice(i, 1)
    if (job) cooldowns.refund(job.key)
    return { ok: true }
  }

  // ─────────────────────────────── the mode ───────────────────────────────

  return {
    status: () => ({
      active,
      queue: queue.length,
      current: current?.job.user ?? null,
      frame: frame.kind,
      maxLongSide: maxLongSide(),
    }),
    submit,

    attach() {
      void cooldowns.load()
      return () => {
        epoch++
        if (showTimer) clearTimeout(showTimer)
        if (healthTimer) clearInterval(healthTimer)
        showTimer = healthTimer = null
      }
    },

    async enter(ctx: ModeContext) {
      for (const name of REQUIRED_PROMPTS)
        if (host.prompt('draw', name) === null)
          throw new Error(`the draw pack has no prompts/${name}.md`)
      blocklist.check() // throws with the reason: the mode does not start with a safety layer missing
      if (!host.serviceUrl(cfg.service))
        throw new Error(`the "${cfg.service}" service is not running`)
      await cooldowns.load()
      const words = ctx.manifest.triggers.danmaku_prefix
      command = words.find((w) => !w.startsWith('/')) ?? words[0] ?? command
      queue.length = 0
      active = true
      setFrame({ kind: 'idle' })
      void refreshHealth()
      healthTimer = setInterval(() => void refreshHealth(), HEALTH_POLL_MS)
      healthTimer.unref?.()
    },

    async exit(_ctx: ModeContext, reason: string) {
      active = false
      epoch++
      current?.abort.abort()
      for (const job of queue.splice(0)) cooldowns.refund(job.key) // they never got a picture
      if (showTimer) clearTimeout(showTimer)
      if (healthTimer) clearInterval(healthTimer)
      showTimer = healthTimer = null
      catalog = null
      lastHealth = null // the service goes with the mode: what it last said is no longer true
      healthProblem = null
      frame = { kind: 'idle' }
      send({ kind: 'hidden' })
      host.clearAlarm('draw_failed', 'draw')
      host.clearAlarm('draw_blocklist', 'draw')
      host.event('mode', `draw: over (${reason})`)
    },

    promptVars: () => ({ command }),

    onChatCommand(cmd: ChatCommand): boolean {
      if (!active || !isRequest(cmd)) return false
      submit(
        { uid: cmd.uid, uname: cmd.uname, owner: cmd.owner },
        cmd.argument.replace(/^[\s:：]+/, '')
      )
      return true
    },

    panel(): ModePanelInput {
      const off = active ? {} : { disabled: 'the mode is not running' }
      const running = current
      const status = !active
        ? 'not running'
        : running
          ? `${running.stage === 'planning' ? 'planning' : 'drawing'} for ${running.job.user}: ${clip(running.job.text, 60)}`
          : 'waiting for requests'
      const service = lastHealth
        ? lastHealth.ok && lastHealth.ready
          ? 'ready'
          : `not ready${lastHealth.detail ? `: ${lastHealth.detail}` : ''}`
        : (healthProblem ?? 'not asked yet')
      const forge = lastHealth?.config.forge_reachable
      const facts = [
        { label: 'Image service', value: clip(service, 200) },
        {
          label: 'Forge',
          value:
            forge === true
              ? 'reachable'
              : forge === false
                ? clip(`not reachable: ${String(lastHealth?.config.forge_error ?? '')}`, 200)
                : 'not known yet',
        },
        {
          label: 'Rating model',
          value: String(lastHealth?.config.rating_model ?? 'not known yet'),
        },
        {
          label: 'Longest side',
          value: maxLongSide() === null ? 'not known yet' : `${maxLongSide()} px`,
        },
        { label: 'Queue', value: `${queue.length} waiting, at most ${cfg.queue_max}` },
        { label: 'Cooldown', value: `${cfg.cooldown_sec} s for each viewer` },
        ...(lastProblem ? [{ label: 'Last problem', value: clip(lastProblem, 200) }] : []),
      ]
      const cancelAction: PanelActionInput = { id: 'cancel', label: 'Cancel', inputs: [] }
      const rows = [
        ...(running
          ? [
              {
                id: String(running.job.id),
                text: clip(`${running.job.user}: ${running.job.text}`, 280),
                detail: running.stage === 'planning' ? 'planning' : 'drawing',
                active: true,
                actions: [cancelAction],
              },
            ]
          : []),
        ...queue.map((job, i) => ({
          id: String(job.id),
          text: clip(`${job.user}: ${job.text}`, 280),
          detail: `waiting, number ${i + 1}`,
          active: false,
          actions: [cancelAction],
        })),
      ]
      return {
        status,
        facts,
        ...(last ? { image: last.url } : {}),
        actions: [
          {
            id: 'draw',
            label: 'Draw a picture now',
            inputs: [
              {
                name: 'request',
                label: 'What to draw',
                kind: 'text',
                placeholder: 'a dragon asleep in a crater',
              },
            ],
            ...off,
          },
          { id: 'clear', label: 'Clear the frame', inputs: [], ...off },
          {
            id: 'set_max_long_side',
            label: 'Longest side of a picture',
            inputs: [
              {
                name: 'max_long_side',
                label: 'Pixels (a multiple of 64)',
                kind: 'number',
                min: 512,
                max: 2048,
                step: 64,
                value: maxLongSide() ?? 1024,
              },
            ],
            ...off,
          },
        ],
        sections: [{ title: 'Queue', empty: 'Nothing is being drawn or waiting.', rows }],
      }
    },

    async onConsoleRequest(req) {
      const action = typeof req.action === 'string' ? req.action : 'enter'
      if (action === 'enter')
        return host.enterMode('draw', { replace: req.replace === true, force: req.force === true })
      if (!active) return { ok: false, reason: 'the mode is not running' }
      if (action === 'clear') {
        setFrame({ kind: 'idle' })
        return { ok: true }
      }
      if (action === 'cancel')
        return typeof req.row === 'string'
          ? cancel(req.row)
          : { ok: false, reason: 'say which request to cancel' }
      if (action === 'draw') {
        const request = typeof req.request === 'string' ? req.request : ''
        const result = submit({ uid: 0, uname: prompt('name_host'), owner: true }, request)
        const why: Record<DrawSubmit, string> = {
          queued: '',
          empty: 'write what to draw',
          cooldown: 'wait a moment',
          full: 'the queue is full',
          refused: 'the request is on the blocklist',
          unavailable: 'the blocklist cannot be read',
          stopped: 'the mode is not running',
        }
        return result === 'queued' ? { ok: true } : { ok: false, reason: why[result] }
      }
      if (action === 'set_max_long_side') {
        const v = req.max_long_side
        if (typeof v !== 'number' || !Number.isInteger(v) || v % 64 !== 0 || v < 512 || v > 2048)
          return {
            ok: false,
            reason: 'the longest side is a whole multiple of 64 from 512 to 2048',
          }
        const c = client()
        if (!c) return { ok: false, reason: `the ${cfg.service} service is not running` }
        try {
          await c.setMaxLongSide(v)
        } catch (e) {
          return { ok: false, reason: oneLine(e) }
        }
        await refreshHealth()
        return { ok: true }
      }
      return { ok: false, reason: `there is no action "${action}"` }
    },
  }
}
