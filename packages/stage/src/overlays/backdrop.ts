import type { Background } from '@animatus/protocol'

/** Page background plus the night filter that quiet looks lay over it. Content comes from the orchestrator only. */
export class Backdrop {
  private readonly bg: HTMLElement
  private readonly night: HTMLElement

  constructor(
    private readonly root: HTMLElement,
    doc: Document = root.ownerDocument
  ) {
    this.bg = doc.createElement('div')
    this.bg.className = 'backdrop'
    this.night = doc.createElement('div')
    this.night.className = 'backdrop-night'
    this.root.append(this.bg, this.night)
  }

  apply(b: Background): void {
    const s = this.bg.style
    s.backgroundColor = ''
    s.backgroundImage = ''
    s.filter = ''
    if (b.kind === 'color') {
      s.backgroundColor = b.color
    } else if (b.kind === 'image') {
      s.backgroundImage = `url("${b.url}")`
      s.backgroundSize = 'cover'
      s.backgroundPosition = 'center'
      if (b.dim > 0) s.filter = `brightness(${1 - b.dim})`
    }
  }

  /** 0 = no filter, 1 = deepest night. */
  setDim(dim: number): void {
    const d = Math.min(1, Math.max(0, dim))
    this.night.style.background = d > 0 ? `rgba(4, 8, 30, ${(d * 0.65).toFixed(3)})` : ''
  }
}
