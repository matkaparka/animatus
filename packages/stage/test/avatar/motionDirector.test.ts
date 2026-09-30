import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { MOTION, MotionDirector, applyMotionTuning } from '../../src/avatar/motionDirector.ts'
import type { TalkClip } from '../../src/avatar/motionDirector.ts'
import { meanAngleFromBind } from '../../src/diag/tpose.ts'
import { seededRandom } from './fakeVrm.ts'

const DT = 1 / 60
const DEG = Math.PI / 180
const AXIS_Y = new THREE.Vector3(0, 1, 0)
const NODES = ['spine', 'head', 'armL', 'armR']

const motionDefaults = structuredClone(MOTION)
afterEach(() => {
  Object.assign(MOTION, structuredClone(motionDefaults))
})

/**
 * A clip that keeps every node well away from the bind (identity) pose: a rotation about Y between `lo`
 * and `hi` degrees. If the mixer ever mixes bind pose into the result, the pose gets closer to identity.
 */
function clip(name: string, duration: number, lo: number, hi: number): THREE.AnimationClip {
  const tracks = NODES.map((node, i) => {
    const q = (deg: number) =>
      new THREE.Quaternion().setFromAxisAngle(AXIS_Y, (deg + i * 3) * DEG).toArray()
    return new THREE.QuaternionKeyframeTrack(
      `${node}.quaternion`,
      [0, duration / 2, duration],
      [...q(lo), ...q(hi), ...q(lo)]
    )
  })
  return new THREE.AnimationClip(name, duration, tracks)
}

/** `bases` originals (T0..) with a mirrored twin each (T0m..), sharing `base`. */
function talkLibrary(bases: number, durations = [6, 7, 8, 5, 9, 6.5]): TalkClip[] {
  const out: TalkClip[] = []
  for (let b = 0; b < bases; b++) {
    const d = durations[b % durations.length]!
    out.push({ name: `T${b}`, clip: clip(`T${b}`, d, 55 + b * 4, 60 + b * 4), base: b })
    out.push({ name: `T${b}m`, clip: clip(`T${b}m`, d, 55 + b * 4, 60 + b * 4), base: b })
  }
  return out
}
const baseOf = (name: string) => Number(/^T(\d+)m?$/.exec(name)![1])

/** Mixer + director on a small rig, driven at 60 fps with an injected clock. Checks the invariants on every frame. */
class Rig {
  root = new THREE.Group()
  nodes: THREE.Object3D[] = []
  mixer: THREE.AnimationMixer
  director: MotionDirector
  ms = 0
  frames = 0
  audio = false
  label = ''
  /** Called before every director update (a dance controller sets its action time here). */
  onFrame?: () => void
  maxSumError = 0
  minPoseAngle = Infinity
  idleA = clip('idleA', 4, 35, 40)
  idleB = clip('idleB', 5, 45, 50)
  actionA: THREE.AnimationAction
  actionB: THREE.AnimationAction

  constructor(seed = 1) {
    for (const n of NODES) {
      const o = new THREE.Object3D()
      o.name = n
      this.root.add(o)
      this.nodes.push(o)
    }
    this.mixer = new THREE.AnimationMixer(this.root)
    this.director = new MotionDirector(this.mixer, {
      random: seededRandom(seed),
      now: () => this.ms,
    })
    this.actionA = this.mixer.clipAction(this.idleA)
    this.actionB = this.mixer.clipAction(this.idleB)
  }

  /** Base idle pose, as the stage does on library.set. */
  withIdle() {
    this.director.setIdle(this.actionA)
    return this
  }

  frame(audio = this.audio) {
    this.onFrame?.()
    this.director.update(DT, audio)
    this.mixer.update(DT)
    this.ms += DT * 1000
    this.frames++
    this.check()
  }

  run(seconds: number, audio = this.audio) {
    const n = Math.round(seconds / DT)
    for (let i = 0; i < n; i++) this.frame(audio)
  }

  /** Run until `pred` holds (at most `max` seconds). Returns the seconds it took. */
  until(pred: () => boolean, max = 30, audio = this.audio): number {
    let t = 0
    while (!pred() && t < max) {
      this.frame(audio)
      t += DT
    }
    expect(pred(), `${this.label}: condition not reached in ${max} s`).toBe(true)
    return t
  }

  weights() {
    const st = this.director.debugState()
    return [...new Set(st.entries.map((e) => e.action))].map((a) => a.getEffectiveWeight())
  }

  /** The invariants that keep the body out of the T-pose: called after every frame. */
  private check() {
    const st = this.director.debugState()
    if (st.idle === null) return
    const where = `${this.label || 'scenario'}, frame ${this.frames}`
    let sum = 0
    for (const a of new Set(st.entries.map((e) => e.action))) {
      const w = a.getEffectiveWeight()
      if (!(w >= 0 && w <= 1 + 1e-9)) throw new Error(`${where}: weight ${w} is outside 0..1`)
      sum += w
    }
    const err = Math.abs(sum - (1 - st.external))
    this.maxSumError = Math.max(this.maxSumError, err)
    if (err > 1e-6) throw new Error(`${where}: weights sum to ${sum}, expected ${1 - st.external}`)
    if (st.external === 0) {
      const angle = meanAngleFromBind(this.nodes.map((n) => n.quaternion))
      this.minPoseAngle = Math.min(this.minPoseAngle, angle)
      if (!(angle > 25))
        throw new Error(`${where}: pose fell to the bind pose (mean angle ${angle.toFixed(1)})`)
    }
  }
}

/** Let the promise chains of switchIdle run (they only await already-resolved promises). */
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('weight normalisation (the T-pose guard)', () => {
  it('keeps every managed action summing to 1 - external through a long scenario', async () => {
    const rig = new Rig(3).withIdle()
    const { director } = rig
    const lib = talkLibrary(4)
    director.setTalkClips(lib)
    director.setIdleSources([{ id: 'stretch', getClip: async () => rig.idleB }])
    const oneShot = clip('wave', 2, 70, 75)
    const oneShot2 = clip('nod', 2, 70, 75)
    const live = clip('live', 3, 80, 85)
    const dance = clip('dance', 10, 90, 95)

    // 1. idle
    rig.label = 'idle'
    rig.run(3)
    expect(director.isIdle).toBe(true)
    expect(director.idleWeight).toBeCloseTo(1, 9)
    expect(director.danceWeight).toBe(0)

    // 2. speech starts: talk clips rotate, idle steps aside
    rig.label = 'speech'
    director.beginUtterance(null)
    rig.audio = true
    rig.run(1)
    expect(director.isIdle).toBe(false)
    expect(director.idleWeight).toBeLessThan(1e-6)
    const names: string[] = []
    for (let i = 0; i < 60 * 40; i++) {
      rig.frame()
      const talk = director.debugState().talk
      if (talk && talk !== names[names.length - 1]) names.push(talk)
    }
    expect(names.length).toBeGreaterThanOrEqual(4)
    expect(new Set(names).size).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < names.length; i++) {
      expect(baseOf(names[i]!), `${names[i - 1]} then ${names[i]}`).not.toBe(baseOf(names[i - 1]!))
    }

    // 3. speech stops, idle comes back
    rig.label = 'silence'
    rig.audio = false
    rig.run(2)
    expect(director.isIdle).toBe(true)
    expect(director.idleWeight).toBeCloseTo(1, 9)

    // 4. a tag motion while idle
    rig.label = 'one-shot'
    let done = 0
    director.playOneShot(rig.mixer.clipAction(oneShot), () => done++)
    expect(director.oneShotActive).toBe(true)
    rig.run(1)
    expect(director.idleWeight).toBeLessThan(1e-6)
    rig.until(() => done === 1, 10)
    expect(director.oneShotActive).toBe(false)
    rig.until(() => director.isIdle, 5)
    expect(done).toBe(1)

    // 5. speech again, and a tag motion in the middle of it
    rig.label = 'speech + one-shot'
    director.beginUtterance(null)
    rig.audio = true
    rig.run(2)
    let done2 = 0
    director.playOneShot(rig.mixer.clipAction(oneShot2), () => done2++)
    rig.until(() => done2 === 1, 10)
    rig.run(4)
    expect(director.debugState().talk).not.toBeNull()
    expect(director.idleWeight).toBeLessThan(1e-6)
    rig.audio = false
    rig.run(1.5)

    // 6. a live-generated clip for the next sentence
    rig.label = 'live clip'
    director.beginUtterance(live)
    rig.audio = true
    rig.run(1)
    expect(director.debugState().talk).toBe('live')
    rig.run(4) // the clip is 3 s long: past its end a library clip takes over while speech goes on
    expect(director.debugState().talk).not.toBe('live')
    rig.audio = false
    rig.run(5)
    expect(director.isIdle).toBe(true)

    // 7. a dance: fade in, hold, speech is ignored meanwhile, fade out
    rig.label = 'dance'
    const danceAction = rig.mixer.clipAction(dance)
    let danceT = 0
    rig.onFrame = () => {
      danceAction.time = Math.min(danceT, dance.duration)
      danceT += DT
    }
    director.playDance(danceAction, 1)
    expect(director.danceActive).toBe(true)
    let maxDance = 0
    rig.run(1.2)
    maxDance = Math.max(maxDance, director.danceWeight)
    expect(director.danceWeight).toBeCloseTo(1, 6)
    expect(director.idleWeight).toBeLessThan(1e-6)
    expect(director.isIdle).toBe(false)
    director.beginUtterance(null)
    rig.audio = true
    rig.run(2)
    expect(director.debugState().entries.some((e) => e.kind === 'talk')).toBe(false)
    rig.audio = false
    rig.run(0.5)
    director.stopDance(1.5)
    expect(director.danceActive).toBe(false)
    for (let i = 0; i < 60 * 3; i++) {
      rig.frame()
      maxDance = Math.max(maxDance, director.danceWeight)
    }
    rig.onFrame = undefined
    expect(maxDance).toBeCloseTo(1, 6)
    expect(maxDance).toBeLessThanOrEqual(1 + 1e-9)
    expect(director.danceWeight).toBe(0)
    expect(director.idleWeight).toBeCloseTo(1, 9)
    expect(director.debugState().entries.map((e) => e.kind)).toEqual(['idle'])
    expect(director.isIdle).toBe(true)

    // 8. an idle variant, and back
    rig.label = 'idle variant'
    expect(await director.switchIdle()).toBe(true)
    expect(director.debugState().idle).toBe('idleB')
    rig.run(0.5)
    expect(director.isIdle).toBe(false) // still cross-fading
    rig.run(2)
    expect(director.isIdle).toBe(true)
    expect(director.idleWeight).toBeCloseTo(1, 9)
    expect(await director.switchIdle()).toBe(true)
    expect(director.debugState().idle).toBe('idleA')
    rig.run(2)

    expect(rig.frames).toBeGreaterThan(60 * 60)
    expect(rig.maxSumError).toBeLessThanOrEqual(1e-6)
    expect(rig.minPoseAngle).toBeGreaterThan(25)
    // everything the director started is gone or accounted for
    expect(director.debugState().entries).toHaveLength(1)
  })

  it('normalises when two entries fade out while a third fades in (a tag motion arriving mid-fade)', () => {
    // Speech starts (idle -> talk), and 0.2 s into that fade a tag motion arrives. Now idle AND talk
    // are falling while the tag motion rises, so the raw weights no longer sum to 1. Left alone,
    // AnimationMixer would mix the missing share of the bind pose in.
    const rig = new Rig(5).withIdle()
    rig.director.setTalkClips(talkLibrary(3))
    rig.director.beginUtterance(null)
    rig.audio = true
    rig.label = 'speech start'
    rig.run(0.2)
    rig.director.playOneShot(rig.mixer.clipAction(clip('wave', 3, 70, 75)))
    let lowestRawSum = Infinity
    rig.label = 'tag motion mid-fade'
    for (let i = 0; i < 60 * 1; i++) {
      rig.frame()
      const raw = rig.director.debugState().entries.reduce((s, e) => s + e.w, 0)
      lowestRawSum = Math.min(lowestRawSum, raw)
    }
    expect(lowestRawSum).toBeLessThan(0.9) // the situation really is asymmetric...
    expect(rig.maxSumError).toBeLessThanOrEqual(1e-6) // ...and the applied weights still sum to 1 (checked every frame)
  })

  it('normalises when a dance is stopped in the middle of its fade-in and speech follows', () => {
    const rig = new Rig(6).withIdle()
    rig.director.setTalkClips(talkLibrary(3))
    const action = rig.mixer.clipAction(clip('dance', 8, 90, 95))
    rig.director.playDance(action, 1)
    rig.label = 'dance fade-in'
    rig.run(0.4)
    rig.director.stopDance(1.5)
    rig.director.beginUtterance(null)
    rig.audio = true
    rig.label = 'dance stopped, speech'
    rig.run(3)
    rig.director.playDance(action, 0.5) // the same action again while it is still fading out
    rig.label = 'dance again'
    rig.run(1)
    rig.director.stopDance(0.3)
    rig.audio = false
    rig.run(4)
    expect(rig.director.isIdle).toBe(true)
  })

  it('ramps an external pose in and out without breaking the sum', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    rig.run(1)
    rig.director.setExternal(true)
    expect(rig.director.isIdle).toBe(false)
    const seen: number[] = []
    for (let i = 0; i < 60 * 1; i++) {
      rig.frame()
      seen.push(rig.director.debugState().external)
    }
    expect(seen[0]).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBe(1)
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true)
    expect(rig.weights().reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9)
    // speech while external: still normalised
    rig.director.beginUtterance(null)
    rig.run(2, true)
    rig.director.setExternal(false)
    rig.run(1, false)
    expect(rig.director.debugState().external).toBe(0)
    expect(rig.director.isIdle).toBe(true)
  })

  it('never lets weight slip when idle poses are switched and speech follows within the fade', async () => {
    // idle A -> B (1.5 s fade), and speech arrives 0.2 s later: the director swings back to the base
    // pose A while A is still fading out. The same action then sits in two entries.
    const rig = new Rig(8).withIdle()
    rig.director.setTalkClips(talkLibrary(3))
    rig.director.setIdleSources([{ id: 'b', getClip: async () => rig.idleB }])
    rig.run(1)
    expect(await rig.director.switchIdle()).toBe(true)
    rig.run(0.2)
    rig.director.beginUtterance(null)
    rig.audio = true
    rig.label = 'speech during an idle cross-fade'
    rig.run(6)
    const kinds = rig.director.debugState().entries.map((e) => e.kind)
    expect(kinds).toContain('talk')
    expect(rig.actionA.isRunning()).toBe(true) // never stopped underneath the entry that still uses it
    rig.audio = false
    rig.label = 'back to idle'
    rig.run(4)
    expect(rig.director.isIdle).toBe(true)
    expect(rig.director.debugState().idle).toBe('idleA')
    expect(rig.actionA.isRunning()).toBe(true)
    expect(rig.actionB.isRunning()).toBe(false)
  })

  it('handles hitching frames (long deltas are clamped)', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    rig.director.beginUtterance(null)
    for (let i = 0; i < 400; i++) {
      const delta = i % 37 === 0 ? 0.5 : i % 11 === 0 ? 0 : DT
      rig.director.update(delta, i < 300)
      rig.mixer.update(delta)
      const sum = rig.weights().reduce((a, b) => a + b, 0)
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6)
    }
  })

  it('a NaN delta does not poison the start time of a live clip', () => {
    const rig = new Rig().withIdle()
    const live = clip('live', 2, 80, 85)
    rig.director.beginUtterance(live)
    rig.director.update(Number.NaN, true)
    rig.mixer.update(DT)
    expect(Number.isFinite(rig.mixer.existingAction(live)!.time)).toBe(true)
    expect(rig.weights().every((w) => Number.isFinite(w))).toBe(true)
  })

  it('survives NaN and negative deltas', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    for (const d of [Number.NaN, -1, Number.POSITIVE_INFINITY, 0]) rig.director.update(d, true)
    expect(rig.weights().every((w) => Number.isFinite(w))).toBe(true)
    expect(rig.weights().reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
  })
})

describe('talk clips', () => {
  it('rotates without playing an original and its mirror back to back (real run)', () => {
    for (const seed of [1, 2, 3]) {
      const rig = new Rig(seed).withIdle()
      rig.director.setTalkClips(talkLibrary(4))
      rig.director.beginUtterance(null)
      rig.audio = true
      const names: string[] = []
      for (let i = 0; i < 60 * 240; i++) {
        rig.frame()
        const talk = rig.director.debugState().talk
        if (talk && talk !== names[names.length - 1]) names.push(talk)
      }
      expect(names.length).toBeGreaterThan(30)
      for (let i = 1; i < names.length; i++)
        expect(baseOf(names[i]!)).not.toBe(baseOf(names[i - 1]!))
      // every clip comes up
      for (const c of talkLibrary(4))
        expect(names.filter((n) => n === c.name).length).toBeGreaterThanOrEqual(3)
    }
  })

  const nextClip = (d: MotionDirector) =>
    (d as unknown as { nextClip(): TalkClip | null }).nextClip()

  it('the shuffle bag never repeats a base while another one exists (many seeds and sizes)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const bases of [2, 3, 4, 5, 7]) {
        const rig = new Rig(seed)
        rig.director.setTalkClips(talkLibrary(bases))
        let last: TalkClip | null = null
        const counts = new Map<string, number>()
        const rounds = 12
        for (let i = 0; i < rounds * bases * 2; i++) {
          const c = nextClip(rig.director)!
          if (last) expect(c.base, `seed ${seed}, ${bases} bases, pick ${i}`).not.toBe(last.base)
          last = c
          counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
        }
        for (const c of talkLibrary(bases))
          expect(counts.get(c.name) ?? 0).toBeGreaterThanOrEqual(rounds / 3)
      }
    }
  })

  it('with a single base the twins have to follow each other, and an empty library gives nothing', () => {
    const rig = new Rig()
    rig.director.setTalkClips(talkLibrary(1))
    expect([nextClip(rig.director)!.name, nextClip(rig.director)!.name].sort()).toEqual([
      'T0',
      'T0m',
    ])
    rig.director.setTalkClips([])
    expect(nextClip(rig.director)).toBeNull()
  })

  it('resuming speech within resumeWindow continues the same talk clip, later starts a new one', () => {
    const rig = new Rig(4).withIdle()
    rig.director.setTalkClips(talkLibrary(4))
    rig.director.beginUtterance(null)
    rig.audio = true
    // wait until a clip has just started, so it has plenty left
    const first = rig.director.debugState().talk
    rig.run(0.5)
    let current = rig.director.debugState().talk
    let guard = 0
    while (
      current === first ||
      (rig.director.debugState().entries.find((e) => e.kind === 'talk' && e.target === 1)?.action
        .time ?? 99) > 1
    ) {
      rig.frame()
      current = rig.director.debugState().talk
      if (++guard > 60 * 60) throw new Error('no fresh clip')
    }
    rig.run(1)
    const talkEntry = () =>
      rig.director
        .debugState()
        .entries.find(
          (e) => (e.kind === 'talk' && e.target === 1) || (e.kind === 'talk' && e.w > 0)
        )!
    const name = rig.director.debugState().talk
    const action = talkEntry().action
    const timeAtStop = action.time

    rig.audio = false
    rig.run(1.2) // shorter than resumeWindow (3 s)
    expect(rig.director.isIdle).toBe(true)
    expect(rig.director.debugState().entries.some((e) => e.action === action)).toBe(true) // kept for resuming
    expect(action.paused).toBe(true)
    const pausedAt = action.time
    expect(pausedAt).toBeGreaterThanOrEqual(timeAtStop)

    rig.director.beginUtterance(null)
    rig.audio = true
    rig.run(0.5)
    expect(rig.director.debugState().talk).toBe(name)
    expect(action.paused).toBe(false)
    expect(action.time).toBeGreaterThan(pausedAt) // carried on from where it was, not restarted
    expect(action.time).toBeLessThan(pausedAt + 1)

    // silence longer than resumeWindow: the clip is dropped and the next speech starts a new one
    rig.audio = false
    rig.run(MOTION.resumeWindow + 1)
    expect(rig.director.debugState().entries.some((e) => e.action === action)).toBe(false)
    expect(rig.director.debugState().talk).toBeNull()
    rig.director.beginUtterance(null)
    rig.audio = true
    rig.run(0.5)
    expect(rig.director.debugState().talk).not.toBeNull()
  })

  it('reports talk clips by their library name, also for the copies made when a clip is picked again', () => {
    const rig = new Rig().withIdle()
    const lib: TalkClip[] = [
      { name: 'wave-big', clip: clip('some-internal-name', 3, 55, 60), base: 0 },
      { name: 'wave-small', clip: clip('another-name', 3, 60, 65), base: 1 },
    ]
    rig.director.setTalkClips(lib)
    rig.director.beginUtterance(null)
    rig.audio = true
    const seen = new Set<string>()
    for (let i = 0; i < 60 * 30; i++) {
      rig.frame()
      const st = rig.director.debugState()
      if (st.talk) seen.add(st.talk)
      for (const e of st.entries) if (e.kind === 'talk') seen.add(e.clip)
    }
    expect([...seen].sort()).toEqual(['wave-big', 'wave-small'])
  })

  it('a short clip is not swapped every frame', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips([
      { name: 'T0', clip: clip('T0', 1.2, 55, 60), base: 0 },
      { name: 'T1', clip: clip('T1', 1.2, 60, 65), base: 1 },
    ])
    rig.director.beginUtterance(null)
    rig.audio = true
    let switches = 0
    let prev: THREE.AnimationAction | undefined
    let maxTalk = 0
    for (let i = 0; i < 60 * 10; i++) {
      rig.frame()
      const talks = rig.director.debugState().entries.filter((e) => e.kind === 'talk')
      maxTalk = Math.max(maxTalk, talks.length)
      const cur = talks.find((e) => e.target === 1)?.action
      if (cur && cur !== prev) switches++
      if (cur) prev = cur
    }
    expect(switches).toBeLessThan(40)
    expect(maxTalk).toBeLessThanOrEqual(12) // faded-out clips are kept for resumeWindow
  })

  it('drops clips that have no duration', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips([
      { name: 'empty', clip: new THREE.AnimationClip('empty', 0, []), base: 0 },
    ])
    rig.director.beginUtterance(null)
    rig.run(2, true)
    expect(rig.director.debugState().talk).toBeNull()
    expect(rig.director.idleWeight).toBeCloseTo(1, 9)
  })

  it('an utterance without any talk clips keeps the idle pose', () => {
    const rig = new Rig().withIdle()
    rig.director.beginUtterance(null)
    rig.run(3, true)
    expect(rig.director.idleWeight).toBeCloseTo(1, 9)
    expect(rig.director.isIdle).toBe(false) // sound is playing, whatever the body does
  })
})

describe('live-generated clips', () => {
  it('starts from the first frame and catches up with the time spent waiting for the speech', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    const live = clip('live', 3, 80, 85)
    rig.director.beginUtterance(live)
    rig.ms += 300 // the audio took 300 ms to decode
    rig.audio = true
    rig.frame()
    expect(rig.director.debugState().talk).toBe('live')
    const action = rig.mixer.existingAction(live)!
    expect(action.time).toBeCloseTo(0.3, 6) // 0.3 s minus this frame, plus this frame's mixer step

    // without waiting it starts at the beginning
    const rig2 = new Rig().withIdle()
    rig2.director.setTalkClips(talkLibrary(2))
    const live2 = clip('live2', 3, 80, 85)
    rig2.director.beginUtterance(live2)
    rig2.audio = true
    rig2.frame()
    expect(rig2.mixer.existingAction(live2)!.time).toBeCloseTo(DT, 6)
  })

  it('never seeks past the end of the clip', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    const live = clip('live', 1, 80, 85)
    rig.director.beginUtterance(live)
    rig.ms += 5000
    rig.audio = true
    rig.frame()
    expect(rig.mixer.existingAction(live)!.time).toBeLessThanOrEqual(1)
    expect(rig.mixer.existingAction(live)!.time).toBeGreaterThan(0.9)
  })

  it('stays on its last frame when the voice stops with it, and the next sentence brings its own clip', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    const live = clip('live', 2, 80, 85)
    rig.director.beginUtterance(live)
    rig.audio = true
    rig.run(1.9)
    rig.audio = false // the voice stops just before the 2 s clip does
    rig.run(0.5)
    expect(rig.director.debugState().talk).toBe('live')
    expect(rig.director.debugState().entries.filter((e) => e.kind === 'talk')).toHaveLength(1)
    rig.run(3)
    expect(rig.director.isIdle).toBe(true)
  })

  it('a sentence without a live clip goes back to the rotating clips', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(3))
    rig.director.beginUtterance(clip('live', 3, 80, 85))
    rig.audio = true
    rig.run(1)
    expect(rig.director.debugState().talk).toBe('live')
    rig.audio = false
    rig.run(0.5)
    rig.director.beginUtterance(null)
    rig.audio = true
    rig.run(1)
    const talk = rig.director.debugState().talk
    expect(talk).not.toBe('live')
    expect(talk).toMatch(/^T\d/)
  })

  it('plays a live clip even when the library has no talk clips, and releases it afterwards', () => {
    const rig = new Rig().withIdle()
    const live = clip('live', 2, 80, 85)
    rig.director.beginUtterance(live)
    rig.audio = true
    rig.run(1)
    expect(rig.director.debugState().talk).toBe('live')
    expect(rig.director.idleWeight).toBeLessThan(1e-6)
    rig.audio = false
    rig.run(0.5)
    expect(rig.mixer.existingAction(live)).not.toBeNull()
    rig.run(MOTION.resumeWindow + 2)
    expect(rig.director.isIdle).toBe(true)
    expect(rig.mixer.existingAction(live)).toBeNull() // uncached: it was made for one sentence
    // ... and keeps the idle pose while the live clip runs out with speech still going on
    const rig2 = new Rig().withIdle()
    rig2.director.beginUtterance(clip('live', 1, 80, 85))
    rig2.run(4, true)
    expect(rig2.director.idleWeight).toBeCloseTo(1, 6)
  })

  it('does not release library clips', () => {
    const rig = new Rig().withIdle()
    const lib = talkLibrary(2)
    rig.director.setTalkClips(lib)
    rig.director.beginUtterance(null)
    rig.run(3, true)
    const used = rig.director.debugState().entries.find((e) => e.kind === 'talk')!
    const clipUsed = lib.find((c) => c.name === used.clip)!.clip
    rig.run(MOTION.resumeWindow + 2, false)
    expect(rig.mixer.existingAction(clipUsed)).not.toBeNull()
  })
})

describe('tag motions', () => {
  it('returns to the base pose first when another idle pose is showing, holding the motion on its first frame', async () => {
    const rig = new Rig(2).withIdle()
    rig.director.setIdleSources([{ id: 'b', getClip: async () => rig.idleB }])
    rig.run(1)
    expect(await rig.director.switchIdle()).toBe(true)
    rig.run(2) // fully on the variant
    expect(rig.director.debugState().idle).toBe('idleB')

    const wave = clip('wave', 2, 70, 75)
    const action = rig.mixer.clipAction(wave)
    let done = 0
    rig.director.playOneShot(action, () => done++)
    rig.frame()
    expect(action.paused).toBe(true) // settling: waits on its first frame
    expect(action.time).toBe(0)
    expect(rig.director.debugState().idle).toBe('idleA') // base pose
    rig.until(() => !action.paused, 5)
    rig.until(() => done === 1, 10)
    rig.until(() => rig.director.isIdle, 5)
    expect(rig.director.debugState().idle).toBe('idleA')
  })

  it('a new tag motion replaces the running one and completes its callback', () => {
    const rig = new Rig().withIdle()
    const a = rig.mixer.clipAction(clip('a', 3, 70, 75))
    const b = rig.mixer.clipAction(clip('b', 3, 76, 80))
    const calls: string[] = []
    rig.director.playOneShot(a, () => calls.push('a'))
    rig.run(1)
    rig.director.playOneShot(b, () => calls.push('b'))
    expect(calls).toEqual(['a'])
    rig.until(() => calls.length === 2, 10)
    expect(calls).toEqual(['a', 'b'])
  })

  it('stopOneShot fades the motion out at once and completes its callback exactly once', () => {
    const rig = new Rig().withIdle()
    const action = rig.mixer.clipAction(clip('a', 4, 70, 75))
    let done = 0
    rig.director.playOneShot(action, () => done++)
    rig.run(1)
    rig.director.stopOneShot()
    rig.director.stopOneShot()
    expect(done).toBe(1)
    expect(rig.director.oneShotActive).toBe(false)
    rig.run(1)
    expect(rig.director.idleWeight).toBeCloseTo(1, 9)
    expect(done).toBe(1)
  })

  it('replaying the same action restarts it', () => {
    const rig = new Rig().withIdle()
    const action = rig.mixer.clipAction(clip('a', 2, 70, 75))
    rig.director.playOneShot(action)
    rig.run(1.5)
    expect(action.time).toBeGreaterThan(1)
    rig.director.playOneShot(action)
    expect(action.time).toBe(0)
    rig.run(1)
    expect(action.time).toBeLessThan(1.2)
  })
})

describe('isIdle', () => {
  it('is true only when nothing is going on', async () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    rig.director.setIdleSources([{ id: 'b', getClip: async () => rig.idleB }])
    expect(rig.director.isIdle).toBe(true)
    rig.run(1)
    expect(rig.director.isIdle).toBe(true)

    // sound
    rig.director.beginUtterance(null)
    rig.frame(true)
    expect(rig.director.isIdle).toBe(false)
    rig.audio = false
    rig.until(() => rig.director.isIdle, 5)

    // one-shot
    rig.director.playOneShot(rig.mixer.clipAction(clip('w', 2, 70, 75)))
    expect(rig.director.isIdle).toBe(false)
    rig.until(() => rig.director.isIdle, 10)

    // external pose
    rig.director.setExternal(true)
    expect(rig.director.isIdle).toBe(false)
    rig.run(1)
    expect(rig.director.isIdle).toBe(false)
    rig.director.setExternal(false)
    rig.until(() => rig.director.isIdle, 5)

    // an idle cross-fade in progress
    expect(await rig.director.switchIdle()).toBe(true)
    rig.run(0.3)
    expect(rig.director.isIdle).toBe(false)
    rig.until(() => rig.director.isIdle, 5)

    // dance
    const dance = clip('d', 5, 90, 95)
    const action = rig.mixer.clipAction(dance)
    rig.director.playDance(action, 1)
    expect(rig.director.isIdle).toBe(false)
    rig.director.stopDance(0.5)
    rig.until(() => rig.director.isIdle, 5)
  })

  it('the sound must have been gone for longer than `release`', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    rig.director.beginUtterance(null)
    rig.run(1, true)
    // silent, but not for long enough yet
    rig.frame(false)
    expect(rig.director.isIdle).toBe(false)
    rig.until(() => rig.director.isIdle, 5, false)
    expect(rig.director.isIdle).toBe(true)
  })
})

describe('holdIdle', () => {
  it('stops the state from counting as idle and prevents switching idle poses', async () => {
    applyMotionTuning({ 'idleSwitch.0': 0.5, 'idleSwitch.1': 0.5 })
    const rig = new Rig().withIdle()
    rig.director.setIdleSources([{ id: 'b', getClip: async () => rig.idleB }])
    rig.director.holdIdle = true
    expect(rig.director.isIdle).toBe(false)
    expect(await rig.director.switchIdle()).toBe(false)
    expect(rig.director.debugState().idle).toBe('idleA')

    // automatic rotation is held too
    rig.run(3)
    await tick()
    expect(rig.director.debugState().idle).toBe('idleA')

    rig.director.holdIdle = false
    expect(rig.director.isIdle).toBe(true)
    const seen = new Set<string | null>()
    for (let i = 0; i < 60; i++) {
      rig.frame()
      await tick()
      seen.add(rig.director.debugState().idle)
    }
    expect(seen.has('idleB')).toBe(true)
  })
})

describe('idle poses', () => {
  it('rotates automatically once the interval is up and the body is idle, not while speaking', async () => {
    applyMotionTuning({ 'idleSwitch.0': 2, 'idleSwitch.1': 2 })
    const rig = new Rig(6).withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    rig.director.setIdleSources([{ id: 'b', getClip: async () => rig.idleB }])
    rig.director.beginUtterance(null)
    rig.audio = true
    const seenWhileTalking = new Set<string | null>()
    for (let i = 0; i < 60 * 5; i++) {
      rig.frame()
      await tick()
      seenWhileTalking.add(rig.director.debugState().idle)
    }
    expect([...seenWhileTalking]).toEqual(['idleA']) // the interval passed, but speech went on
    rig.audio = false
    const seenAfter = new Set<string | null>()
    for (let i = 0; i < 60 * 3; i++) {
      rig.frame()
      await tick()
      seenAfter.add(rig.director.debugState().idle)
    }
    expect(seenAfter.has('idleB')).toBe(true)
  })

  it('loads a variant lazily, once, and gives up quietly when it fails', async () => {
    const rig = new Rig().withIdle()
    let calls = 0
    rig.director.setIdleSources([
      {
        id: 'b',
        getClip: async () => {
          calls++
          return rig.idleB
        },
      },
    ])
    expect(calls).toBe(0)
    expect(await rig.director.switchIdle()).toBe(true)
    rig.run(2)
    expect(await rig.director.switchIdle()).toBe(true) // back to the base pose (no load)
    rig.run(2)
    expect(await rig.director.switchIdle()).toBe(true) // to b again: cached
    expect(calls).toBe(1)

    const broken = new Rig().withIdle()
    broken.director.setIdleSources([
      { id: 'x', getClip: async () => null },
      {
        id: 'y',
        getClip: async () => {
          throw new Error('boom')
        },
      },
    ])
    const warn = console.warn
    console.warn = () => {}
    try {
      for (let i = 0; i < 6; i++) {
        expect(await broken.director.switchIdle()).toBe(false)
        broken.run(0.1)
      }
    } finally {
      console.warn = warn
    }
    expect(broken.director.debugState().idle).toBe('idleA')
    expect(broken.director.isIdle).toBe(true)
  })

  it('does not switch when there is no variant, or when speech starts while the clip loads', async () => {
    const rig = new Rig().withIdle()
    expect(await rig.director.switchIdle()).toBe(false)
    let release: (c: THREE.AnimationClip) => void = () => {}
    rig.director.setIdleSources([
      { id: 'b', getClip: () => new Promise((resolve) => (release = resolve)) },
    ])
    rig.director.setTalkClips(talkLibrary(2))
    const pending = rig.director.switchIdle()
    rig.director.beginUtterance(null)
    rig.frame(true)
    release(rig.idleB)
    expect(await pending).toBe(false)
    expect(rig.director.debugState().idle).toBe('idleA')
  })

  it('resetIdle returns to the base pose; markExternalIdle takes the current one out of the rotation', async () => {
    const rig = new Rig().withIdle()
    rig.director.setIdleSources([{ id: 'b', getClip: async () => rig.idleB }])
    expect(await rig.director.switchIdle()).toBe(true)
    rig.run(2)
    expect(rig.director.debugState().idle).toBe('idleB')
    rig.director.resetIdle(0.5)
    rig.run(1)
    expect(rig.director.debugState().idle).toBe('idleA')
    rig.director.resetIdle() // already there: nothing happens
    expect(rig.director.isIdle).toBe(true)

    // a pose set from outside is not "b": the next switch may pick either the base pose or b
    const other = clip('dropped', 4, 65, 70)
    rig.director.setIdle(rig.mixer.clipAction(other), 0.5)
    rig.director.markExternalIdle()
    rig.run(1)
    expect(rig.director.debugState().idle).toBe('dropped')
    expect(await rig.director.switchIdle()).toBe(true)
    expect(['idleA', 'idleB']).toContain(rig.director.debugState().idle)
  })

  it('the first action given to setIdle is the base pose that speech returns to', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    rig.director.setIdle(rig.actionB, 0.5)
    rig.run(1)
    expect(rig.director.debugState().idle).toBe('idleB')
    rig.director.beginUtterance(null)
    rig.run(1, true)
    expect(rig.director.debugState().idle).toBe('idleA')
  })

  it('setIdle with no fade switches at once and does not repeat itself', () => {
    const rig = new Rig().withIdle()
    rig.director.setIdle(rig.actionB)
    rig.frame()
    expect(rig.director.idleWeight).toBeCloseTo(1, 9)
    expect(rig.director.debugState().entries.map((e) => e.clip)).toEqual(['idleB'])
    rig.director.setIdle(rig.actionB, 1)
    expect(rig.director.debugState().entries).toHaveLength(1)
  })
})

describe('dance', () => {
  it('reaches weight 1 after the fade-in and returns to 0 after the fade-out', () => {
    const rig = new Rig().withIdle()
    const dance = clip('dance', 8, 90, 95)
    const action = rig.mixer.clipAction(dance)
    let t = 0
    rig.onFrame = () => {
      action.time = Math.min(t, dance.duration)
      t += DT
    }
    rig.director.playDance(action, 1)
    const during: number[] = []
    for (let i = 0; i < 60 * 3; i++) {
      rig.frame()
      during.push(rig.director.danceWeight)
    }
    expect(during[0]).toBeGreaterThan(0)
    expect(during[during.length - 1]).toBeCloseTo(1, 9)
    expect(during.every((v, i) => i === 0 || v >= during[i - 1]! - 1e-12)).toBe(true)

    rig.director.stopDance(1.5)
    const after: number[] = []
    for (let i = 0; i < 60 * 2; i++) {
      rig.frame()
      after.push(rig.director.danceWeight)
    }
    expect(after.every((v, i) => i === 0 || v <= after[i - 1]! + 1e-12)).toBe(true)
    expect(after[after.length - 1]).toBe(0)
    expect(rig.director.idleWeight).toBeCloseTo(1, 9)
  })

  it('returns to the base pose before the dance fades in', async () => {
    const rig = new Rig(3).withIdle()
    rig.director.setIdleSources([{ id: 'b', getClip: async () => rig.idleB }])
    expect(await rig.director.switchIdle()).toBe(true)
    rig.run(2)
    const dance = clip('dance', 8, 90, 95)
    const action = rig.mixer.clipAction(dance)
    rig.director.playDance(action, 1)
    rig.frame()
    expect(rig.director.debugState().idle).toBe('idleA')
    expect(rig.director.danceWeight).toBe(0)
    rig.until(() => rig.director.danceWeight > 0.5, 5)
  })

  it('cancels a running tag motion and a stopDance without a dance does nothing', () => {
    const rig = new Rig().withIdle()
    rig.director.stopDance(1)
    let done = 0
    rig.director.playOneShot(rig.mixer.clipAction(clip('w', 4, 70, 75)), () => done++)
    rig.run(0.5)
    rig.director.playDance(rig.mixer.clipAction(clip('d', 8, 90, 95)), 0.5)
    expect(done).toBe(1)
    expect(rig.director.oneShotActive).toBe(false)
    rig.run(2)
    expect(rig.director.danceWeight).toBeCloseTo(1, 9)
  })
})

describe('tuning', () => {
  it('a shorter talkFade makes the hand-over between idle and talk faster', () => {
    const measure = (fade: number) => {
      applyMotionTuning({ talkFade: fade })
      const rig = new Rig().withIdle()
      rig.director.setTalkClips(talkLibrary(2))
      rig.director.beginUtterance(null)
      return rig.until(() => rig.director.idleWeight < 1e-6, 5, true)
    }
    const slow = measure(0.8)
    const fast = measure(0.1)
    expect(fast).toBeLessThan(slow / 3)
    expect(fast).toBeGreaterThan(0.09)
  })

  it('release decides how soon silence counts as not speaking', () => {
    applyMotionTuning({ release: 1 })
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    rig.director.beginUtterance(null)
    rig.run(1, true)
    rig.run(0.8, false)
    expect(rig.director.isIdle).toBe(false)
    expect(rig.director.idleWeight).toBeLessThan(1e-6) // still talking through the gap
    rig.run(1, false)
    rig.until(() => rig.director.isIdle, 5)
  })
})

describe('dispose', () => {
  it('stops its actions, completes a pending tag callback once and ignores later updates', () => {
    const rig = new Rig().withIdle()
    rig.director.setTalkClips(talkLibrary(2))
    rig.director.beginUtterance(null)
    rig.run(2, true)
    let done = 0
    rig.director.playOneShot(rig.mixer.clipAction(clip('w', 5, 70, 75)), () => done++)
    rig.run(0.5)
    const actions = rig.director.debugState().entries.map((e) => e.action)
    expect(actions.length).toBeGreaterThan(1)
    rig.director.dispose()
    rig.director.dispose()
    expect(done).toBe(1)
    expect(actions.every((a) => !a.isRunning())).toBe(true)
    expect(rig.director.debugState().entries).toHaveLength(0)
    rig.director.update(DT, true)
    expect(rig.director.debugState().entries).toHaveLength(0)
    expect(done).toBe(1)
  })

  it('a variant that finishes loading after dispose does nothing', async () => {
    const rig = new Rig().withIdle()
    let release: (c: THREE.AnimationClip) => void = () => {}
    rig.director.setIdleSources([
      { id: 'b', getClip: () => new Promise((resolve) => (release = resolve)) },
    ])
    const pending = rig.director.switchIdle()
    rig.director.dispose()
    release(rig.idleB)
    expect(await pending).toBe(false)
    expect(rig.actionB.isRunning()).toBe(false)
  })
})

describe('random events (fuzz)', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`keeps the invariants under random speech, tag motions, live clips, dances, idle switches and external poses (seed ${seed})`, async () => {
      const rig = new Rig(seed).withIdle()
      const rnd = seededRandom(seed * 7919)
      const { director } = rig
      director.setTalkClips(talkLibrary(3))
      const idleC = clip('idleC', 3, 40, 44)
      director.setIdleSources([
        { id: 'b', getClip: async () => rig.idleB },
        { id: 'c', getClip: async () => idleC },
      ])
      const oneShots = [
        clip('o1', 1.5, 70, 75),
        clip('o2', 3, 76, 80),
        clip('o3', 0.8, 66, 70),
      ].map((c) => rig.mixer.clipAction(c))
      const danceAction = rig.mixer.clipAction(clip('dance', 6, 90, 95))
      let external = false
      let events = 0
      let maxEntries = 0
      const counts: Record<string, number> = {}
      const note = (k: string) => {
        counts[k] = (counts[k] ?? 0) + 1
        events++
      }

      for (let i = 0; i < 60 * 300; i++) {
        const r = rnd()
        rig.label = `fuzz seed ${seed}, events so far: ${JSON.stringify(counts)}`
        if (r < 0.006) {
          rig.audio = !rig.audio
          if (rig.audio) {
            const liveClip = rnd() < 0.4 ? clip('live', 0.5 + rnd() * 4, 80, 85) : null
            director.beginUtterance(liveClip)
            note(liveClip ? 'speech+live' : 'speech')
          } else note('silence')
        } else if (r < 0.0085) {
          director.playOneShot(oneShots[Math.floor(rnd() * oneShots.length)]!)
          note('one-shot')
        } else if (r < 0.0095) {
          director.stopOneShot()
          note('stop one-shot')
        } else if (r < 0.0105 && !director.danceActive) {
          director.playDance(danceAction, 0.2 + rnd() * 1.5)
          note('dance')
        } else if (r < 0.0125 && director.danceActive) {
          director.stopDance(0.1 + rnd() * 1.5)
          note('stop dance')
        } else if (r < 0.0135) {
          external = !external
          director.setExternal(external)
          note('external')
        } else if (r < 0.0165) {
          void director.switchIdle()
          note('switch idle')
        } else if (r < 0.017) {
          director.resetIdle(rnd() * 1.5)
          note('reset idle')
        } else if (r < 0.0175) {
          director.holdIdle = !director.holdIdle
          note('hold')
        }
        rig.frame()
        maxEntries = Math.max(maxEntries, director.debugState().entries.length)
        if (i % 7 === 0) await tick()
      }
      expect(maxEntries).toBeLessThan(14) // nothing piles up
      expect(events).toBeGreaterThan(200)
      for (const k of [
        'speech',
        'speech+live',
        'silence',
        'one-shot',
        'dance',
        'stop dance',
        'external',
        'switch idle',
      ]) {
        expect(counts[k] ?? 0, k).toBeGreaterThan(0)
      }
      expect(rig.maxSumError).toBeLessThanOrEqual(1e-6)
    })
  }
})
