import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryWords } from '@shared/search-fold'
import { INDEX_FILE, SearchIndex } from './index'
import type { IndexedMessage } from './messages'

const dirs: string[] = []
const logs: { level: string; message: string }[] = []
const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  logs.push({ level, message })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  logs.length = 0
})

function tempFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-search-index-'))
  dirs.push(dir)
  return path.join(dir, INDEX_FILE)
}

const message = (pos: number, text: string, role: 'user' | 'agent' = 'agent'): IndexedMessage => ({
  pos,
  entryId: `e${pos}`,
  role,
  text,
})

/** Puts messages into a session and marks it current at `at`. */
function fill(index: SearchIndex, sessionId: string, at: number, messages: IndexedMessage[]): void {
  index.replace(sessionId, messages, at)
}

const find = (index: SearchIndex, query: string) =>
  index.find(queryWords(query)).map((c) => [c.sessionId, c.pos, c.matches])

describe.each([{ fts: true }, { fts: false }])('the search index (fts: $fts)', ({ fts }) => {
  const open = (file = tempFile()): SearchIndex => SearchIndex.open(file, log, { fts })

  it('matches every word within one message, ignoring case and accents', () => {
    const index = open()
    expect(index.hasFts).toBe(fts)
    fill(index, 's1', 10, [
      message(0, 'Fix the CAFÉ menu', 'user'),
      message(1, 'The menu of the cafe is fixed'),
      message(2, 'thanks, the menu looks right', 'user'),
    ])
    fill(index, 's2', 20, [message(0, 'Nothing else about the topic')])
    expect(find(index, 'cafe menu')).toEqual([['s1', 1, 2]])
    expect(find(index, 'MENU')).toEqual([['s1', 2, 3]])
    // The words of one query may sit in different messages of a session, but not in one message.
    expect(find(index, 'thanks fixed')).toEqual([])
    expect(find(index, 'zzzqqq')).toEqual([])
    expect(index.find([])).toEqual([])
    index.close()
  })

  it('lists the messages of one session that hold every word, oldest first', () => {
    const index = open()
    fill(index, 's1', 10, [
      message(0, 'Fix the CAFÉ menu', 'user'),
      message(1, 'Nothing here'),
      message(2, 'The menu of the cafe is fixed'),
      message(5, '搜索会话里的内容'),
    ])
    fill(index, 's2', 20, [message(0, 'another menu with a cafe')])
    expect(index.findIn('s1', ['cafe', 'menu'], 10)).toEqual({
      matches: [
        { pos: 0, entryId: 'e0', role: 'user' },
        { pos: 2, entryId: 'e2', role: 'agent' },
      ],
      capped: false,
    })
    // Words of one or two characters are found too, and another session's messages are not.
    expect(index.findIn('s1', ['会话'], 10).matches.map((m) => m.pos)).toEqual([5])
    expect(index.findIn('s1', ['cafe', 'thanks'], 10).matches).toEqual([])
    expect(index.findIn('missing', ['cafe'], 10).matches).toEqual([])
    expect(index.findIn('s1', [], 10)).toEqual({ matches: [], capped: false })
    index.close()
  })

  it('keeps the newest matches of a session when there are more than the limit', () => {
    const index = open()
    fill(
      index,
      's1',
      10,
      Array.from({ length: 5 }, (_, pos) => message(pos, `same word ${pos}`)),
    )
    const found = index.findIn('s1', ['word'], 3)
    expect(found.capped).toBe(true)
    expect(found.matches.map((m) => m.pos)).toEqual([2, 3, 4])
    expect(index.findIn('s1', ['word'], 5).capped).toBe(false)
    index.close()
  })

  it('finds short words and words of any script', () => {
    const index = open()
    fill(index, 's1', 10, [
      message(0, '搜索会话里的内容', 'user'),
      message(1, '令牌唯一性需要测试'),
      message(2, '한글 검색을 합니다'),
    ])
    // Two characters have no trigram, three or more do; both find the text.
    expect(find(index, '令牌')).toEqual([['s1', 1, 1]])
    expect(find(index, '令牌唯')).toEqual([['s1', 1, 1]])
    expect(find(index, '内容')).toEqual([['s1', 0, 1]])
    expect(find(index, '검색')).toEqual([['s1', 2, 1]])
    expect(find(index, '검색을')).toEqual([['s1', 2, 1]])
    // A long word and a short one in the same message.
    expect(find(index, '令牌 测试')).toEqual([['s1', 1, 1]])
    expect(find(index, '令牌 内容')).toEqual([])
    // Quotes and operators in a query are text.
    expect(find(index, '"a" OR b')).toEqual([])
    index.close()
  })

  it('returns the latest message and the number of messages per session, newest session first', () => {
    const index = open()
    fill(index, 'older', 10, [message(0, 'deploy now'), message(1, 'deploy later')])
    fill(index, 'newer', 30, [message(5, 'we deploy')])
    fill(index, 'middle', 20, [message(2, 'deploy'), message(3, 'no'), message(9, 'deploy done')])
    expect(find(index, 'deploy')).toEqual([
      ['newer', 5, 1],
      ['middle', 9, 2],
      ['older', 1, 2],
    ])
    index.close()
  })

  it('applies changes, and moves the mark only from the mark the session was at', () => {
    const index = open()
    // A session the write created gets its mark.
    index.apply('s1', { upserts: [message(0, 'first words')], removed: [] }, { from: null, to: 5 })
    expect(index.mark('s1')).toBe(5)
    index.apply('s1', { upserts: [message(1, 'second words')], removed: [] }, { from: 5, to: 6 })
    expect(index.mark('s1')).toBe(6)
    // The session was behind: the messages go in, the mark stays so a reconcile reads it again.
    index.apply('s1', { upserts: [message(2, 'third words')], removed: [] }, { from: 8, to: 9 })
    expect(index.mark('s1')).toBe(6)
    expect(find(index, 'words')).toEqual([['s1', 2, 3]])
    // A position that holds no message now loses its row.
    index.apply('s1', { upserts: [], removed: [0, 1] }, { from: 6, to: 7 })
    expect(find(index, 'words')).toEqual([['s1', 2, 1]])
    // A changed message is found by what it says now.
    index.apply('s1', { upserts: [message(2, 'edited text')], removed: [] }, { from: 7, to: 8 })
    expect(find(index, 'third')).toEqual([])
    expect(find(index, 'edited')).toEqual([['s1', 2, 1]])
    index.close()
  })

  it('replaces and removes whole sessions', () => {
    const index = open()
    fill(index, 's1', 1, [message(0, 'alpha beta')])
    fill(index, 's2', 2, [message(0, 'alpha gamma')])
    fill(index, 's1', 3, [message(0, 'delta only')])
    expect(find(index, 'alpha')).toEqual([['s2', 0, 1]])
    expect(find(index, 'delta')).toEqual([['s1', 0, 1]])
    index.remove(['s2'])
    expect(find(index, 'alpha')).toEqual([])
    expect([...index.marks()]).toEqual([['s1', 3]])
    // Read in again: cleared rows come back, idempotently.
    index.clear('s1')
    expect(find(index, 'delta')).toEqual([])
    index.add('s1', [message(0, 'delta only')])
    index.add('s1', [message(0, 'delta only')])
    expect(find(index, 'delta')).toEqual([['s1', 0, 1]])
    index.close()
  })

  it('shows the text around the first word, on one line, cut at both ends', () => {
    const index = open()
    const text = `${'intro '.repeat(30)}the needle is here\n\n  and ${'tail '.repeat(60)}`
    fill(index, 's1', 1, [message(4, text, 'user')])
    const [snippet] = index.snippets(queryWords('NEEDLE'), [{ sessionId: 's1', pos: 4 }])
    expect(snippet).toMatchObject({ sessionId: 's1', pos: 4, entryId: 'e4', role: 'user' })
    expect(snippet!.snippet.startsWith('…')).toBe(true)
    expect(snippet!.snippet.endsWith('…')).toBe(true)
    expect(snippet!.snippet).toContain('needle is here and tail')
    expect(snippet!.snippet).not.toMatch(/\s{2}|\n/)
    expect(index.snippets(queryWords('needle'), [{ sessionId: 's1', pos: 99 }])).toEqual([])
    index.close()
  })

  it('keeps its tables and marks across a reopen, and tells a build under way', () => {
    const file = tempFile()
    const index = open(file)
    fill(index, 's1', 7, [message(0, 'kept text')])
    expect(index.build()).toBeNull()
    index.setBuild({ done: 2, total: 9 })
    index.setBuild({ done: 3, total: 9 })
    expect(index.build()).toEqual({ done: 3, total: 9 })
    index.close()
    const again = open(file)
    expect(again.hasFts).toBe(fts)
    expect(find(again, 'kept')).toEqual([['s1', 0, 1]])
    expect(again.build()).toEqual({ done: 3, total: 9 })
    again.setBuild(null)
    expect(again.build()).toBeNull()
    again.close()
  })

  it('builds a file that is damaged, of another format or not an index again', () => {
    const garbage = tempFile()
    writeFileSync(garbage, 'this is not a database'.repeat(200))
    const fromGarbage = open(garbage)
    fill(fromGarbage, 's1', 1, [message(0, 'fresh')])
    expect(find(fromGarbage, 'fresh')).toEqual([['s1', 0, 1]])
    fromGarbage.close()
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true)

    const other = tempFile()
    const db = new DatabaseSync(other)
    db.exec("CREATE TABLE unrelated (x TEXT); INSERT INTO unrelated VALUES ('kept?')")
    db.close()
    const fromOther = open(other)
    expect(find(fromOther, 'kept')).toEqual([])
    fromOther.close()

    const newer = tempFile()
    const first = open(newer)
    first.close()
    const edit = new DatabaseSync(newer)
    edit.exec("UPDATE meta SET value = '999' WHERE key = 'format'")
    edit.close()
    const fromNewer = open(newer)
    fill(fromNewer, 's1', 1, [message(0, 'again')])
    expect(find(fromNewer, 'again')).toEqual([['s1', 0, 1]])
    fromNewer.close()
  })
})

describe('reading the search index from another connection', () => {
  it('opens only once the file is an index, and sees what the writer commits', () => {
    const file = tempFile()
    expect(SearchIndex.openReader(file, log)).toBeNull()
    const writer = SearchIndex.open(file, log)
    const reader = SearchIndex.openReader(file, log)!
    expect(find(reader, 'late')).toEqual([])
    fill(writer, 's1', 1, [message(0, 'late arrival')])
    expect(find(reader, 'late')).toEqual([['s1', 0, 1]])
    reader.close()
    writer.close()
  })
})
