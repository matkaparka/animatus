// What may not be in this repository: the assets (3D models, motions, dances, music, voices, pictures, model weights) and
// anything big. They are not ours to distribute: models, motion packs and music carry licences that forbid it or that the
// user of this program must accept themselves (see THIRD_PARTY_NOTICES.md), and a repository that carries them is one that
// cannot be made public. Tests build their fixtures at run time (a few bytes, a generated tone, a 2x2 picture).

/** Extensions that are assets, by what they are. Compared case-insensitively. */
export const ASSET_EXTENSIONS = {
  model: ['vrm', 'glb', 'gltf', 'fbx', 'obj', 'blend', 'bvh', 'pmx', 'pmd', 'vmd', 'unitypackage'],
  motion: ['vrma'],
  audio: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'mid', 'midi'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'flv'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tga', 'tif', 'tiff', 'psd', 'ico', 'svg'],
  weights: ['onnx', 'pth', 'pt', 'ckpt', 'safetensors', 'npz', 'npy', 'gguf', 'tflite', 'h5'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  document: ['pdf'],
}

const KIND_OF = new Map(
  Object.entries(ASSET_EXTENSIONS).flatMap(([kind, exts]) => exts.map((e) => [e, kind]))
)

/** A file bigger than this is refused (lock files excepted): a repository this program lives in is small. */
export const MAX_BYTES = 1_000_000

/** Big files that are meant to be. Compared by base name. */
const BIG_OK = new Set(['package-lock.json', 'uv.lock'])

export function extensionOf(path) {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * What is wrong with this path, or null. `size` is in bytes, or null when it is not known (then only the name counts).
 * @returns {{ rule: 'asset' | 'large-file', description: string } | null}
 */
export function classify(path, size = null) {
  const kind = KIND_OF.get(extensionOf(path))
  if (kind !== undefined)
    return {
      rule: 'asset',
      description: `a ${kind} file (.${extensionOf(path)}): assets are not distributed with this repository; build test fixtures at run time`,
    }
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  if (size !== null && size > MAX_BYTES && !BIG_OK.has(base))
    return {
      rule: 'large-file',
      description: `${(size / 1e6).toFixed(1)} MB: files over ${MAX_BYTES / 1e6} MB do not belong here`,
    }
  return null
}

/** Turn a line of .assetscanignore (a glob: `*` within a segment, `**` across) into a regular expression. */
export function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*'
        i++
        if (g[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
