// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Backdrop } from '../../src/overlays/backdrop.ts'
import { Overlays } from '../../src/overlays/overlays.ts'

const setup = () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const ov = new Overlays(root)
  const el = (id: string) => root.querySelector(`[data-overlay="${id}"]`) as HTMLElement
  return { ov, el, root }
}

describe('Overlays', () => {
  it('renders text as text, never as HTML', () => {
    const { ov, el } = setup()
    const evil = '<img src=x onerror="window.pwned=1"><b>bold</b>'
    ov.set({ type: 'overlay.set', id: 'notice', visible: true, text: evil })
    expect(el('notice').textContent).toBe(evil)
    expect(el('notice').querySelector('img')).toBeNull()
    expect(el('notice').querySelector('b')).toBeNull()
    ov.setSubtitle('utterance', evil)
    ov.set({ type: 'overlay.set', id: 'subtitle', visible: true })
    expect(el('subtitle').querySelector('img')).toBeNull()
    ov.setLyric(evil)
    ov.set({ type: 'overlay.set', id: 'lyrics', visible: true })
    expect(el('lyrics').querySelector('img')).toBeNull()
  })

  it('hides an overlay that is not visible or has no text', () => {
    const { ov, el } = setup()
    ov.set({ type: 'overlay.set', id: 'notice', visible: false, text: 'hello' })
    expect(el('notice').style.display).toBe('none')
    ov.set({ type: 'overlay.set', id: 'notice', visible: true })
    expect(el('notice').style.display).toBe('')
    expect(el('notice').textContent).toBe('hello')
    ov.set({ type: 'overlay.set', id: 'notice', visible: true, text: '' })
    expect(el('notice').style.display).toBe('none')
  })

  it('the dance credit shows for the dance even when the credit overlay is off, then the static credit returns', () => {
    const { ov, el } = setup()
    ov.set({ type: 'overlay.set', id: 'credit', visible: true, text: 'static credit' })
    expect(el('credit').textContent).toBe('static credit')
    ov.setActivityCredit('choreography by X')
    expect(el('credit').textContent).toBe('choreography by X')
    ov.setActivityCredit(null)
    expect(el('credit').textContent).toBe('static credit')
    ov.set({ type: 'overlay.set', id: 'credit', visible: false })
    ov.setActivityCredit('required credit')
    expect(el('credit').textContent).toBe('required credit')
  })

  it('an utterance subtitle wins over a track caption', () => {
    const { ov, el } = setup()
    ov.set({ type: 'overlay.set', id: 'subtitle', visible: true })
    ov.setSubtitle('track', 'from the track')
    expect(el('subtitle').textContent).toBe('from the track')
    ov.setSubtitle('utterance', 'a reply')
    expect(el('subtitle').textContent).toBe('a reply')
    ov.setSubtitle('utterance', '')
    expect(el('subtitle').textContent).toBe('from the track')
  })

  it('the frame overlay needs an image and visibility, and takes its rect from the scene', () => {
    const { ov, el } = setup()
    ov.setFrameRect({ left: 5, top: 8, width: 50, height: 68 })
    expect(el('frame').style.width).toBe('50%')
    ov.set({ type: 'overlay.set', id: 'frame', visible: true })
    expect(el('frame').style.display).toBe('none') // no image yet
    ov.set({ type: 'overlay.set', id: 'frame', visible: true, image: '/asset/draw/a.png' })
    expect(el('frame').style.display).toBe('')
    expect((el('frame').querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(
      '/asset/draw/a.png'
    )
  })

  describe('the frame is its message', () => {
    const img = (el: HTMLElement) => el.querySelector('img') as HTMLImageElement
    const caption = (el: HTMLElement) => el.querySelector('.ov-caption') as HTMLElement
    const A = '/asset/generated/a.png'
    const B = '/asset/generated/b.png'

    it('a picture with a caption shows both; the picture fades in only once it has loaded', () => {
      const { ov, el } = setup()
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, image: A, text: 'ann' })
      expect(el('frame').style.display).toBe('')
      expect(el('frame').dataset.state).toBe('picture')
      expect(caption(el('frame')).textContent).toBe('ann')
      expect(img(el('frame')).classList.contains('ov-shown')).toBe(false)
      img(el('frame')).dispatchEvent(new Event('load'))
      expect(img(el('frame')).classList.contains('ov-shown')).toBe(true)
      // the same picture again (a re-send) does not fade it out and in again
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, image: A, text: 'ann' })
      expect(img(el('frame')).classList.contains('ov-shown')).toBe(true)
      // a different one starts hidden again
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, image: B, text: 'bob' })
      expect(img(el('frame')).classList.contains('ov-shown')).toBe(false)
      expect(caption(el('frame')).textContent).toBe('bob')
    })

    it('only words: a frame with the words and no picture (a request being drawn), and the old picture is gone', () => {
      const { ov, el } = setup()
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, image: A, text: 'old' })
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, text: 'drawing' })
      expect(el('frame').style.display).toBe('')
      expect(el('frame').dataset.state).toBe('text')
      expect(img(el('frame')).getAttribute('src')).toBeNull()
      expect(img(el('frame')).style.display).toBe('none')
      expect(caption(el('frame')).textContent).toBe('drawing')
    })

    it('a message says everything: no text, no caption; neither, no frame; not visible, no frame', () => {
      const { ov, el } = setup()
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, image: A, text: 'caption' })
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, image: A })
      expect(caption(el('frame')).style.display).toBe('none')
      expect(el('frame').style.display).toBe('')
      ov.set({ type: 'overlay.set', id: 'frame', visible: true })
      expect(el('frame').style.display).toBe('none')
      ov.set({ type: 'overlay.set', id: 'frame', visible: false, text: 'back' })
      expect(el('frame').style.display).toBe('none')
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, text: 'back' })
      expect(el('frame').style.display).toBe('')
    })

    it('the words are text, never markup', () => {
      const { ov, el } = setup()
      const evil = '<img src=x onerror="window.pwned=1"><b>bold</b>'
      ov.set({ type: 'overlay.set', id: 'frame', visible: true, text: evil })
      expect(caption(el('frame')).textContent).toBe(evil)
      expect(caption(el('frame')).querySelector('b')).toBeNull()
      expect(el('frame').querySelectorAll('img')).toHaveLength(1)
    })
  })

  it('reset clears activity text but keeps the snapshot state', () => {
    const { ov, el } = setup()
    ov.set({ type: 'overlay.set', id: 'lyrics', visible: true })
    ov.setLyric('la la')
    expect(el('lyrics').textContent).toBe('la la')
    ov.reset()
    expect(el('lyrics').style.display).toBe('none')
    ov.setLyric('again')
    expect(el('lyrics').textContent).toBe('again')
  })
})

describe('Backdrop', () => {
  it('applies colour, image with dim, and the night filter', () => {
    const root = document.createElement('div')
    const b = new Backdrop(root)
    const bg = root.querySelector('.backdrop') as HTMLElement
    const night = root.querySelector('.backdrop-night') as HTMLElement
    b.apply({ kind: 'color', color: '#112233' })
    expect(bg.style.backgroundColor).not.toBe('')
    b.apply({ kind: 'image', url: '/asset/backgrounds/a.png', dim: 0.4 })
    expect(bg.style.backgroundImage).toContain('/asset/backgrounds/a.png')
    expect(bg.style.filter).toContain('brightness(0.6)')
    b.apply({ kind: 'none' })
    expect(bg.style.backgroundImage).toBe('')
    b.setDim(0)
    expect(night.style.background).toBe('')
    b.setDim(1)
    expect(night.style.background).toContain('rgba')
  })
})

describe('the spoken subtitle', () => {
  it('shows the words in their own element, with an optional name badge above them', () => {
    const { ov, el } = setup()
    ov.set({ type: 'overlay.set', id: 'subtitle', visible: true, text: 'Nova' })
    expect(el('subtitle').style.display).toBe('none') // nothing is being said
    ov.setSubtitle('utterance', 'Hello there.')
    expect(el('subtitle').style.display).toBe('')
    expect(el('subtitle').querySelector('.ov-words')?.textContent).toBe('Hello there.')
    const badge = el('subtitle').querySelector('.ov-name') as HTMLElement
    expect(badge.textContent).toBe('Nova')
    expect(badge.style.display).toBe('')
    ov.set({ type: 'overlay.set', id: 'subtitle', visible: true, text: '' })
    expect((el('subtitle').querySelector('.ov-name') as HTMLElement).style.display).toBe('none')
  })

  it('takes a variant, and defaults to the bubble', () => {
    const { ov, el } = setup()
    expect(el('subtitle').dataset.variant).toBeUndefined()
    ov.set({ type: 'overlay.set', id: 'subtitle', visible: true, variant: 'plain' })
    expect(el('subtitle').dataset.variant).toBe('plain')
    ov.set({ type: 'overlay.set', id: 'subtitle', visible: true, variant: 'bubble' })
    expect(el('subtitle').dataset.variant).toBe('bubble')
  })

  it('does not show when the overlay is switched off, and is emptied when the words go', () => {
    const { ov, el } = setup()
    ov.setSubtitle('utterance', 'said while the overlay was off')
    expect(el('subtitle').style.display).toBe('none')
    ov.set({ type: 'overlay.set', id: 'subtitle', visible: true })
    expect(el('subtitle').style.display).toBe('')
    ov.setSubtitle('utterance', '')
    expect(el('subtitle').style.display).toBe('none')
    expect(el('subtitle').querySelector('.ov-words')?.textContent).toBe('')
  })
})
