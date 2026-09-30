/**
 * Reading the pictures: which game this is, what is on screen, and the story so far. Each is one plain question to
 * the model (`host.llmText`) with the picture attached, answered as JSON or text that `answers.ts` reads; what comes
 * back goes into the memory, cleaned, and never anywhere else.
 */
import type { ChatPart } from '../../llm/types.ts'
import type { ModeHost } from '../host.ts'
import type { Alarms } from './alarms.ts'
import { parseAnalysis, parseIdentification, parseSummary } from './answers.ts'
import type { Identification } from './answers.ts'
import type { CapturedFrame } from './captureClient.ts'
import { MAX_PENDING, cleanNote, clip, firstLine, sameGame } from './memory.ts'
import { prompt } from './prompts.ts'
import type { CommentarySettings } from './settings.ts'
import type { MemoryStore } from './store.ts'

type IdentifyReason = 'first' | 'unsure' | 'switch' | 'timer' | 'manual'

/**
 * The answers are a line or two, but some providers count a model's thinking against the same limit, and an answer
 * that has no room left is empty. The limit is only a guard against a runaway reply, so it is generous.
 */
const ANSWER_TOKENS = 1024
const STORY_TOKENS = 2048

/** What a pass knows about the run it belongs to: whether it is still wanted, and how to cancel what it asked for. */
export interface Live {
  readonly signal: AbortSignal
  alive(): boolean
}

export interface Reader {
  /**
   * Before a comment: which game this is when that is due (first picture, not sure, a switch, every N minutes, on
   * demand), otherwise what is on screen now. Rejects when the model cannot be reached.
   */
  study(live: Live, frame: CapturedFrame): Promise<void>
  /** A comment was asked for: counts it, and renews the story when it is due (in the background). */
  finishRound(live: Live): void
  /** The next picture is used to identify the game again. */
  requestIdentification(): void
  /** The mode starts again: answers that could not be read before are forgotten. */
  begin(): void
  /** The memory was cleared: nothing that was read counts any more. */
  reset(): void
  /** The game is known with enough confidence. */
  sure(): boolean
}

export function createReader(d: {
  host: ModeHost
  cfg: CommentarySettings
  store: MemoryStore
  alarms: Alarms
  /** What the mode is doing, for the panel. */
  phase: (now: 'identifying' | 'analysing') => void
}): Reader {
  const { host, cfg, store, alarms } = d
  const mem = () => store.state
  let reidentify: 'manual' | 'switch' | null = null
  /** Comments since the screen was last read; starts high so the first pass reads it. */
  let sinceRead = Number.MAX_SAFE_INTEGER
  let unreadable = 0
  let summarizing = false

  const sure = () => mem().game !== '' && mem().confidence >= cfg.confidence_min

  const identifyReason = (): IdentifyReason | null => {
    if (reidentify) return reidentify
    if (mem().game === '') return 'first'
    if (mem().confidence < cfg.confidence_min) return 'unsure'
    if (
      cfg.reidentify_minutes > 0 &&
      host.now() - mem().identifiedAt > cfg.reidentify_minutes * 60_000
    )
      return 'timer'
    return null
  }

  /** Asks the model about the picture (attached to the question, never stored). Rejects when the model cannot be reached. */
  const ask = (live: Live, tag: string, text: string, frame: CapturedFrame) => {
    const user: ChatPart[] = [
      { type: 'text', text },
      { type: 'image', mime: frame.mime, base64: frame.base64 },
    ]
    return host.llmText({
      tag,
      user,
      temperature: 0.2,
      maxOutputTokens: ANSWER_TOKENS,
      timeoutMs: cfg.model_timeout_sec * 1000,
      signal: live.signal,
    })
  }

  const pushScene = (scene: string) => {
    const m = mem()
    if (scene === '' || m.pending.at(-1) === scene) return
    m.pending.push(scene)
    if (m.pending.length > MAX_PENDING) m.pending.splice(0, m.pending.length - MAX_PENDING)
  }

  const unreadableAnswer = (what: string, answer: string) => {
    unreadable++
    host.log(
      'warn',
      `commentary: the model's ${what} could not be read: ${clip(cleanNote(answer, 100), 80)}`
    )
    if (unreadable >= 3)
      alarms.raise(
        'commentary_analysis',
        'warn',
        `the model's answers about the screen could not be read ${unreadable} times in a row: the game memory is not being updated`
      )
  }

  const readable = () => {
    unreadable = 0
    alarms.clear('commentary_analysis')
  }

  const applyIdentification = (found: Identification, reason: IdentifyReason) => {
    const m = mem()
    const now = host.now()
    if (found.game !== '' && found.confidence >= cfg.confidence_min) {
      const first = m.game === ''
      const changed = !first && !sameGame(m.game, found.game)
      m.game = found.game
      m.confidence = found.confidence
      m.identifiedAt = now
      if (found.scene) m.scene = found.scene
      if (changed) {
        // another game: the story so far is about something else
        m.summary = ''
        m.pending = []
        m.sinceSummary = 0
        store.epoch++
      }
      pushScene(found.scene)
      reidentify = null
      if (first || changed)
        host.event('mode', `commentary: this is ${changed ? 'now ' : ''}"${found.game}"`)
    } else if (sure() && reason === 'timer') {
      // nothing better than what is known (a loading screen, say): keep it, and look again after the usual time
      m.identifiedAt = now
      if (found.scene) m.scene = found.scene
      pushScene(found.scene)
    } else {
      // not sure: the last sure game stays on record (to tell a return from a change), but nothing claims it now
      m.confidence = found.confidence
      m.identifiedAt = now
      if (found.scene) m.scene = found.scene
      pushScene(found.scene)
      reidentify = null
      host.event(
        'mode',
        `commentary: not sure which game this is (confidence ${found.confidence.toFixed(2)})`
      )
    }
    store.save()
  }

  const identify = async (live: Live, frame: CapturedFrame, reason: IdentifyReason) => {
    d.phase('identifying')
    const question = prompt(host, 'identify', { game: mem().game, language: cfg.language })
    const answer = await ask(live, 'commentary-identify', question, frame)
    if (!live.alive()) return
    const found = parseIdentification(answer)
    if (!found) return unreadableAnswer('identification', answer)
    readable()
    applyIdentification(found, reason)
  }

  const analyse = async (live: Live, frame: CapturedFrame) => {
    d.phase('analysing')
    const question = prompt(host, 'analyze', {
      game: mem().game,
      scene: mem().scene,
      language: cfg.language,
    })
    const answer = await ask(live, 'commentary-analyze', question, frame)
    if (!live.alive()) return
    const found = parseAnalysis(answer)
    if (!found) return unreadableAnswer('note on the screen', answer)
    readable()
    if (found.scene) {
      mem().scene = found.scene
      pushScene(found.scene)
      store.save()
    }
    if (found.switched) {
      host.event('mode', 'commentary: the picture looks like another game; identifying it again')
      reidentify = 'switch'
      await identify(live, frame, 'switch')
    }
  }

  /** Renews the story so far from the notes since the last one. In the background; a failure leaves the notes for the next try. */
  const summarize = async (live: Live) => {
    if (summarizing) return
    summarizing = true
    const epochThen = store.epoch
    const notes = [...mem().pending]
    try {
      const text = prompt(host, 'summarize', {
        game: mem().game || 'unknown',
        summary: mem().summary,
        scenes: notes.map((s, i) => `${i + 1}. ${s}`).join('\n'),
        language: cfg.language,
        limit: String(cfg.summary_max_chars),
      })
      const answer = await host.llmText({
        tag: 'commentary-summary',
        user: text,
        temperature: 0.3,
        maxOutputTokens: STORY_TOKENS,
        timeoutMs: cfg.model_timeout_sec * 1000,
        signal: live.signal,
      })
      // another game, or the operator cleared the memory, while the model was writing: the story is about something else
      if (epochThen !== store.epoch) return
      const summary = parseSummary(answer, cfg.summary_max_chars)
      if (!summary)
        return host.log('warn', 'commentary: the model gave no usable story; the notes are kept')
      const m = mem()
      m.summary = summary
      m.pending = m.pending.slice(notes.length)
      m.sinceSummary = 0
      store.save()
      host.event('mode', 'commentary: the story so far was renewed')
    } catch (e) {
      if (!live.signal.aborted)
        host.log('warn', `commentary: the story could not be renewed: ${firstLine(e)}`)
    } finally {
      summarizing = false
    }
  }

  return {
    sure,

    async study(live, frame) {
      const reason = identifyReason()
      if (reason) {
        await identify(live, frame, reason)
        sinceRead = 0
        return
      }
      if (cfg.analysis_every === 0 || sinceRead < cfg.analysis_every) return
      await analyse(live, frame)
      sinceRead = 0
    },

    finishRound(live) {
      const m = mem()
      m.rounds++
      m.sinceSummary++
      sinceRead++
      store.save()
      if (cfg.summary_every > 0 && m.sinceSummary >= cfg.summary_every && m.pending.length > 0)
        void summarize(live)
    },

    requestIdentification() {
      reidentify = 'manual'
    },

    begin() {
      unreadable = 0
    },

    reset() {
      reidentify = null
      sinceRead = Number.MAX_SAFE_INTEGER
    },
  }
}
