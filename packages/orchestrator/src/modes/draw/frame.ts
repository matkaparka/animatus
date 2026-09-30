/**
 * What the stage shows of the draw mode, as `overlay.set` messages.
 *
 * The frame has three states (idle: a hint; generating: who is being drawn for and what; showing: the picture and
 * who asked for it) and a fourth that is no state, hidden (the mode is not running). Every message carries the whole
 * state of its overlay, because the stage keeps only the latest one per overlay and a page that reconnects starts
 * from it.
 *
 * With `text_overlay: frame` the words are the frame's own `text`. With `notice` they go to the banner at the top
 * and the frame overlay carries the picture only (it is hidden while there is none): the stage draws frame text
 * only from a later version on.
 */
import type { OverlaySet, Rect } from '@animatus/protocol'

export type FrameState =
  | { kind: 'idle' }
  | { kind: 'generating'; user: string; request: string }
  | { kind: 'showing'; user: string; image: string; at: number }

export interface FrameTexts {
  idle: string
  generating(user: string, request: string): string
  showing(user: string): string
}

export interface FrameView {
  textOverlay: 'frame' | 'notice'
  rect: Rect | null
}

export function frameMessages(
  state: FrameState | { kind: 'hidden' },
  view: FrameView,
  texts: FrameTexts
): OverlaySet[] {
  const words =
    state.kind === 'idle'
      ? texts.idle
      : state.kind === 'generating'
        ? texts.generating(state.user, state.request)
        : state.kind === 'showing'
          ? texts.showing(state.user)
          : ''
  const picture = state.kind === 'showing' ? state.image : null
  const place = view.rect ? { rect: view.rect } : {}
  if (view.textOverlay === 'notice') {
    return [
      {
        type: 'overlay.set',
        id: 'frame',
        visible: picture !== null,
        ...(picture !== null ? { image: picture } : {}),
        ...place,
      },
      { type: 'overlay.set', id: 'notice', visible: words !== '', text: words },
    ]
  }
  return [
    {
      type: 'overlay.set',
      id: 'frame',
      visible: state.kind !== 'hidden',
      text: words,
      ...(picture !== null ? { image: picture } : {}),
      ...place,
    },
  ]
}
