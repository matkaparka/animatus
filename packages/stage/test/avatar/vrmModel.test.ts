import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ModelState } from '@animatus/protocol'
import { LiveLayer } from '../../src/avatar/liveLayer.ts'
import { SmoothLookAt, attachGazeTarget } from '../../src/avatar/lookAt.ts'
import { describeVrm, disposeVrm, loadVrm } from '../../src/avatar/vrmModel.ts'
import { makeFakeVrm } from './fakeVrm.ts'
import { VRM_FIXTURE, buildVrmGlb } from './vrmFixture.ts'
import { buildVrmaGlb } from './vrmaFixture.ts'

describe('describeVrm', () => {
  it('counts distinct morph target names, not meshes or expressions', () => {
    const fake = makeFakeVrm({ arkitBlink: true, emotions: true, mouth: true })
    const names = Object.keys(fake.mesh.morphTargetDictionary!)
    expect(describeVrm(fake.vrm).blend_shapes).toBe(names.length)

    // a second mesh that shares some names and adds one
    const other = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    other.morphTargetDictionary = { [names[0]!]: 0, [names[1]!]: 1, extra: 2 }
    other.morphTargetInfluences = [0, 0, 0]
    fake.scene.add(other)
    expect(describeVrm(fake.vrm).blend_shapes).toBe(names.length + 1)

    expect(describeVrm(makeFakeVrm().vrm).blend_shapes).toBe(0)
  })

  it('reports the model version, the blink support and the spring joints', () => {
    const v1 = makeFakeVrm({ arkitBlink: true, metaVersion: '1' })
    expect(describeVrm(v1.vrm)).toEqual({
      vrm_version: '1',
      blend_shapes: 2,
      arkit_blink: true,
      vrm_blink: false,
      spring_joints: 0,
    })

    const v0 = makeFakeVrm({ vrmBlink: true, metaVersion: '0' })
    ;(v0.vrm as { springBoneManager?: unknown }).springBoneManager = { joints: new Set([1, 2, 3]) }
    expect(describeVrm(v0.vrm)).toEqual({
      vrm_version: '0',
      blend_shapes: 1,
      arkit_blink: false,
      vrm_blink: true,
      spring_joints: 3,
    })
  })

  it('has exactly the shape of model.state.info in the stage protocol', () => {
    for (const opts of [{ arkitBlink: true }, { vrmBlink: true, metaVersion: '0' as const }, {}]) {
      const info = describeVrm(makeFakeVrm(opts).vrm)
      const parsed = ModelState.parse({ type: 'model.state', status: 'ready', info })
      expect(parsed.info).toEqual(info)
    }
  })

  it('does not change the model', () => {
    const fake = makeFakeVrm({ arkitBlink: true, emotions: true })
    const before = JSON.stringify(fake.scene.toJSON?.() ?? null)
    describeVrm(fake.vrm)
    expect(JSON.stringify(fake.scene.toJSON?.() ?? null)).toBe(before)
  })
})

describe('disposeVrm', () => {
  it('releases the geometry, detaches the model and takes the gaze target off the camera', () => {
    const fake = makeFakeVrm()
    const stage = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    stage.add(camera)
    stage.add(fake.scene)
    const target = attachGazeTarget(fake.vrm, camera)
    let disposed = 0
    fake.mesh.geometry.addEventListener('dispose', () => disposed++)

    disposeVrm(fake.vrm)
    expect(disposed).toBe(1)
    expect(fake.scene.parent).toBeNull()
    expect(target.parent).toBeNull()
    expect(camera.children).not.toContain(target)
    expect(fake.vrm.lookAt?.target).toBeNull()
  })

  it('leaves a target that lives inside the model alone, and works without look-at', () => {
    const fake = makeFakeVrm()
    const inside = new THREE.Object3D()
    fake.scene.add(inside)
    fake.vrm.lookAt!.target = inside
    disposeVrm(fake.vrm)
    expect(fake.vrm.lookAt!.target).toBe(inside)

    expect(() => disposeVrm(makeFakeVrm({ lookAt: false }).vrm)).not.toThrow()
  })
})

describe('loadVrm', () => {
  let server: ReturnType<typeof createServer>
  let base = ''
  const hits: string[] = []

  beforeAll(async () => {
    const files: Record<string, Buffer> = {
      '/v1.vrm': Buffer.from(buildVrmGlb('1')),
      '/v0.vrm': Buffer.from(buildVrmGlb('0')),
      '/motion.vrma': Buffer.from(buildVrmaGlb()),
    }
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      const file = files[req.url ?? '']
      if (file) {
        res.writeHead(200, { 'content-type': 'model/gltf-binary' })
        res.end(file)
      } else if (req.url === '/hang.vrm') {
        res.writeHead(200, { 'content-type': 'model/gltf-binary' }) // never ends
      } else {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('loads a VRM1 model and reports it', async () => {
    const { vrm, info } = await loadVrm(`${base}/v1.vrm`)
    expect(info).toEqual({
      vrm_version: '1',
      blend_shapes: VRM_FIXTURE.morphs.length,
      arkit_blink: false,
      vrm_blink: true,
      spring_joints: 0,
    })
    expect(vrm.meta.metaVersion).toBe('1')
    expect(vrm.scene.name).toBe('VRMRoot')
    expect(vrm.scene.rotation.y).toBe(0)
    expect(ModelState.safeParse({ type: 'model.state', status: 'ready', info }).success).toBe(true)
    disposeVrm(vrm)
  })

  it('uses the smooth look-at and keeps the settings of the original', async () => {
    const { vrm } = await loadVrm(`${base}/v1.vrm`)
    expect(vrm.lookAt).toBeInstanceOf(SmoothLookAt)
    expect(vrm.lookAt!.offsetFromHeadBone.toArray()).toEqual([
      expect.closeTo(0),
      expect.closeTo(0.06),
      expect.closeTo(0),
    ])
    expect(vrm.lookAt!.faceFront.toArray()).toEqual([0, 0, 1])
    // and it works: attach a target, run a frame
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, 1.5, 3)
    attachGazeTarget(vrm, camera)
    expect(() => vrm.update(1 / 60)).not.toThrow()
    disposeVrm(vrm)
  })

  it('turns a VRM0 model to face +Z and keeps its -Z look-at front', async () => {
    const { vrm, info } = await loadVrm(`${base}/v0.vrm`)
    expect(info.vrm_version).toBe('0')
    expect(info.vrm_blink).toBe(true)
    expect(info.blend_shapes).toBe(2)
    expect(vrm.scene.rotation.y).toBeCloseTo(Math.PI, 9)
    expect(vrm.lookAt).toBeInstanceOf(SmoothLookAt)
    expect(vrm.lookAt!.faceFront.toArray()).toEqual([0, 0, -1])
    disposeVrm(vrm)
  })

  it('switches frustum culling off on every object', async () => {
    const { vrm } = await loadVrm(`${base}/v1.vrm`)
    let objects = 0
    vrm.scene.traverse((o) => {
      objects++
      expect(o.frustumCulled, o.name).toBe(false)
    })
    expect(objects).toBeGreaterThan(VRM_FIXTURE.boneCount)
    disposeVrm(vrm)
  })

  it('gives a model that the procedural layer can drive (blink fallback on the preset)', async () => {
    const { vrm } = await loadVrm(`${base}/v1.vrm`)
    const camera = new THREE.PerspectiveCamera()
    attachGazeTarget(vrm, camera)
    const layer = new LiveLayer(vrm, undefined, camera)
    expect(layer.blinkMode).toBe('vrm')
    let peak = 0
    let primitive: THREE.Mesh | undefined
    vrm.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.morphTargetInfluences) primitive ??= m
    })
    expect(primitive).toBeDefined()
    for (let i = 0; i < 60 * 30; i++) {
      layer.update(1 / 60, { emotion: 'neutral', idleWeight: 1, externalVolume: 0 })
      vrm.update(1 / 60)
      peak = Math.max(peak, primitive!.morphTargetInfluences![0]!)
    }
    expect(peak).toBeCloseTo(1, 6)
    layer.dispose()
    disposeVrm(vrm)
  })

  it('rejects for HTTP errors, files that are not a VRM, and files that are not glTF at all', async () => {
    await expect(loadVrm(`${base}/missing.vrm`)).rejects.toThrow(/HTTP 404/)
    await expect(loadVrm(`${base}/motion.vrma`)).rejects.toThrow(/not a VRM/)
    const junk = createServer((_req, res) => res.end(Buffer.from('this is not a model at all')))
    await new Promise<void>((resolve) => junk.listen(0, '127.0.0.1', resolve))
    try {
      await expect(
        loadVrm(`http://127.0.0.1:${(junk.address() as AddressInfo).port}/x.vrm`)
      ).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => junk.close(() => resolve()))
    }
  })

  it('rejects at once for a signal that is already aborted, without a request', async () => {
    const before = hits.length
    const controller = new AbortController()
    controller.abort()
    await expect(loadVrm(`${base}/v1.vrm`, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(hits.length).toBe(before)
  })

  it('aborts a request in flight', async () => {
    const controller = new AbortController()
    const pending = loadVrm(`${base}/hang.vrm`, { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not create an AudioContext or touch other globals', async () => {
    const g = globalThis as Record<string, unknown>
    const before = Object.keys(g).sort()
    const { vrm } = await loadVrm(`${base}/v1.vrm`)
    disposeVrm(vrm)
    expect(Object.keys(g).sort()).toEqual(before)
    expect(g['AudioContext']).toBeUndefined()
  })
})
