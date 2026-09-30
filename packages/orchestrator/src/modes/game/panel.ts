/**
 * What the console shows for the game mode, as data (`ModePanel`): a status line, some facts, the recent events, and the
 * buttons. Pure: the controller hands over a snapshot. Every string is cut to the length the schema allows, because a panel
 * that breaks one limit is dropped whole by the mode service and the operator would see nothing.
 */
import type {
  ModePanelInput,
  PanelActionInput,
  WorkerState,
  WorkerUrgency,
} from '@animatus/protocol'
import { describeStatus } from './prompts.ts'
import { ago, cleanGameText, clip } from './text.ts'

/** What the mode is doing about comments right now. */
export type Doing = 'idle' | 'waiting' | 'voice' | 'blocked' | 'telling'

export interface PanelEvent {
  /** Counts up over the run; the row's id. */
  no: number
  kind: string
  text: string
  urgency: WorkerUrgency
  /** Milliseconds since the mode read it. */
  ageMs: number
}

export interface PanelView {
  /** `off`: not running; `starting` and `stopping`: on the way; `running`. */
  phase: 'off' | 'starting' | 'running' | 'stopping'
  title: string
  protocol: 'worker' | 'legacy'
  state: WorkerState | null
  /** Why the agent does not answer, or null. */
  unreachable: string | null
  /** Seconds until the next try while it does not answer. */
  retryInSec: number | null
  doing: Doing
  /** What keeps a comment from being made (a dance, no stage page), or null. */
  blockedBy: string | null
  comments: number
  lastCommentAgeMs: number | null
  waiting: { immediate: number; soon: number; restarted: boolean }
  /** Newest first. */
  events: readonly PanelEvent[]
}

export const NOT_RUNNING = 'the game mode is not running'
/** The list shows this many events. */
export const MAX_ROWS = 30
/** The schema allows twenty facts. */
const MAX_FACTS = 20

const fact = (label: string, value: string) => ({ label: clip(label, 60), value: clip(value, 200) })

/** What the agent reported, on one line: the operator sees it as text, but a line break or a control character would still break the layout. */
const said = (value: unknown) =>
  cleanGameText(typeof value === 'string' ? value : String(value), 200)

function statusLine(v: PanelView): string {
  switch (v.phase) {
    case 'off':
      return 'not running'
    case 'starting':
      return `starting: asking the game agent (${v.title}) to answer`
    case 'stopping':
      return 'stopping'
    case 'running':
      break
  }
  if (v.unreachable !== null)
    return `the game agent does not answer (${v.unreachable}); trying again in about ${v.retryInSec ?? '?'} s`
  const agent = `${v.title}: ${describeStatus(v.state, null)}`
  const rest =
    v.doing === 'voice'
      ? 'waiting for the voice to be free to comment'
      : v.doing === 'blocked'
        ? `not commenting: ${v.blockedBy ?? 'something else has the stage'}`
        : v.doing === 'telling'
          ? 'commenting'
          : ''
  return rest ? `${agent}; ${rest}` : agent
}

/** Whether a directive can be sent, or why not. */
function directiveBlock(v: PanelView): string | undefined {
  if (v.phase !== 'running') return NOT_RUNNING
  if (v.unreachable !== null) return 'the game agent does not answer'
  if (v.state !== null && !v.state.online) return 'the game is not connected'
  return undefined
}

export function buildPanel(v: PanelView): ModePanelInput {
  const running = v.phase === 'running'
  const s = v.state
  const facts = [
    fact('Game', `${v.title} (${v.protocol === 'legacy' ? 'older link' : 'worker protocol'})`),
    ...(running && s ? [fact('Agent', describeStatus(s, v.unreachable))] : []),
    ...(running && s?.summary ? [fact('Situation', said(s.summary))] : []),
    ...(running && s?.last_command ? [fact('Last directive', said(s.last_command.text))] : []),
    ...(running
      ? [
          fact(
            'Comments',
            `${v.comments} so far${v.lastCommentAgeMs !== null ? `, the last ${ago(v.lastCommentAgeMs)}` : ''}`
          ),
          fact(
            'Waiting to be said',
            v.waiting.immediate + v.waiting.soon === 0 && !v.waiting.restarted
              ? 'nothing'
              : `${v.waiting.immediate} immediate, ${v.waiting.soon} soon${v.waiting.restarted ? ', and the restart' : ''}`
          ),
        ]
      : []),
    ...(running && s
      ? Object.entries(s.facts)
          .filter(([, value]) => value !== null)
          .map(([key, value]) => fact(said(key), said(value)))
      : []),
  ].slice(0, MAX_FACTS)

  const paused = s?.paused === true
  const notRunning = running ? {} : { disabled: NOT_RUNNING }
  const directiveOff = directiveBlock(v)
  const actions: PanelActionInput[] = [
    {
      id: paused ? 'resume' : 'pause',
      label: paused ? 'Resume the game agent' : 'Pause the game agent',
      ...notRunning,
    },
    {
      id: 'forget',
      label: 'Forget notes and directives',
      confirm:
        'Make the game agent drop its notes and standing directives, and drop what the character was told about the game? The game itself is not changed.',
      ...notRunning,
    },
    {
      id: 'directive',
      label: 'Send a directive',
      inputs: [
        {
          name: 'text',
          label: 'Directive (1 to 300 characters)',
          kind: 'text',
          placeholder: 'for example: gather wood, then build a shelter',
        },
      ],
      ...(directiveOff ? { disabled: directiveOff } : {}),
    },
    { id: 'refresh', label: 'Refresh', ...notRunning },
  ]

  return {
    status: clip(statusLine(v), 300),
    facts,
    actions,
    sections: [
      {
        title: 'Recent events',
        empty: running
          ? 'Nothing has happened since the mode started.'
          : 'The mode is not running: nothing is being read.',
        rows: v.events.slice(0, MAX_ROWS).map((e) => ({
          id: String(e.no),
          text: clip(`${e.kind}: ${e.text}`, 300),
          detail: `${e.urgency}, ${ago(e.ageMs)}`,
        })),
      },
    ],
  }
}
