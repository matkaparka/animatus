import type { OverlayId, OverlaySet } from '@animatus/protocol'

type Slot = 'utterance' | 'track'

/**
 * The stage's DOM overlays: credit, lyrics, subtitle, picture frame, notice. Everything shown here was
 * sent by the orchestrator (or timed from a timeline it sent). Text is always assigned with
 * `textContent`; nothing that came over the wire is ever parsed as HTML.
 */
export class Overlays {
  private els = new Map<OverlayId, HTMLElement>()
  private visible = new Map<OverlayId, boolean>()
  private staticText = new Map<OverlayId, string>()
  private activityCredit: string | null = null
  private lyric = ''
  private subtitleBySlot: Record<Slot, string> = { utterance: '', track: '' }
  private frameImg: HTMLImageElement

  constructor(
    private readonly root: HTMLElement,
    private readonly doc: Document = root.ownerDocument
  ) {
    const mk = (id: OverlayId, cls: string) => {
      const el = this.doc.createElement('div')
      el.dataset.overlay = id
      el.className = `ov ${cls}`
      el.style.display = 'none'
      this.root.appendChild(el)
      this.els.set(id, el)
      this.visible.set(id, false)
      return el
    }
    mk('credit', 'ov-credit')
    mk('lyrics', 'ov-lyrics')
    mk('subtitle', 'ov-subtitle')
    mk('notice', 'ov-notice')
    const frame = mk('frame', 'ov-frame')
    this.frameImg = this.doc.createElement('img')
    this.frameImg.alt = ''
    this.frameImg.style.width = '100%'
    this.frameImg.style.height = '100%'
    this.frameImg.style.objectFit = 'contain'
    frame.appendChild(this.frameImg)
  }

  /** Apply an `overlay.set` snapshot. */
  set(msg: OverlaySet): void {
    this.visible.set(msg.id, msg.visible)
    if (msg.text !== undefined) this.staticText.set(msg.id, msg.text)
    if (msg.id === 'frame') {
      if (msg.rect) {
        const el = this.els.get('frame') as HTMLElement
        el.style.left = `${msg.rect.left}%`
        el.style.top = `${msg.rect.top}%`
        el.style.width = `${msg.rect.width}%`
        el.style.height = `${msg.rect.height}%`
      }
      if (msg.image !== undefined) this.frameImg.src = msg.image
    }
    this.render()
  }

  /** Place the picture frame (percent of the viewport); the frame image and visibility come from `set`. */
  setFrameRect(rect: { left: number; top: number; width: number; height: number } | null): void {
    if (!rect) return
    const el = this.els.get('frame') as HTMLElement
    el.style.left = `${rect.left}%`
    el.style.top = `${rect.top}%`
    el.style.width = `${rect.width}%`
    el.style.height = `${rect.height}%`
  }

  /** Credit shown for the length of a dance, whatever the static credit overlay says. */
  setActivityCredit(text: string | null): void {
    this.activityCredit = text
    this.render()
  }

  setLyric(text: string): void {
    if (text === this.lyric) return
    this.lyric = text
    this.render()
  }

  setSubtitle(slot: Slot, text: string): void {
    if (this.subtitleBySlot[slot] === text) return
    this.subtitleBySlot[slot] = text
    this.render()
  }

  /** Hide everything (used when the connection to the orchestrator is lost). */
  reset(): void {
    this.activityCredit = null
    this.lyric = ''
    this.subtitleBySlot = { utterance: '', track: '' }
    this.render()
  }

  private show(id: OverlayId, text: string): void {
    const el = this.els.get(id) as HTMLElement
    if (text) {
      if (el.textContent !== text) el.textContent = text
      el.style.display = ''
    } else {
      el.style.display = 'none'
      if (el.textContent) el.textContent = ''
    }
  }

  private render(): void {
    const on = (id: OverlayId) => this.visible.get(id) === true
    this.show(
      'credit',
      this.activityCredit ?? (on('credit') ? (this.staticText.get('credit') ?? '') : '')
    )
    this.show('lyrics', on('lyrics') ? this.lyric : '')
    this.show(
      'subtitle',
      on('subtitle') ? this.subtitleBySlot.utterance || this.subtitleBySlot.track : ''
    )
    this.show('notice', on('notice') ? (this.staticText.get('notice') ?? '') : '')
    const frame = this.els.get('frame') as HTMLElement
    frame.style.display = on('frame') && this.frameImg.getAttribute('src') ? '' : 'none'
  }
}
