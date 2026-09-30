/**
 * Planning a picture: from one line of chat to the request the image service draws. Two calls to the model, ported from
 * the legacy planner:
 *
 *   1. choose the model, the LoRAs and the shape (and say whether the viewer wants the streamer's own character);
 *   2. write the prompt for the chosen model.
 *
 * Which route a request takes (self, photo, furry, default) is decided by the words in the configuration first and
 * then, from the default route only, by what the model found out (it saw a self-portrait, a photograph, a furry).
 * Both calls carry the public-broadcast rules and may answer `{"refuse": true}`: that is a refusal, and so is an
 * answer that is not JSON at all (a provider's safety filter returns nothing). A model that cannot be reached is not a
 * refusal but an error, and the caller is told by an exception.
 */
import type { ModeHost } from '../host.ts'
import type { ForgeCatalog, GeneratePayload } from './client.ts'
import {
  cleanPrompt,
  dropAmbiguous,
  orientationOf,
  parseJsonObject,
  sizeFor,
} from './promptText.ts'
import { ROUTE_NAMES } from './settings.ts'
import type { CheckpointEntry, DrawSettings, LoraEntry, RouteEntry, RouteName } from './settings.ts'

/** The setup cannot make this picture (a checkpoint the image service lacks, a pack file that is missing). Not a refusal. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanError'
  }
}

export type RefusalReason =
  'planner_refused' | 'planner_no_json' | 'writer_refused' | 'writer_no_json'

export type Planned =
  | { kind: 'refused'; reason: RefusalReason }
  | {
      kind: 'ok'
      route: RouteName
      payload: GeneratePayload
      /** The picture shows the streamer's own character. */
      self: boolean
    }

/** Quality words the program adds in front of a prompt; not when the model wrote some of its own into the middle of it. */
const QUALITY_WORDS = ['masterpiece', 'best quality', 'ultra quality', 'absurdres', 'score_9']
const PHOTO_STYLE =
  /^(photo|photograph|photography|photorealistic|realistic photo|照片|真人|写实照片)$/i

/** The route the words of a request select: self, then photo, then furry; else default. */
export function detectRoute(request: string, routes: DrawSettings['routes']): RouteName {
  const text = request.trim().toLowerCase()
  for (const name of ROUTE_NAMES) {
    const route = routes[name]
    if (!route) continue
    if (route.exact.some((w) => w.toLowerCase() === text)) return name
    if (route.keywords.some((w) => text.includes(w.toLowerCase()))) return name
  }
  return 'default'
}

const stem = (title: string): string =>
  (
    title
      .replace(/\s*\[[0-9a-f]+\]\s*$/i, '')
      .split(/[\\/]/)
      .pop() ?? ''
  ).replace(/\.[^.]+$/, '')

type InstalledCheckpoint = ForgeCatalog['checkpoints'][number]

/** The checkpoint of the image service a name means: exact (name, title, file stem) first, else the only one that contains it. */
export function findInstalled(
  list: readonly InstalledCheckpoint[],
  wanted: string
): InstalledCheckpoint | undefined {
  const w = wanted.trim().toLowerCase()
  const exact = list.find((c) =>
    [c.name, c.title, stem(c.title)].some((x) => x.toLowerCase() === w)
  )
  if (exact) return exact
  const partial = list.filter((c) => `${c.title} ${c.name}`.toLowerCase().includes(w))
  return partial.length === 1 ? partial[0] : undefined
}

interface Usable {
  checkpoints: CheckpointEntry[]
  loras: LoraEntry[]
  problems: string[]
}

function usable(route: RouteEntry, catalog: ForgeCatalog): Usable {
  const out: Usable = { checkpoints: [], loras: [], problems: [] }
  for (const entry of route.checkpoints) {
    const found = findInstalled(catalog.checkpoints, entry.name)
    if (!found)
      out.problems.push(`the checkpoint "${entry.name}" is not in Forge, or matches several`)
    else if (!found.allowed)
      out.problems.push(
        `the checkpoint "${entry.name}" cannot be used: ${found.why_not ?? 'not allowed'}`
      )
    else out.checkpoints.push(entry)
  }
  for (const lora of route.loras) {
    const found = catalog.loras.find((l) =>
      [l.name, l.alias].some((n) => n?.toLowerCase() === lora.name.toLowerCase())
    )
    if (!found) out.problems.push(`the LoRA "${lora.name}" is not in Forge`)
    else if (!found.allowed)
      out.problems.push(`the LoRA "${lora.name}" is not on the image service's allowlist`)
    else out.loras.push(lora)
  }
  return out
}

const strip = (s: string): string => s.replace(/^[ ,]+|[ ,]+$/g, '')

interface Selection {
  plan: Record<string, unknown>
}

export interface Planner {
  plan(request: string, catalog: ForgeCatalog, signal: AbortSignal): Promise<Planned>
}

export function createPlanner(host: ModeHost, cfg: DrawSettings): Planner {
  const warned = new Set<string>()
  const text = (name: string, vars: Record<string, string> = {}): string => {
    const t = host.prompt('draw', name, vars)
    if (t === null) throw new PlanError(`the draw pack has no prompts/${name}.md`)
    return t
  }
  const rules = () => text('plan_rules')

  const usableOf = (name: RouteName, catalog: ForgeCatalog): { route: RouteEntry; u: Usable } => {
    const route = cfg.routes[name]
    if (!route) throw new PlanError(`the ${name} route is not configured`)
    const u = usable(route, catalog)
    for (const p of u.problems)
      if (!warned.has(p)) {
        warned.add(p)
        host.log('warn', `draw: ${name} route: ${p}`)
      }
    if (u.checkpoints.length === 0)
      throw new PlanError(
        `no checkpoint of the ${name} route can be used: ${u.problems.join('; ')}`
      )
    // a route that draws with one fixed model and LoRA must have all of it, or it would draw something else
    if (
      route.fixed &&
      (u.checkpoints[0] !== route.checkpoints[0] || u.loras.length < route.loras.length)
    )
      throw new PlanError(
        `the ${name} route cannot be used as configured: ${u.problems.join('; ')}`
      )
    return { route, u }
  }

  const routeNote = (name: RouteName, route: RouteEntry, u: Usable): string => {
    const vars = { description: route.description, checkpoint: u.checkpoints[0]?.name ?? '' }
    if (name === 'self') return text('note_self', vars) + '\n'
    if (name === 'photo') return text('note_photo', vars) + '\n'
    if (name === 'furry') return text('note_furry', vars) + '\n'
    return ''
  }

  const notesBlock = (): string =>
    cfg.planner_notes.trim()
      ? text('notes_block', { notes: cfg.planner_notes.trim() }) + '\n\n'
      : ''

  const line = (c: CheckpointEntry): string =>
    `- ${[c.name, `style ${c.style}`, c.desc].filter(Boolean).join(' | ')}`
  const loraLine = (l: LoraEntry): string =>
    `- ${[l.name, `recommended weight ${l.weight}`, l.desc].filter(Boolean).join(' | ')}`

  /** Both planning calls. The answer is the first JSON object in the reply; the second try is for a reply that has none. */
  async function ask(
    tag: string,
    system: string,
    user: string,
    signal: AbortSignal
  ): Promise<Record<string, unknown> | null> {
    for (let i = 0; i < 2; i++) {
      let reply: string
      try {
        reply = await host.llmText({
          tag,
          system: `${system}\n\n${rules()}`,
          user,
          temperature: 0.2,
          timeoutMs: cfg.plan_timeout_sec * 1000,
          signal,
        })
      } catch (e) {
        if (signal.aborted) throw e
        // a model that cannot be reached is a fault to report, never a refusal to draw
        throw new PlanError(
          `the model could not plan the picture: ${(e instanceof Error ? e.message : String(e)).split(/\r?\n/, 1)[0]}`
        )
      }
      const obj = parseJsonObject(reply)
      if (obj) return obj
    }
    return null
  }

  async function select(
    request: string,
    name: RouteName,
    catalog: ForgeCatalog,
    signal: AbortSignal
  ): Promise<Selection | { refused: RefusalReason }> {
    const { route, u } = usableOf(name, catalog)
    const self = cfg.routes.self
    const selfRule =
      self && name !== 'self'
        ? text('note_self_rule', { description: self.description }) + '\n'
        : ''
    const user = text('plan_select', {
      request,
      notes: notesBlock(),
      route_note: routeNote(name, route, u),
      checkpoints: u.checkpoints.map(line).join('\n'),
      loras: route.fixed
        ? '(none: the program attaches them)'
        : u.loras.map(loraLine).join('\n') || '(none)',
      max_loras: String(cfg.max_loras),
      self_rule: selfRule,
    })
    const plan = await ask('draw-select', text('plan_select_system'), user, signal)
    if (!plan) return { refused: 'planner_no_json' }
    if (plan.refuse) return { refused: 'planner_refused' }
    return { plan }
  }

  return {
    async plan(request, catalog, signal): Promise<Planned> {
      let route = detectRoute(request, cfg.routes)
      let selected = await select(request, route, catalog, signal)
      if ('refused' in selected) return { kind: 'refused', reason: selected.refused }
      let plan = selected.plan
      // From the default route only: what the model found out can move the request to a route of its own.
      let reselected = true
      if (route === 'default') {
        const style = typeof plan.style === 'string' ? plan.style.trim() : ''
        const subject = typeof plan.subject === 'string' ? plan.subject.toLowerCase() : ''
        if (plan.self === true && cfg.routes.self) {
          route = 'self'
          reselected = false
        } else if (PHOTO_STYLE.test(style) && cfg.routes.photo) {
          route = 'photo'
          selected = await select(request, route, catalog, signal)
          if ('refused' in selected) return { kind: 'refused', reason: selected.refused }
          plan = selected.plan
        } else if (
          cfg.routes.furry &&
          subject &&
          cfg.routes.furry.keywords.some((w) => subject.includes(w.toLowerCase()))
        ) {
          route = 'furry'
          reselected = false
        }
      }

      const { route: r, u } = usableOf(route, catalog)
      const asked = typeof plan.checkpoint === 'string' ? plan.checkpoint.trim().toLowerCase() : ''
      const entry: CheckpointEntry =
        (!r.fixed && reselected
          ? (u.checkpoints.find((c) => c.name.toLowerCase() === asked) ??
            u.checkpoints.find((c) => asked !== '' && c.name.toLowerCase().includes(asked)))
          : undefined) ?? (u.checkpoints[0] as CheckpointEntry)

      const chosen: { lora: LoraEntry; weight: number }[] = []
      if (r.fixed) {
        for (const lora of u.loras) chosen.push({ lora, weight: lora.weight })
      } else if (Array.isArray(plan.loras)) {
        for (const item of plan.loras as unknown[]) {
          if (chosen.length >= cfg.max_loras) break
          const asked = (item as { name?: unknown } | null)?.name
          const lora =
            typeof asked === 'string'
              ? u.loras.find((l) => l.name.toLowerCase() === asked.trim().toLowerCase())
              : undefined
          if (!lora || chosen.some((c) => c.lora === lora)) continue
          const w = Number((item as { weight?: unknown }).weight)
          chosen.push({
            lora,
            weight: Number.isFinite(w) ? Math.min(1.5, Math.max(0.1, w)) : lora.weight,
          })
        }
      }

      const size = sizeFor(entry.params, orientationOf(plan.orientation))
      const style =
        typeof plan.style === 'string' && plan.style.trim() ? plan.style.trim() : entry.style
      const subject =
        typeof plan.subject === 'string' && plan.subject.trim()
          ? plan.subject.trim()
          : 'as the viewer asked'
      const writeNote =
        route === 'self'
          ? text('note_self_write', { description: r.description }) + '\n'
          : route === 'photo'
            ? text('note_photo_write') + '\n'
            : ''
      const write = text('plan_write', {
        request,
        notes: notesBlock(),
        write_note: writeNote,
        style,
        subject:
          route === 'self'
            ? `the streamer's own character (${r.description}); ${subject}`
            : subject,
        checkpoint: entry.name,
        guide: host.prompt('draw', `guide_${entry.guide}`) ?? text('guide_sdxl'),
        loras:
          chosen.map((c) => `- ${c.lora.name}: ${c.lora.desc || '(no description)'}`).join('\n') ||
          '(none)',
      })
      const words = await ask('draw-write', text('plan_write_system'), write, signal)
      const body0 = words && !words.refuse ? String(words.prompt ?? '').trim() : ''
      if (!words || (!words.refuse && body0 === ''))
        return { kind: 'refused', reason: 'writer_no_json' }
      if (words.refuse) return { kind: 'refused', reason: 'writer_refused' }

      let body = cleanPrompt(body0)
      for (const t of chosen.flatMap((c) => c.lora.trigger).reverse())
        if (!body.toLowerCase().includes(t.toLowerCase())) body = `${t}, ${body}`
      body = dropAmbiguous(body, request, cfg.ambiguous_tags)
      const hasQuality = QUALITY_WORDS.some((w) => body.toLowerCase().includes(w))
      const payload: GeneratePayload = {
        checkpoint: entry.name,
        prompt: [hasQuality ? '' : strip(entry.prefix), strip(body)].filter(Boolean).join(', '),
        negative_prompt: [strip(entry.negative), strip(cleanPrompt(String(words.negative ?? '')))]
          .filter(Boolean)
          .join(', '),
        width: size[0],
        height: size[1],
        steps: entry.params.steps,
        cfg_scale: entry.params.cfg_scale,
        sampler_name: entry.params.sampler_name,
        ...(entry.params.scheduler ? { scheduler: entry.params.scheduler } : {}),
        seed: -1,
        loras: chosen.map((c) => ({ name: c.lora.name, weight: c.weight })),
        route,
      }
      return { kind: 'ok', route, payload, self: route === 'self' }
    },
  }
}
