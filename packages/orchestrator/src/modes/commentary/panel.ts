/**
 * What the console shows for the commentary mode, as data (`ModePanel`). Every string is cut to the length the
 * schema allows: a panel that breaks the schema is dropped whole by the mode service, and a window title can be
 * anything.
 */
import type { ModePanelInput, PanelActionInput } from '@animatus/protocol'
import type { WindowInfo } from './captureClient.ts'
import { clip } from './memory.ts'
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './settings.ts'

export interface PanelView {
  running: boolean
  paused: boolean
  /** One line: what it is doing now, or what is wrong. */
  status: string
  serviceUp: boolean
  /** The window it watches, described; null when none is chosen. */
  target: string | null
  /** The id of that window when it is known, so the list can mark it. */
  targetId: string | null
  intervalSec: number
  game: string
  confidence: number
  /** The game is known with enough confidence. */
  sure: boolean
  identifiedAgo: string | null
  scene: string
  summary: string
  rounds: number
  /** Comments until the story is renewed; null when there is no story. */
  untilSummary: number | null
  blackFrames: number
  lastCapture: string | null
  lastTest: string | null
  windows: readonly WindowInfo[]
  /** Why the list may be missing or old. */
  windowsNote: string | null
}

const SERVICE_DOWN =
  'the capture service is not running (it starts with the mode, or start it on the Plugins page)'
/** The picker offers this many windows; a desktop with more is not one anybody picks from. */
const MAX_WINDOWS = 40

const fact = (label: string, value: string) => ({ label: clip(label, 60), value: clip(value, 200) })

/** "12 s ago", "3 min ago", "2 h ago". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

export function describeWindow(
  w: Pick<WindowInfo, 'title' | 'process' | 'width' | 'height'>
): string {
  return `${w.title || '(no title)'} (${w.process || 'unknown program'}, ${w.width}x${w.height})`
}

function gameFact(v: PanelView): string {
  const conf = v.confidence.toFixed(2)
  const when = v.identifiedAgo ? `, ${v.identifiedAgo}` : ''
  if (v.game === '')
    return v.confidence > 0 ? `not sure yet (confidence ${conf})` : 'not identified yet'
  return v.sure
    ? `${v.game} (confidence ${conf}${when})`
    : `not sure (confidence ${conf}); last sure: ${v.game}`
}

export function buildPanel(v: PanelView): ModePanelInput {
  const windows = v.windows.slice(0, MAX_WINDOWS)
  const noService = v.serviceUp ? {} : { disabled: SERVICE_DOWN }
  const actions: PanelActionInput[] = [
    {
      id: 'use_window',
      label: 'Watch a window',
      inputs: [
        {
          name: 'window',
          label: 'Window',
          kind: 'select',
          value: v.targetId !== null && windows.some((w) => w.id === v.targetId) ? v.targetId : '',
          options: [
            {
              value: '',
              label: windows.length > 0 ? '(choose a window)' : '(no list: type a title)',
            },
            ...windows.map((w) => ({ value: w.id, label: clip(describeWindow(w), 100) })),
          ],
        },
        {
          name: 'title',
          label: 'Or part of a title, or exe:name',
          kind: 'text',
          placeholder: 'exe:javaw.exe',
        },
      ],
    },
    { id: 'refresh', label: 'Refresh the window list', inputs: [], ...noService },
    {
      id: 'set_interval',
      label: 'Set the interval',
      inputs: [
        {
          name: 'interval',
          label: 'Seconds between comments',
          kind: 'number',
          min: MIN_INTERVAL_SEC,
          max: MAX_INTERVAL_SEC,
          step: 1,
          value: v.intervalSec,
        },
      ],
    },
    {
      id: v.paused ? 'resume' : 'pause',
      label: v.paused ? 'Resume' : 'Pause',
      inputs: [],
      ...(v.running ? {} : { disabled: 'the mode is not running' }),
    },
    { id: 'reidentify', label: 'Which game is this? (look again)', inputs: [] },
    {
      id: 'test',
      label: 'Take a test picture',
      inputs: [],
      ...(v.serviceUp
        ? v.target === null
          ? { disabled: 'no window is chosen yet' }
          : {}
        : { disabled: SERVICE_DOWN }),
    },
    {
      id: 'clear_memory',
      label: 'Forget the game and the story',
      inputs: [],
      confirm: 'Forget which game this is and the story so far? The window and interval stay.',
    },
  ]

  return {
    status: clip(v.status, 300),
    facts: [
      fact('Window', v.target ?? 'none chosen yet'),
      fact('Capture service', v.serviceUp ? 'running' : 'not running'),
      fact('Game', gameFact(v)),
      fact('Interval', `${v.intervalSec} s after each comment`),
      fact(
        'Comments so far',
        `${v.rounds}${v.untilSummary !== null ? `, the story is renewed in ${v.untilSummary}` : ''}`
      ),
      fact('Black pictures skipped', String(v.blackFrames)),
      ...(v.lastCapture ? [fact('Last capture', v.lastCapture)] : []),
      ...(v.lastTest ? [fact('Last test picture', v.lastTest)] : []),
    ],
    actions,
    sections: [
      {
        title: 'On the screen now',
        rows: v.scene ? [{ id: 'scene', text: clip(v.scene, 300) }] : [],
        empty: 'Nothing has been read from the screen yet.',
      },
      {
        title: 'The story so far',
        rows: v.summary ? [{ id: 'summary', text: clip(v.summary, 300) }] : [],
        empty: 'No story yet: it starts after the first few comments.',
      },
      {
        title: 'Windows',
        rows: windows.map((w) => ({
          id: w.id,
          text: clip(w.title || '(no title)', 300),
          detail: clip(
            `${w.process || 'unknown program'}, ${w.width}x${w.height}${w.minimized ? ', minimised' : ''}${
              w.overlay ? ', looks like an overlay' : ''
            }`,
            300
          ),
          active: v.targetId !== null && w.id === v.targetId,
          actions: [{ id: 'use_window', label: 'Watch this', inputs: [] }],
        })),
        empty: clip(v.windowsNote ?? 'No windows listed: refresh the list.', 200),
      },
    ],
  }
}
