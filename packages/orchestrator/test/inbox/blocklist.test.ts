import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Blocklist, emptyBlocklist } from '../../src/inbox/blocklist.ts'
import { FakeClock, fakeBlockFile, type Logged } from './helpers.ts'

function make(content: string | null) {
  const clock = new FakeClock(1_000_000)
  const f = fakeBlockFile(content)
  const logs: Logged[] = []
  const list = new Blocklist(f.source, {
    now: clock.now,
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
  })
  return { clock, list, logs, ...f }
}

describe('matching', () => {
  it('matches a listed word as a lower-case substring of the raw text and returns the listed word', () => {
    const { list } = make('bad')
    expect(list.hit('this is BAD news')).toBe('bad')
    expect(list.hit('xbadx')).toBe('bad')
    expect(list.hit('fine')).toBeNull()
    expect(list.hit('')).toBeNull()
  })

  it('lower-cases listed words too', () => {
    const { list } = make('  Spoiler  ')
    expect(list.hit('no spoiler please')).toBe('spoiler')
    expect(list.hit('NO SPOILER')).toBe('spoiler')
  })

  it('sees through spacing and punctuation tricks by comparing letters and digits only', () => {
    const { list } = make('bad')
    expect(list.hit('b a d')).toBe('bad')
    expect(list.hit('b.a.d')).toBe('bad')
    expect(list.hit('B-A-D')).toBe('bad')
    expect(list.hit('b\u{a0}a\u{3000}d')).toBe('bad')
    expect(list.hit('b_a_d!!')).toBe('bad')
    expect(list.hit('b [dog] a d')).toBe('bad') // an emote code in between is removed too
    expect(list.hit('bxad')).toBeNull()
    expect(list.hit('ba')).toBeNull()
  })

  it('a listed word with spaces or punctuation matches its letters-and-digits form', () => {
    const { list } = make('ban word')
    expect(list.hit('banword')).toBe('ban word')
    expect(list.hit('BAN   WORD')).toBe('ban word')
    expect(list.hit('ban.word')).toBe('ban word')
  })

  it('a word with no letters or digits matches only as a raw substring', () => {
    const { list } = make('!!!')
    expect(list.hit('wow!!!')).toBe('!!!')
    expect(list.hit('wow!!')).toBeNull()
    expect(list.hit('anything else')).toBeNull() // the empty squeezed form must not match everything
    expect(list.hit('')).toBeNull()
  })

  it('tries the texts in order and, within a text, the words in file order', () => {
    const { list } = make('aaa\nbbb')
    expect(list.hit('has bbb and aaa')).toBe('aaa')
    expect(list.hit('clean', 'has bbb')).toBe('bbb')
    expect(list.hit('has aaa', 'has bbb')).toBe('aaa')
    expect(list.hit('has bbb', 'has aaa')).toBe('bbb')
    expect(list.hit()).toBeNull()
  })

  it('compares in code points: a word made of astral letters matches', () => {
    const astral = String.fromCodePoint(0x20000, 0x20001)
    const { list } = make(astral)
    expect(list.hit(`x${astral}y`)).toBe(astral)
    expect(list.hit(String.fromCodePoint(0x20000))).toBeNull()
  })

  it('emptyBlocklist never matches', () => {
    expect(emptyBlocklist.hit('anything', 'at all')).toBeNull()
  })
})

describe('parsing the list', () => {
  it('skips blank lines and # comment lines, trims, tolerates CRLF and a BOM', () => {
    const { list } = make(
      '\u{feff}# a comment\r\nfirst\r\n\r\n   second   \r\n  # indented comment\r\nthird\r\n'
    )
    expect(list.size).toBe(3)
    expect(list.hit('first')).toBe('first')
    expect(list.hit('second')).toBe('second')
    expect(list.hit('third')).toBe('third')
    expect(list.hit('a comment')).toBeNull()
    expect(list.hit('indented comment')).toBeNull()
  })

  it('a # inside a line does not make it a comment', () => {
    const { list } = make('a#b\n#c')
    expect(list.hit('xa#by')).toBe('a#b')
    expect(list.hit('#c')).toBeNull()
  })

  it('splits on the same line boundaries as the legacy reader, not only on newlines', () => {
    const { list } = make('one\rtwo\u{2028}three\u{85}four')
    expect(list.size).toBe(4)
  })

  it('an empty file is an empty list', () => {
    const { list } = make('')
    expect(list.size).toBe(0)
    expect(list.hit('anything')).toBeNull()
  })
})

describe('reloading', () => {
  it('re-reads only when the modification time changed, and looks at most every 5 seconds', () => {
    const { clock, list, file } = make('alpha')
    expect(list.hit('alpha')).toBe('alpha') // first use always looks (nothing changed yet)

    file.content = 'beta'
    file.mtimeMs = 2
    clock.advance(5000) // exactly 5 s since the look: not yet
    expect(list.hit('beta')).toBeNull()
    expect(list.hit('alpha')).toBe('alpha')

    clock.advance(1) // more than 5 s
    expect(list.hit('beta')).toBe('beta')
    expect(list.hit('alpha')).toBeNull()
  })

  it('does not reload when the content changed but the modification time did not', () => {
    const { clock, list, file } = make('alpha')
    list.hit('x')
    file.content = 'beta'
    clock.advance(60_000)
    expect(list.hit('beta')).toBeNull()
    expect(list.hit('alpha')).toBe('alpha')
  })

  it('the 5-second gap is measured from the last look, not from the last change', () => {
    const { clock, list, file } = make('alpha')
    list.hit('x') // look at t0
    clock.advance(4000)
    list.hit('x') // no look (4 s)
    file.content = 'beta'
    file.mtimeMs = 2
    clock.advance(1500) // 5.5 s since the look at t0
    expect(list.hit('beta')).toBe('beta')
  })

  it('a missing file is an empty list', () => {
    const { clock, list, file } = make('alpha')
    expect(list.hit('alpha')).toBe('alpha')
    file.content = null
    clock.advance(6000)
    expect(list.hit('alpha')).toBeNull()
    expect(list.size).toBe(0)
  })

  it('starts empty when the file does not exist yet, and picks it up when it appears', () => {
    const { clock, list, file } = make(null)
    expect(list.hit('alpha')).toBeNull()
    file.content = 'alpha'
    file.mtimeMs = 5
    clock.advance(6000)
    expect(list.hit('alpha')).toBe('alpha')
  })

  it('pins a legacy quirk: a file that comes back with exactly its old modification time is not noticed', () => {
    const { clock, list, file } = make('alpha')
    list.hit('x')
    file.content = null
    clock.advance(6000)
    expect(list.hit('alpha')).toBeNull()
    file.content = 'alpha' // restored, same mtime as before it vanished
    clock.advance(6000)
    expect(list.hit('alpha')).toBeNull() // still empty
    file.mtimeMs = 2
    clock.advance(6000)
    expect(list.hit('alpha')).toBe('alpha')
  })

  it('a source that throws keeps the previous list and warns', () => {
    const clock = new FakeClock()
    const logs: Logged[] = []
    let fail = false
    const list = new Blocklist(
      () => {
        if (fail) throw new Error('disk on fire')
        return { mtimeMs: 1, content: 'alpha' }
      },
      { now: clock.now, log: (level, msg, extra) => logs.push({ level, msg, extra }) }
    )
    expect(list.hit('alpha')).toBe('alpha')
    fail = true
    clock.advance(6000)
    expect(list.hit('alpha')).toBe('alpha')
    expect(logs.some((l) => l.level === 'warn')).toBe(true)
  })

  it('logs each successful load', () => {
    const { logs, clock, file, list } = make('a\nb')
    expect(logs.filter((l) => l.msg === 'blocklist loaded')).toHaveLength(1)
    file.mtimeMs = 9
    clock.advance(6000)
    list.hit('x')
    expect(logs.filter((l) => l.msg === 'blocklist loaded')).toHaveLength(2)
  })

  it('works when the clock starts at zero', () => {
    const clock = new FakeClock(0)
    const f = fakeBlockFile('alpha')
    const list = new Blocklist(f.source, { now: clock.now })
    expect(list.hit('alpha')).toBe('alpha')
    f.file.mtimeMs = 2
    f.file.content = 'beta'
    clock.advance(5001)
    expect(list.hit('beta')).toBe('beta')
  })

  it('the recheck interval can be changed', () => {
    const clock = new FakeClock()
    const f = fakeBlockFile('alpha')
    const list = new Blocklist(f.source, { now: clock.now, recheckMs: 100 })
    list.hit('x')
    f.file.content = 'beta'
    f.file.mtimeMs = 2
    clock.advance(101)
    expect(list.hit('beta')).toBe('beta')
  })
})

describe('Blocklist.fromFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inbox-blocklist-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a UTF-8 file with a BOM and CRLF line ends', () => {
    const path = join(dir, 'words.txt')
    writeFileSync(path, '\u{feff}# words\r\nbad\r\nspoiler\r\n', 'utf8')
    const list = Blocklist.fromFile(path)
    expect(list.size).toBe(2)
    expect(list.hit('B A D')).toBe('bad')
  })

  it('treats a missing file as an empty list', () => {
    const list = Blocklist.fromFile(join(dir, 'nope.txt'))
    expect(list.size).toBe(0)
    expect(list.hit('anything')).toBeNull()
  })

  it('reloads when the file changes and empties when it is deleted', () => {
    const path = join(dir, 'words.txt')
    writeFileSync(path, 'alpha\n', 'utf8')
    utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    const clock = new FakeClock()
    const list = Blocklist.fromFile(path, { now: clock.now })
    expect(list.hit('alpha')).toBe('alpha')

    writeFileSync(path, 'beta\n', 'utf8')
    utimesSync(path, new Date(1_700_000_100_000), new Date(1_700_000_100_000))
    clock.advance(6000)
    expect(list.hit('beta')).toBe('beta')
    expect(list.hit('alpha')).toBeNull()

    unlinkSync(path)
    clock.advance(6000)
    expect(list.hit('beta')).toBeNull()
    expect(list.size).toBe(0)
  })

  it('a read error other than "not found" keeps the previous list', () => {
    const path = join(dir, 'words.txt')
    writeFileSync(path, 'alpha\n', 'utf8')
    utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    const logs: Logged[] = []
    const clock = new FakeClock()
    const list = Blocklist.fromFile(path, {
      now: clock.now,
      log: (level, msg, extra) => logs.push({ level, msg, extra }),
    })
    expect(list.hit('alpha')).toBe('alpha')
    // Replace the file with a directory of the same name: stat still succeeds, reading fails (EISDIR).
    unlinkSync(path)
    mkdirSync(path)
    utimesSync(path, new Date(1_700_000_200_000), new Date(1_700_000_200_000)) // a different mtime for sure
    clock.advance(6000)
    expect(list.hit('alpha')).toBe('alpha')
    expect(logs.some((l) => l.level === 'warn')).toBe(true)
  })
})
