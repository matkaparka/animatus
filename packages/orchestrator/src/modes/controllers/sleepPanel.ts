/**
 * What the console shows of sleep mode: one status line, some facts, four buttons and the track list (with a Play and a
 * Skip button on each row), as data. Pure: the controller hands over a snapshot of its state. Everything is cut to the
 * limits of `ModePanel`, because a panel that breaks one of them is dropped whole and the operator would see nothing.
 */
import type { ModePanelInput, PanelActionInput, SleepState } from '@animatus/protocol'
import type { SleepIdle } from './sleep.ts'

/** A track as the panel needs it. */
export interface PanelTrack {
  key: string
  title: string
  durationS: number | null
  /** Caption lines. */
  lines: number
  /** With the dot. */
  ext: string
  notes: readonly string[]
}

export interface PanelState {
  running: boolean
  idle: SleepIdle | null
  /** Something is being whispered and the track is waiting. */
  replying: boolean
  /** What the stage last reported about the track it was sent. */
  phase: SleepState['phase'] | null
  /** A stage page is connected. */
  connected: boolean
  currentKey: string | null
  /** The keys of the tracks still to come in this round, in order. */
  upcoming: readonly string[]
  lastError: string | null
  tracks: readonly PanelTrack[]
  /** Files left out of the list, and why. */
  skipped: readonly { path: string; reason: string }[]
  /** The asmr folder, or null when `paths.asmr` is not set. */
  library: string | null
  /** Why the folder could not be read the last time. */
  problem: string | null
  volume: number
  whisper: { style: string; found: boolean }
  order: { shuffle: boolean; loop: boolean }
  /** The pacer's rules for answering chat in sleep mode (`inbox.sleep`). */
  replies: { enabled: boolean; firstAfterS: number; everyS: number }
  /** What the test-line button starts with. */
  testLine: string
}

/** The console shows at most this many rows in a list. */
export const MAX_ROWS = 100

export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s

const NOT_RUNNING = 'sleep mode is not running'

function statusLine(s: PanelState): string {
  if (!s.running)
    return s.tracks.length > 0
      ? `not running; ${s.tracks.length} track(s) ready`
      : 'not running; no tracks found yet'
  if (s.replying)
    return s.idle === null
      ? 'whispering; the track comes back afterwards'
      : 'whispering; there is no track to bring back'
  if (s.idle === 'empty') return 'no tracks: only whispered replies'
  if (s.idle === 'failed')
    return 'no track could be played (see the alarm): press Play on a track to try again'
  if (s.idle === 'finished') return 'the playlist has ended: only whispered replies'
  const index = s.tracks.findIndex((t) => t.key === s.currentKey)
  const track = s.tracks[index]
  const name = track?.title ?? s.currentKey
  if (name === null) return 'starting'
  if (!s.connected) return `waiting for the stage page to connect (then "${name}")`
  const place = `${index + 1} of ${s.tracks.length}`
  switch (s.phase) {
    case 'playing':
      return `playing "${name}" (${place})`
    case 'paused':
      return `"${name}" is paused`
    case 'ended':
      return `"${name}" has ended; starting the next`
    case 'off':
      return `the stage has stopped "${name}"`
    default:
      return `starting "${name}" (${place})`
  }
}

const detail = (t: PanelTrack): string =>
  [
    t.durationS !== null ? `${(t.durationS / 60).toFixed(1)} min` : null,
    t.lines > 0 ? `${t.lines} ${t.lines === 1 ? 'line' : 'lines'}` : 'no captions',
    t.ext.slice(1),
    ...t.notes,
  ]
    .filter((x) => x !== null)
    .join(', ')

export function sleepPanel(s: PanelState): ModePanelInput {
  const trackFact =
    s.library === null
      ? 'none: paths.asmr is not set'
      : s.tracks.length === 0
        ? `none found in ${s.library}`
        : `${s.tracks.length} in ${s.library}`
  const facts: { label: string; value: string }[] = [
    { label: 'Tracks', value: clip(trackFact, 200) },
    {
      label: 'Whisper voice',
      value: s.whisper.found
        ? `tts.styles.${s.whisper.style} is set`
        : clip(
            `tts.styles.${s.whisper.style} is MISSING: whispered lines use the normal voice`,
            200
          ),
    },
    { label: 'Volume', value: `${Math.round(s.volume * 100)} %` },
    {
      label: 'Chat replies',
      value: s.replies.enabled
        ? `a whisper, the first ${s.replies.firstAfterS} s after the start, then one every ${s.replies.everyS} s`
        : 'off (inbox.sleep.enabled is false)',
    },
    {
      label: 'Order',
      value: `${s.order.shuffle ? 'shuffled' : 'by name'}, ${s.order.loop ? 'repeating' : 'once through'}`,
    },
  ]
  if (s.problem) facts.push({ label: 'Folder', value: clip(s.problem, 200) })
  if (s.lastError) facts.push({ label: 'Last problem', value: clip(s.lastError, 200) })
  const left = s.skipped[0]
  if (left)
    facts.push({
      label: 'Left out',
      value: clip(`${s.skipped.length} file(s), for example ${left.path}: ${left.reason}`, 200),
    })

  const off = s.running ? undefined : NOT_RUNNING
  const actions: PanelActionInput[] = [
    {
      id: 'next',
      label: 'Next track',
      ...(off
        ? { disabled: off }
        : s.tracks.length === 0
          ? { disabled: 'there are no tracks' }
          : {}),
    },
    {
      id: 'volume',
      label: 'Set the volume',
      inputs: [
        {
          name: 'volume',
          label: 'Volume (0 to 1)',
          kind: 'number',
          min: 0,
          max: 1,
          step: 0.05,
          value: s.volume,
        },
      ],
    },
    {
      id: 'whisper_test',
      label: 'Whisper a test line',
      inputs: [{ name: 'text', label: 'Line', kind: 'text', value: clip(s.testLine, 200) }],
      ...(off
        ? { disabled: off }
        : s.replying
          ? { disabled: 'something is being whispered right now' }
          : {}),
    },
    {
      id: 'stop',
      label: 'Stop sleep mode',
      confirm: 'Stop sleep mode and go back to the normal stream?',
      ...(off ? { disabled: off } : {}),
    },
  ]

  // Skip: the track that is playing, or one that is still to come in this round
  const coming = new Set(s.upcoming)
  const skip = (t: PanelTrack): PanelActionInput => {
    const why = off
      ? off
      : s.idle !== null
        ? 'nothing is playing'
        : t.key === s.currentKey || coming.has(t.key)
          ? undefined
          : 'it is not coming up in this round'
    return { id: 'skip', label: 'Skip', inputs: [], ...(why ? { disabled: why } : {}) }
  }

  const shown = s.tracks.slice(0, MAX_ROWS)
  return {
    status: clip(statusLine(s), 300),
    facts,
    actions,
    sections: [
      {
        title:
          s.tracks.length > shown.length
            ? `Tracks (the first ${shown.length} of ${s.tracks.length})`
            : 'Tracks',
        empty: clip(
          s.library === null
            ? 'paths.asmr is not set: there is no folder to read tracks from.'
            : (s.problem ??
                'No audio files (mp3, ogg, m4a, flac, wav) were found in the asmr folder.'),
          200
        ),
        rows: shown.map((t) => ({
          id: t.key,
          text: clip(t.title, 300),
          detail: clip(detail(t), 300),
          active: t.key === s.currentKey,
          actions: [{ id: 'play', label: 'Play now', inputs: [] }, skip(t)],
        })),
      },
    ],
  }
}
