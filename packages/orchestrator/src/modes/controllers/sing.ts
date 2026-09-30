/**
 * Sing mode, ported from the legacy page's singing module.
 *
 * The queue belongs to the singing plugin (plugins/singing), not to this file: a viewer's `点歌 ...` is passed to the
 * service, and what it answers becomes a line for the model (`host.songLine`). A watcher looks at the queue; when a
 * song is ready and nothing else has the stage, it waits for the voice to be quiet, enters the mode, claims the song,
 * sends it to the stage (two tracks and the lyrics), holds the voice and the audience's queue for its length, tells
 * the service how it ended, and gives the model a closing line to say.
 *
 * What the mode never does: keep a second copy of the queue (what it shows is the last look at the service's), decide
 * anything about a song's files (the service says where they are, the stage fetches them), or leave a hold, a flag or an
 * overlay behind after an error, a stop or a shutdown.
 *
 * Phases: idle -> pending (a song is ready, waiting for the voice) -> loading (the stage has the command) -> playing ->
 * ending (leaving the mode) -> after (the closing line is being said) -> idle.
 */
import { randomUUID } from 'node:crypto'
import type { ModePanelInput, PanelActionInput } from '@animatus/protocol'
import { FORMATS } from '../../inbox/formats.ts'
import type { SongCommand } from '../../inbox/types.ts'
import type { ModeControllerFull, ModeHost } from '../host.ts'
import type { ModeContext } from '../manager.ts'
import { SongServiceClient, SongServiceError } from '../singing/client.ts'
import { SingSettings } from '../singing/settings.ts'
import {
  artistsText,
  clip,
  clock,
  safeArtists,
  safeText,
  samePath,
  stateText,
} from '../singing/text.ts'
import type { ClaimResult, Outcome, QueueItem, QueueView } from '../singing/types.ts'

export { SingSettings }

/** The service name of the singing plugin (`service:` in its manifest). */
const SERVICE = 'singing'
type Rows = NonNullable<NonNullable<ModePanelInput['sections']>[number]['rows']>

type Phase = 'idle' | 'pending' | 'loading' | 'playing' | 'ending' | 'after'

interface Playing {
  qid: number
  songId: string
  /** What the stage calls this play: a song can be sung again later. */
  playId: string
  title: string
  artists: string[]
  requester: string
  /** Seconds; how long to wait for the stage before giving up on the end of the song. */
  duration: number
}

interface StageSong {
  song_id: string
  phase: string
  reason?: string
  error?: string
}

export interface SingStatus {
  phase: Phase
  current: string | null
  paused: boolean
  /** null until the service has been looked at once. */
  serviceUp: boolean | null
}

const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createSingController(
  host: ModeHost
): ModeControllerFull & { status(): SingStatus } {
  const cfg = SingSettings.parse(host.config.modes.sing?.config ?? {})
  const client = new SongServiceClient({
    baseUrl: () => host.serviceUrl(SERVICE),
    callTimeoutMs: cfg.call_timeout_sec * 1000,
  })

  let phase: Phase = 'idle'
  let playing: Playing | null = null
  /** Bumped whenever a start in progress is withdrawn (a stop, a shutdown): old continuations look at it. */
  let token = 0
  /** The operator stopped singing: songs stay queued and nothing starts until they say so. */
  let paused = false
  let view: QueueView | null = null
  let serviceUp: boolean | null = null
  let downSince = 0
  let firstLook = true
  let lastRefusal = ''
  let retryAt = 0
  let stopped = true
  /** How the song that is being sung will be reported to the service. */
  let endReason: Outcome = 'interrupted'
  /** A viewer or the operator asked for the song to be cut while it was still loading: done when it plays. */
  let stopRequested: 'skipped' | null = null
  let nothingToSing = false
  const announced = new Set<number>()
  let waiters: ((s: StageSong) => void)[] = []
  let pollTimer: NodeJS.Timeout | null = null
  let watchdog: NodeJS.Timeout | null = null
  let stopTimer: NodeJS.Timeout | null = null
  let outroTimer: NodeJS.Timeout | null = null

  // ─────────────────────────────── helpers ───────────────────────────────

  const event = (text: string, untrusted = false) =>
    host.event('mode', text, untrusted ? 'untrusted' : undefined)

  /** Awaits a call whose failure must not matter to the caller (reporting an end, taking a request back). */
  async function settle<T>(promise: Promise<T>, what: string): Promise<T | undefined> {
    try {
      return await promise
    } catch (e) {
      host.log('warn', `sing: ${what} failed: ${failure(e)}`)
      return undefined
    }
  }

  function clearTimers(): void {
    for (const t of [watchdog, stopTimer, outroTimer]) if (t) clearTimeout(t)
    watchdog = stopTimer = outroTimer = null
  }

  /** Back to nothing going on: no flag, no timer, no song. The queue in the service is untouched. */
  function idle(): void {
    phase = 'idle'
    playing = null
    endReason = 'interrupted'
    stopRequested = null
    host.flags.singing = false
    clearTimers()
  }

  /** Wait for the stage to report a state of this play that `want` accepts, for at most `ms`. */
  const waitStage = (want: (s: StageSong) => boolean, ms: number, signal: AbortSignal) =>
    new Promise<StageSong>((resolve, reject) => {
      const finish = (err?: Error, s?: StageSong) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters = waiters.filter((w) => w !== waiter)
        if (err) reject(err)
        else resolve(s as StageSong)
      }
      const timer = setTimeout(() => finish(new Error('the stage did not answer in time')), ms)
      const onAbort = () => finish(new Error('aborted'))
      const waiter = (s: StageSong) => {
        if (want(s)) finish(undefined, s)
      }
      waiters.push(waiter)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })

  // ─────────────────────────────── what viewers see and hear of a song ───────────────────────────────

  /** The credit line of the song: its parts come from pack files (so the operator can change the words). */
  function creditText(p: Playing): string {
    const parts = [
      host.prompt('sing', 'credit_title', { title: p.title }),
      p.artists.length > 0
        ? host.prompt('sing', 'credit_artists', { artists: artistsText(p.artists) })
        : null,
      p.requester ? host.prompt('sing', 'credit_requester', { name: p.requester }) : null,
    ]
    return parts.filter((x): x is string => !!x).join('  ')
  }

  function showOverlays(p: Playing): void {
    if (cfg.lyrics) host.hub.setOverlay({ type: 'overlay.set', id: 'lyrics', visible: true })
    if (cfg.credit)
      host.hub.setOverlay({ type: 'overlay.set', id: 'credit', visible: true, text: creditText(p) })
  }

  /** Overlays are snapshots the stage gets again when it reconnects: they must not outlive the song. */
  function hideOverlays(): void {
    host.hub.setOverlay({ type: 'overlay.set', id: 'lyrics', visible: false })
    host.hub.setOverlay({ type: 'overlay.set', id: 'credit', visible: false, text: '' })
  }

  const who = (p: Playing) => (p.requester ? ` (requested by ${p.requester})` : '')

  // ─────────────────────────────── the audience's commands ───────────────────────────────

  /** Who a song belongs to as far as the limits go: the platform id, or the name for a guest without one. */
  const identity = (cmd: { uid: number; name: string }) =>
    cmd.uid > 0 ? String(cmd.uid) : `name:${cmd.name}`

  async function handleRequest(cmd: Extract<SongCommand, { kind: 'request' }>): Promise<void> {
    const requestId = randomUUID()
    const asker = safeText(cmd.name, 40)
    const keyword = safeText(cmd.keyword, 60)
    try {
      const r = await client.request({
        requestId,
        keyword: cmd.keyword,
        uid: identity(cmd),
        name: cmd.name,
        waitSec: cfg.request_timeout_sec,
        slackSec: cfg.request_slack_sec,
      })
      if (r.status === 'queued') {
        const title = safeText(r.song.title)
        host.songLine(
          FORMATS.songQueued(asker, title, safeArtists(r.song.artists), r.position, r.cached)
        )
        event(
          `song "${title}" queued for ${asker}${r.duplicate ? ' (repeat of an earlier call)' : ''}`,
          true
        )
      } else {
        host.songLine(FORMATS.songFailed(asker, keyword, safeText(r.reason, 200)))
        event(`song request from ${asker} refused (${r.code}): ${keyword}`, true)
      }
    } catch (e) {
      // The caller has given up: the service must not queue the song afterwards, whatever it is still doing.
      void settle(client.abandon(requestId), 'taking the request back')
      if (e instanceof SongServiceError && e.kind === 'http' && e.code !== 'internal') {
        host.songLine(FORMATS.songFailed(asker, keyword, safeText(e.message, 200)))
      } else {
        host.songLine(FORMATS.songUnavailable(asker, keyword))
      }
      event(`song request from ${asker} could not be taken: ${failure(e)}`, true)
    }
  }

  async function handleCancel(cmd: Extract<SongCommand, { kind: 'cancel' }>): Promise<void> {
    const asker = safeText(cmd.name, 40)
    try {
      const r = await client.cancel(
        cmd.position !== undefined ? { position: cmd.position } : { uid: identity(cmd) }
      )
      if (!r.ok || !r.item) {
        event(`${asker} cancelled: nothing to cancel (${r.reason ?? r.code ?? 'no reason'})`, true)
        return
      }
      const title = safeText(r.item.title)
      if (cmd.position !== undefined) host.songLine(FORMATS.songRemoved(asker, title))
      else if (r.was_playing) {
        host.songLine(FORMATS.songCancelledWhilePlaying(asker, title))
        requestStop()
      } else host.songLine(FORMATS.songCancelled(asker, title))
      event(`${asker} cancelled "${title}"`, true)
    } catch (e) {
      host.songLine(FORMATS.songUnavailable(asker, '取消点歌'))
      event(`cancel from ${asker} could not be done: ${failure(e)}`, true)
    }
  }

  async function handleSkip(cmd: Extract<SongCommand, { kind: 'skip' }>): Promise<void> {
    const asker = safeText(cmd.name, 40)
    if (requestStop()) {
      event(`${asker} skipped the song`, true)
      return
    }
    // nothing is being sung here; if the service still thinks something is (a lease left behind), clear it
    void settle(client.skip(), 'clearing a song nobody is singing')
    event(`${asker} asked to skip, but no song is being sung`, true)
  }

  async function handleList(cmd: Extract<SongCommand, { kind: 'list' }>): Promise<void> {
    const asker = safeText(cmd.name, 40)
    try {
      const q = await client.queue()
      const now = playing ? playing.title : (q.current?.title ?? null)
      host.songLine(
        FORMATS.songList(
          asker,
          FORMATS.songListBody(
            now === null ? null : safeText(now),
            q.items.map((i) => ({
              title: safeText(i.title),
              requester: safeText(i.requester_name, 40),
              ready: i.state === 'ready',
            }))
          )
        )
      )
    } catch (e) {
      host.songLine(FORMATS.songUnavailable(asker, '歌单'))
      event(`the song list could not be read: ${failure(e)}`)
    }
  }

  // ─────────────────────────────── looking at the queue ───────────────────────────────

  function checkFolders(q: QueueView): void {
    const served = host.libraryDir('songs')
    if (!served) {
      host.alarm(
        'sing_songs_dir',
        'error',
        'paths.songs is not set: the stage has nowhere to fetch songs from',
        'sing'
      )
    } else if (!samePath(served, q.songs_dir)) {
      host.alarm(
        'sing_songs_dir',
        'error',
        `the singing service keeps songs in ${q.songs_dir} but the stage is served ${served}: plugins.singing.config.songs_dir and paths.songs must be the same folder`,
        'sing'
      )
    } else host.clearAlarm('sing_songs_dir', 'sing')
  }

  function announceFailures(q: QueueView): void {
    for (const item of q.failed) {
      if (announced.has(item.qid)) continue
      announced.add(item.qid)
      // what was already failed when this program started (or failed to sound on the stage) is not news to viewers
      if (firstLook || !cfg.announce_failures || item.code === 'playback_failed') continue
      host.songLine(
        FORMATS.songFailed(
          safeText(item.requester_name, 40),
          safeText(item.title, 60),
          safeText(item.reason ?? 'the song could not be prepared', 200)
        )
      )
      event(
        `the song "${safeText(item.title)}" for ${safeText(item.requester_name, 40)} failed: ${item.reason ?? item.code ?? ''}`,
        true
      )
    }
    if (announced.size > 300)
      for (const id of [...announced].slice(0, announced.size - 200)) announced.delete(id)
  }

  function checkSource(q: QueueView): void {
    const halted = q.source.halted
    if (halted)
      host.alarm(
        'sing_source',
        'warn',
        `the song source is stopped${halted.reason ? ` (${halted.reason})` : ''}: no new song can be fetched until you resume it on the Modes page`,
        'sing'
      )
    else host.clearAlarm('sing_source', 'sing')
  }

  async function poll(): Promise<void> {
    let q: QueueView
    try {
      q = await client.queue()
    } catch (e) {
      if (serviceUp !== false) downSince = host.now()
      serviceUp = false // the last look stays what the panel shows, and `serviceUp` marks it as stale
      if (host.now() - downSince >= cfg.service_alarm_after_sec * 1000)
        host.alarm(
          'sing_service',
          'warn',
          `the singing service cannot be reached (${failure(e)}): song requests get "the song system is off" until it is back; check plugins.singing`,
          'sing'
        )
      return
    }
    serviceUp = true
    host.clearAlarm('sing_service', 'sing')
    view = q
    checkFolders(q)
    checkSource(q)
    announceFailures(q)
    if (firstLook) {
      firstLook = false
      // a song the service still lists as being sung, while this program has just started, was cut off by the
      // restart: the stage lost it with the connection
      if (q.current && phase === 'idle')
        void settle(
          client.done({
            qid: q.current.qid,
            outcome: 'interrupted',
            reason: 'the program restarted',
          }),
          'closing a song left over from before'
        )
    }
    maybeStart(q)
  }

  function maybeStart(q: QueueView): void {
    if (stopped || paused || phase !== 'idle') return
    if (host.hub.connected === false) return // no stage to sing on
    if (host.now() < retryAt) return
    if (!q.items.some((i) => i.state === 'ready')) return
    void startSong()
      .then((r) => {
        if (!r.ok && r.reason && r.reason !== lastRefusal) {
          lastRefusal = r.reason
          event(`a song is ready but singing could not start: ${r.reason}`)
        }
      })
      .catch((e) => host.log('warn', `sing: starting a song failed: ${failure(e)}`))
  }

  function schedule(ms: number): void {
    if (stopped) return
    pollTimer = setTimeout(() => void tick(), ms)
    pollTimer.unref?.()
  }

  async function tick(): Promise<void> {
    pollTimer = null
    if (stopped) return
    try {
      await poll()
    } catch (e) {
      host.log('warn', `sing: looking at the queue failed: ${failure(e)}`)
    }
    schedule(cfg.poll_sec * 1000)
  }

  // ─────────────────────────────── starting a song ───────────────────────────────

  /**
   * From "a song is ready" to "it is on the stage". The voice is waited for first (the reply that is being said is
   * not cut off by a song), then the mode is entered, which claims and sends the song. A refusal (a dance is on) or a
   * failure is not tried again for `retry_after_sec`, so the audience's queue is not held over and over.
   */
  async function startSong(
    opts: { replace?: boolean; force?: boolean } = {}
  ): Promise<{ ok: boolean; reason?: string }> {
    if (phase !== 'idle') return { ok: false, reason: 'a song is already being started or sung' }
    const mine = ++token
    phase = 'pending'
    try {
      const quiet = await host.whenQuiet(cfg.quiet_timeout_sec * 1000)
      if (mine !== token || phase !== 'pending') return { ok: false, reason: 'withdrawn' }
      if (!quiet) {
        idle()
        return { ok: false, reason: 'the voice stayed busy' }
      }
      host.flags.singing = true // from here the audience's messages wait
      const r = await host.enterMode('sing', {
        ...(opts.replace ? { replace: true } : {}),
        ...(opts.force ? { force: true } : {}),
      })
      if (mine !== token) return { ok: false, reason: 'withdrawn' }
      if (!r.ok) {
        idle()
        retryAt = host.now() + cfg.retry_after_sec * 1000
        return { ok: false, reason: r.reason ?? 'the mode could not be entered' }
      }
      lastRefusal = ''
      if (nothingToSing) {
        // the entry was taken off the queue between the look and the claim: not a failure, but not to be repeated at once
        nothingToSing = false
        retryAt = host.now() + cfg.retry_after_sec * 1000
        await host.exitMode('sing', 'nothing to sing')
        return { ok: false, reason: 'no song was ready any more' }
      }
      return { ok: true }
    } catch (e) {
      if (mine === token && (phase === 'pending' || phase === 'idle')) idle()
      return { ok: false, reason: failure(e) }
    }
  }

  // ─────────────────────────────── the stage's reports ───────────────────────────────

  function armWatchdog(p: Playing): void {
    const length = p.duration > 0 ? p.duration : cfg.max_song_sec
    const ms = (length + cfg.start_delay_s + cfg.watchdog_extra_sec) * 1000
    watchdog = setTimeout(() => {
      watchdog = null
      if (phase !== 'playing') return
      host.alarm(
        'sing_failed',
        'warn',
        `the stage did not report the end of "${p.title}" (${clock(length)} long): the song was given up on`,
        'sing'
      )
      host.hub.send({ type: 'sing.stop', fade_s: cfg.stop_fade_s })
      endReason = 'interrupted'
      phase = 'ending'
      leave('the stage did not report the end')
    }, ms)
    watchdog.unref?.()
  }

  /** Leaves the mode (the mode manager runs `exit`); a failure to do so is logged, never thrown into a timer. */
  function leave(reason: string): void {
    host
      .exitMode('sing', reason)
      .catch((e) => host.log('warn', `sing: could not leave the mode: ${failure(e)}`))
  }

  /** The stage says the song is over (`done`, or `stopped` after our command, or an error). */
  function stageEnded(m: StageSong): void {
    if (watchdog) clearTimeout(watchdog)
    if (stopTimer) clearTimeout(stopTimer)
    watchdog = stopTimer = null
    if (m.reason === 'done') endReason = 'done'
    else if (endReason !== 'skipped' && endReason !== 'stopped') endReason = 'interrupted'
    if (m.reason === 'error' && playing)
      host.alarm(
        'sing_failed',
        'warn',
        `the stage stopped "${playing.title}" with an error: ${m.error ?? 'no details'}`,
        'sing'
      )
    // Moving to 'ending' first is what tells `exit` this was not a cut from outside.
    phase = 'ending'
    leave(m.reason ?? 'finished')
  }

  /** Cuts the song that is being sung (a viewer's skip, the person's own cancel, the operator's button). */
  function requestStop(): boolean {
    if (phase === 'loading') {
      stopRequested = 'skipped'
      return true
    }
    if (phase !== 'playing') return false
    endReason = 'skipped'
    host.hub.send({ type: 'sing.stop', fade_s: cfg.stop_fade_s })
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = setTimeout(
      () => {
        stopTimer = null
        if (phase !== 'playing') return
        host.log('warn', 'sing: the stage did not finish stopping the song in time')
        phase = 'ending'
        leave('the stage did not stop in time')
      },
      (cfg.stop_fade_s + cfg.stop_timeout_sec) * 1000
    )
    stopTimer.unref?.()
    return true
  }

  // ─────────────────────────────── the panel ───────────────────────────────

  function panelStatus(): string {
    if (serviceUp === false) return 'the singing service cannot be reached'
    switch (phase) {
      case 'pending':
        return 'a song is ready: waiting for the voice to finish'
      case 'loading':
        return `loading "${playing?.title ?? ''}" on the stage`
      case 'playing':
        return `singing "${playing?.title ?? ''}"${playing?.requester ? ` (asked by ${playing.requester})` : ''}`
      case 'ending':
        return 'the song is over'
      case 'after':
        return 'finished: the closing line is being said'
      case 'idle':
        break
    }
    const waiting = view?.items.length ?? 0
    if (paused) return `paused by the operator: ${waiting} song(s) wait`
    if (lastRefusal && view?.items.some((i) => i.state === 'ready'))
      return `a song is ready: ${lastRefusal}`
    return waiting > 0 ? `${waiting} song(s) in the queue` : 'ready: nobody has asked for a song'
  }

  function queueRows(): Rows {
    const rows: Rows = []
    const skip: PanelActionInput = { id: 'skip', label: 'Skip', inputs: [] }
    if (playing) {
      rows.push({
        id: String(playing.qid),
        text: clip(
          `♪ ${playing.title}${playing.artists.length ? ` - ${artistsText(playing.artists)}` : ''}`,
          300
        ),
        detail: clip(
          `${playing.requester ? `asked by ${playing.requester}, ` : ''}${phase === 'loading' ? 'loading' : 'being sung'}`,
          300
        ),
        active: true,
        actions: [skip],
      })
    }
    for (const it of view?.items ?? []) {
      rows.push({
        id: String(it.qid),
        text: clip(`${it.title}${it.artists.length ? ` - ${artistsText(it.artists)}` : ''}`, 300),
        detail: clip(
          `${it.requester_name || 'someone'}: ${stateText(it)}${it.warnings.length ? ` (${it.warnings[0]})` : ''}`,
          300
        ),
        active: false,
        actions: [{ id: 'remove', label: 'Remove', inputs: [] }],
      })
    }
    return rows.slice(0, 100)
  }

  // ─────────────────────────────── the mode ───────────────────────────────

  return {
    status: () => ({ phase, current: playing?.title ?? null, paused, serviceUp }),

    attach() {
      stopped = false
      const onState = (m: StageSong & { type?: string }) => {
        if (!playing || m.song_id !== playing.playId) return
        for (const w of [...waiters]) w(m)
        if (m.phase === 'idle' && phase === 'playing') stageEnded(m)
      }
      const onDisconnected = () => {
        if (!playing || (phase !== 'loading' && phase !== 'playing')) return
        // a page that went away took the song with it (its audio stops with the connection)
        onState({
          song_id: playing.playId,
          phase: 'idle',
          reason: 'error',
          error: 'the stage disconnected',
        })
      }
      host.hub.on('sing.state', onState)
      host.hub.on('disconnected', onDisconnected)
      schedule(0)
      return () => {
        stopped = true
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = null
        host.hub.off('sing.state', onState)
        host.hub.off('disconnected', onDisconnected)
        // a song still waiting for the voice must not start after shutdown
        token++
        if (phase === 'pending') idle()
        if (outroTimer) clearTimeout(outroTimer)
      }
    },

    async enter(ctx: ModeContext) {
      if (phase !== 'pending' && phase !== 'idle') throw new Error('a song is already being sung')
      phase = 'loading'
      nothingToSing = false
      endReason = 'interrupted'
      stopRequested = null
      host.flags.singing = true
      host.holdSpeech('sing', true)
      let claimAsked = false
      let sent = false
      try {
        claimAsked = true
        const claim: ClaimResult = await client.claim(randomUUID(), ctx.signal)
        claimAsked = false
        if (!claim.item || !claim.files) {
          nothingToSing = true
          host.holdSpeech('sing', false)
          idle()
          return
        }
        const item: QueueItem = claim.item
        const p: Playing = {
          qid: item.qid,
          songId: item.song_id,
          playId: `${item.song_id}-${item.qid}`.slice(0, 96),
          title: safeText(item.title, 200),
          artists: safeArtists(item.artists).slice(0, 16),
          requester: safeText(item.requester_name, 100),
          duration: claim.duration > 0 ? claim.duration : item.duration,
        }
        playing = p
        if (ctx.signal.aborted) throw new Error('aborted')
        // the stage fetches from the songs library; a name that could not be served is a failure of this song
        const vocals = host.assetUrl('songs', claim.files.dir, claim.files.vocals)
        const inst = host.assetUrl('songs', claim.files.dir, claim.files.inst)
        showOverlays(p)
        const started = waitStage(
          (s) => s.phase === 'playing' || s.phase === 'idle',
          cfg.start_timeout_sec * 1000,
          ctx.signal
        )
        started.catch(() => undefined) // if sending throws below, nobody awaits it
        sent = true
        const delivered = host.hub.send({
          type: 'sing.play',
          song_id: p.playId,
          title: p.title,
          artists: p.artists.map((a) => a.slice(0, 100)),
          requester: p.requester,
          vocals_url: vocals,
          inst_url: inst,
          lyrics: claim.lyrics,
          start_delay_s: cfg.start_delay_s,
        })
        if (delivered === false) throw new Error('the stage is not connected')
        const s = await started
        if (s.phase === 'idle')
          throw new Error(
            s.error ?? `the stage ended the song at once (${s.reason ?? 'no reason'})`
          )
      } catch (e) {
        // Stopped from outside while it was starting is not a failure worth an alarm, and the song goes back.
        const aborted = ctx.signal.aborted
        const p = playing
        clearTimers()
        if (sent) host.hub.send({ type: 'sing.stop', fade_s: 0.2 })
        hideOverlays()
        host.holdSpeech('sing', false)
        if (p) {
          await settle(
            client.done({
              qid: p.qid,
              outcome: aborted ? 'released' : 'failed',
              reason: failure(e),
            }),
            'giving the song back'
          )
        } else if (claimAsked) {
          // the answer to the claim never arrived: whatever it did take, it is given back
          await settle(
            client.done({ outcome: 'released', reason: 'the start was cancelled' }),
            'giving the song back'
          )
        }
        if (!aborted) {
          host.alarm(
            'sing_failed',
            'warn',
            `${p ? `"${p.title}"` : 'a song'} could not be sung: ${failure(e)}`,
            'sing'
          )
          retryAt = host.now() + cfg.retry_after_sec * 1000
        }
        idle()
        throw e
      }
      host.clearAlarm('sing_failed', 'sing')
      phase = 'playing'
      const p = playing as Playing
      armWatchdog(p)
      event(`singing "${p.title}"${p.requester ? ` for ${p.requester}` : ''}`)
      if (stopRequested) requestStop()
    },

    async exit(_ctx: ModeContext, reason: string) {
      const p = playing
      const live = phase === 'playing' || phase === 'loading'
      clearTimers()
      if (live) {
        // cut short from outside (the console, another mode, a shutdown): the stage fades it out
        host.hub.send({ type: 'sing.stop', fade_s: cfg.stop_fade_s })
        if (endReason !== 'skipped') endReason = reason === 'console' ? 'stopped' : 'interrupted'
      }
      // The Modes page's Exit button calls this directly (not `stop` below): the operator ended it, so singing stays off.
      if (reason === 'console') paused = true
      phase = 'ending'
      host.holdSpeech('sing', false)
      hideOverlays()
      const outcome = endReason
      playing = null
      if (p) {
        await settle(
          client.done({ qid: p.qid, outcome, ...(reason !== outcome ? { reason } : {}) }),
          'reporting the end of the song'
        )
        event(`sing "${p.title}" over (${reason})`)
      }
      if (!cfg.outro || !p || (outcome !== 'done' && outcome !== 'skipped')) return idle()

      // the closing line: tell the model, and keep the audience's queue closed until it starts answering
      phase = 'after'
      const text =
        host.prompt('sing', outcome === 'done' ? 'outro' : 'outro_skipped', {
          title: p.title,
          who: who(p),
        }) ??
        `【系统】You have just ${outcome === 'done' ? 'finished' : 'been cut off while'} singing "${p.title}"${who(p)}. Say one line about it in character.`
      void host
        .tellBrain(text)
        .catch((e) => host.log('warn', `sing: could not tell the model: ${failure(e)}`))
      const until = host.now() + cfg.outro_window_sec * 1000
      const release = () => {
        if (phase !== 'after') return
        if (host.brainBusy() || host.now() >= until) return idle()
        outroTimer = setTimeout(release, 200)
      }
      outroTimer = setTimeout(release, 200)
    },

    advertise() {
      return { prompt: 'available' }
    },

    promptVars() {
      return { title: playing?.title ?? '' }
    },

    async onSongCommand(cmd: SongCommand) {
      switch (cmd.kind) {
        case 'request':
          await handleRequest(cmd)
          return true
        case 'cancel':
          await handleCancel(cmd)
          return true
        case 'skip':
          await handleSkip(cmd)
          return true
        case 'list':
          await handleList(cmd)
          return true
      }
    },

    panel(): ModePanelInput {
      const running = phase === 'pending' || phase === 'loading' || phase === 'playing'
      const halted = view?.source.halted
      const facts: { label: string; value: string }[] = [
        {
          label: 'Singing service',
          value:
            serviceUp === null ? 'not looked at yet' : serviceUp ? 'reachable' : 'not reachable',
        },
      ]
      if (view) {
        facts.push(
          { label: 'Song source', value: `${view.source.kind}${halted ? ' (stopped)' : ''}` },
          {
            label: 'Queue',
            value: `${view.items.length} waiting, ${view.items.filter((i) => i.state === 'ready').length} ready (limit ${view.limits.max_len}, ${view.limits.max_per_user} each)`,
          },
          {
            label: 'Preparing',
            value:
              view.worker.state === 'working'
                ? clip(
                    `${view.worker.title ?? 'a song'}${view.worker.step ? ` (${view.worker.step})` : ''}`,
                    200
                  )
                : 'nothing',
          },
          { label: 'Songs folder', value: clip(view.songs_dir, 200) }
        )
      }
      if (paused) facts.push({ label: 'Singing', value: 'paused by the operator' })
      const actions: PanelActionInput[] = [
        {
          id: 'stop',
          label: 'Stop singing',
          confirm: 'Stop the song now? The queue is kept, and nothing is sung until you resume.',
          ...(running ? {} : { disabled: 'no song is being sung' }),
        },
        paused
          ? { id: 'resume', label: 'Resume singing' }
          : { id: 'pause', label: 'Pause singing' },
        {
          id: 'resume_source',
          label: 'Resume the song source',
          confirm:
            'Lift the stop the song source put itself under? Only do this when the cause has been dealt with.',
          ...(halted ? {} : { disabled: 'the song source is not stopped' }),
        },
      ]
      return {
        status: clip(panelStatus(), 300),
        facts,
        actions,
        sections: [
          {
            title: 'Queue',
            empty: 'Nobody has asked for a song. Viewers send "点歌 <song name>".',
            rows: queueRows(),
          },
          ...(view && view.failed.length > 0
            ? [
                {
                  title: 'Failed lately',
                  rows: view.failed.slice(0, 20).map((it) => ({
                    id: String(it.qid),
                    text: clip(it.title, 300),
                    detail: clip(
                      `${it.requester_name || 'someone'}: ${it.error ?? it.reason ?? it.code ?? 'failed'}`,
                      300
                    ),
                    active: false,
                    actions: [],
                  })),
                },
              ]
            : []),
        ],
      }
    },

    async onConsoleRequest(req) {
      const action = typeof req.action === 'string' ? req.action : 'play'
      switch (action) {
        case 'stop': {
          if (phase !== 'pending' && phase !== 'loading' && phase !== 'playing')
            return { ok: false, reason: 'no song is being sung' }
          paused = true
          if (phase === 'pending') {
            token++ // the song that is still waiting for the voice is withdrawn
            idle()
            event('the song waiting for the voice was withdrawn from the console')
          } else await host.exitMode('sing', 'console') // which also pauses
          return { ok: true }
        }
        case 'skip':
          return requestStop() ? { ok: true } : { ok: false, reason: 'no song is being sung' }
        case 'pause':
          paused = true
          return { ok: true }
        case 'resume':
          paused = false
          retryAt = 0
          return { ok: true }
        case 'resume_source': {
          try {
            await client.resumeSource()
            return { ok: true }
          } catch (e) {
            return { ok: false, reason: failure(e) }
          }
        }
        case 'remove': {
          const qid = Number(typeof req.row === 'string' ? req.row : req.qid)
          if (!Number.isInteger(qid)) return { ok: false, reason: 'which entry?' }
          try {
            const r = await client.remove(qid)
            return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? r.code ?? 'not removed' }
          } catch (e) {
            return { ok: false, reason: failure(e) }
          }
        }
        default: {
          // a ready song is sung now, whether or not singing was paused
          if (phase !== 'idle')
            return { ok: false, reason: 'a song is already being started or sung' }
          let q: QueueView
          try {
            q = await client.queue()
          } catch (e) {
            return { ok: false, reason: failure(e) }
          }
          if (!q.items.some((i) => i.state === 'ready'))
            return { ok: false, reason: 'no song is ready' }
          paused = false
          retryAt = 0
          void startSong({ replace: req.replace === true, force: req.force === true }).then((r) => {
            if (!r.ok && r.reason && r.reason !== 'withdrawn')
              event(`singing could not start from the console: ${r.reason}`)
          })
          return { ok: true }
        }
      }
    },
  }
}
