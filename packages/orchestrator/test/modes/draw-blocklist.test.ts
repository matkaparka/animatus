import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BlocklistUnavailable, DrawBlocklist, parseWords } from '../../src/modes/draw/blocklist.ts'

const FORGE = path.resolve(__dirname, '../../../../plugins/forge')
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'animatus-blocklist-'))
  dirs.push(d)
  return d
}
async function list(dir: string, name: string, ...words: string[]): Promise<string> {
  const file = path.join(dir, name)
  await writeFile(file, words.join('\n') + '\n', 'utf8')
  return file
}

describe('the words of a blocklist', () => {
  it('one per line; comments, blank lines, a BOM and any line ending are fine', () => {
    expect(parseWords('\u{feff}# comment\n\n  nsfw  \n#nude\r\nsex\rporn\u{2028}gore')).toEqual([
      'nsfw',
      'sex',
      'porn',
      'gore',
    ])
  })
})

describe('the shared cases: the image service answers the same', () => {
  it('every case', async () => {
    const shared = JSON.parse(await readFile(path.join(FORGE, 'blocklist_cases.json'), 'utf8')) as {
      words: string[]
      cases: { text: string; word: string | null }[]
    }
    const dir = await tmp()
    const bl = new DrawBlocklist([await list(dir, 'w.txt', ...shared.words)])
    expect(shared.cases.length).toBeGreaterThan(20)
    for (const c of shared.cases) expect(bl.hit(c.text), JSON.stringify(c.text)).toBe(c.word)
  })

  it('the list that ships flags what it should and leaves armour and dragons alone', () => {
    const bl = new DrawBlocklist([path.join(FORGE, 'blocklist.default.txt')])
    expect(bl.error).toBeNull()
    expect(bl.words).toBeGreaterThan(80)
    for (const bad of ['a nude woman', '色情图', 'see_through dress', 'NSFW', 'loli'])
      expect(bl.hit(bad), bad).not.toBeNull()
    for (const fine of [
      '一条在火山口睡觉的机械龙',
      'a knight in a breastplate',
      'Essex countryside',
      '穿着胸甲的壮汉',
      'a brave hero with a bracelet',
    ])
      expect(bl.hit(fine), fine).toBeNull()
  })
})

describe('matching', () => {
  it('several files are one list and every text is tried in order', async () => {
    const dir = await tmp()
    const bl = new DrawBlocklist([
      await list(dir, 'a.txt', 'alpha'),
      await list(dir, 'b.txt', 'beta'),
    ])
    expect(bl.words).toBe(2)
    expect(bl.hit('a beta thing')).toBe('beta')
    expect(bl.hit('gamma')).toBeNull()
    expect(bl.hit('nothing', 'so beta')).toBe('beta')
  })
})

describe('when the list cannot be used', () => {
  it('a missing file is an error, not an empty list, and it says which file', async () => {
    const dir = await tmp()
    const bl = new DrawBlocklist([path.join(dir, 'nope.txt')])
    expect(bl.error).toContain('nope.txt')
    expect(() => bl.hit('anything')).toThrow(BlocklistUnavailable)
    expect(() => bl.check()).toThrow(/cannot be used/)
  })

  it('one missing file among good ones breaks the whole list', async () => {
    const dir = await tmp()
    const bl = new DrawBlocklist([await list(dir, 'a.txt', 'alpha'), path.join(dir, 'gone.txt')])
    expect(() => bl.hit('alpha')).toThrow(BlocklistUnavailable)
  })

  it('a list without words is an error', async () => {
    const dir = await tmp()
    const bl = new DrawBlocklist([await list(dir, 'a.txt', '# only a comment')])
    expect(bl.error).toContain('no words')
  })

  it('text that is not UTF-8 is an error and is not read as something else', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'bad.txt')
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80, 0x81]))
    expect(new DrawBlocklist([file]).error).toContain('cannot be used')
  })

  it('an edited file is picked up after the recheck interval, a deleted one is an error until it is back', async () => {
    const dir = await tmp()
    let now = 0
    const file = await list(dir, 'a.txt', 'alpha')
    const bl = new DrawBlocklist([file], () => now, 5000)
    expect(bl.hit('beta')).toBeNull()

    await writeFile(file, 'alpha\nbeta\n', 'utf8')
    const later = new Date(Date.now() + 10_000)
    await utimes(file, later, later)
    expect(bl.hit('beta')).toBeNull() // not looked at yet
    now = 6000
    expect(bl.hit('beta')).toBe('beta')

    await unlink(file)
    now = 12_000
    expect(() => bl.hit('alpha')).toThrow(BlocklistUnavailable)
    await writeFile(file, 'gamma\n', 'utf8')
    now = 18_000
    expect(bl.hit('gamma')).toBe('gamma')
    expect(bl.error).toBeNull()
  })
})
