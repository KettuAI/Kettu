import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { queryWords } from '@shared/search-fold'
import type { ThreadEntry } from '@shared/thread'
import { ThreadDb } from '../threads/db'
import type { ThreadWrite } from '../threads/model'
import { INDEX_FILE, SearchIndex } from './index'
import { Indexer } from './indexer'

const head = { agentId: 'claude-code', acpSessionId: 'acp-1' } as const
const dirs: string[] = []
const logs: string[] = []
const open: { close(): void }[] = []

afterEach(() => {
  for (const item of open.splice(0)) {
    try {
      item.close()
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  logs.length = 0
})

const say = (
  id: string,
  text: string,
  extra: Partial<Extract<ThreadEntry, { kind: 'user' }>> = {},
): ThreadEntry => ({
  kind: 'user',
  id,
  content: [{ type: 'text', text }],
  ...extra,
})
const reply = (id: string, markdown: string, streaming = false): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown,
  attachments: [],
  streaming,
})
const tool = (id: string): ThreadEntry => ({
  kind: 'tool',
  id,
  title: id,
  toolKind: 'read',
  status: 'completed',
  content: [],
  locations: [],
  permission: null,
  permissionResult: null,
})

interface Setup {
  db: ThreadDb
  index: SearchIndex
  indexer: Indexer
  idle: () => Promise<void>
  /** Writes to the thread database and applies it to the index, as the worker does. */
  write(sessionId: string, entries: ThreadWrite['entries'], replace?: boolean): void
  found(query: string): [string, number, number][]
}

let clock = 0

function setup(options: { start?: boolean } = {}): Setup {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-indexer-'))
  dirs.push(dir)
  const db = ThreadDb.open(
    path.join(dir, 'threads.db'),
    () => {},
    () => ++clock,
  )
  open.push(db)
  const file = path.join(dir, INDEX_FILE)
  const index = SearchIndex.open(file, (_level, message) => logs.push(message))
  let wake: () => void = () => {}
  const indexer = new Indexer(db, index, file, (_level, message) => logs.push(message), {
    startDelayMs: 0,
    retryMs: 5,
    sliceRestMs: 0,
    onIdle: () => wake(),
  })
  open.push({ close: () => indexer.stop() })
  const idle = (): Promise<void> => new Promise((resolve) => (wake = resolve))
  if (options.start) indexer.start()
  return {
    db,
    index,
    indexer,
    idle,
    write(sessionId, entries, replace) {
      const before = indexer.markBefore(sessionId)
      const change: ThreadWrite = { head, entries, ...(replace ? { replace } : {}) }
      db.write(sessionId, change)
      indexer.written(sessionId, change, before)
    },
    found: (query) =>
      indexer
        .current()
        .find(queryWords(query))
        .map((c) => [c.sessionId, c.pos, c.matches]),
  }
}

it('builds the index of threads written before it, newest first, and tells how far it is', async () => {
  const s = setup()
  for (let n = 0; n < 6; n++) {
    s.db.write(`s${n}`, {
      head,
      entries: [{ pos: 0, entry: say(`u${n}`, `question ${n} about indexing`) }],
    })
  }
  const progress: (number | null)[] = []
  const original = s.index.setBuild.bind(s.index)
  s.index.setBuild = (value) => {
    progress.push(value ? value.done : null)
    original(value)
  }
  const done = s.idle()
  s.indexer.start()
  await done
  expect(s.found('indexing').map(([id]) => id)).toEqual(['s5', 's4', 's3', 's2', 's1', 's0'])
  expect(s.index.build()).toBeNull()
  // Announced because it is more than a few sessions, and cleared at the end.
  expect(progress.at(0)).toBe(0)
  expect(progress.at(-1)).toBeNull()
  expect(new Map(s.db.threadMarks())).toEqual(s.index.marks())
})

it("reads a long session in ranges, tool output and Kettu's own messages left out", async () => {
  const s = setup({ start: true })
  const entries: ThreadWrite['entries'] = []
  for (let pos = 0; pos < 1_000; pos++) entries.push({ pos, entry: tool(`t${pos}`) })
  entries[3] = { pos: 3, entry: say('first', 'needle at the start', {}) }
  entries[200] = { pos: 200, entry: say('kettu', 'needle from Kettu', { kettu: true }) }
  entries[450] = { pos: 450, entry: reply('mid', 'needle in the middle') }
  entries[999] = { pos: 999, entry: reply('last', 'needle at the end') }
  s.db.write('long', { head, entries })
  await s.idle()
  expect(s.found('needle')).toEqual([['long', 999, 3]])
})

it('applies each write as it commits, once a reply is final', async () => {
  const s = setup({ start: true })
  await s.idle()
  s.write('s1', [{ pos: 0, entry: say('u0', 'please add search') }])
  s.write('s1', [{ pos: 1, entry: reply('a0', 'adding the sear', true) }])
  expect(s.found('search')).toEqual([['s1', 0, 1]])
  s.write('s1', [{ pos: 1, entry: reply('a0', 'added the search index') }])
  expect(s.found('search')).toEqual([['s1', 1, 2]])
  // The answer Kettu sends for a card and a message Kettu wrote itself are no messages of the
  // user's, and tool output is no text.
  s.write('s1', [
    { pos: 2, entry: say('u1', 'search approved', { approval: true }) },
    { pos: 3, entry: tool('t0') },
    { pos: 4, entry: say('u2', 'search reminder', { kettu: true }) },
  ])
  expect(s.found('approved')).toEqual([])
  expect(s.found('reminder')).toEqual([])
  // A reply written again with other words is found by them.
  s.write('s1', [{ pos: 1, entry: reply('a0', 'built the lookup') }])
  expect(s.found('index')).toEqual([])
  expect(s.found('lookup')).toEqual([['s1', 1, 1]])
  expect(s.indexer.current().mark('s1')).toBe(s.db.threadState('s1')!.updatedAt)
})

it('replaces a rewritten thread and drops a removed one', async () => {
  const s = setup({ start: true })
  await s.idle()
  s.write('s1', [{ pos: 0, entry: say('u0', 'old words') }])
  s.write('s1', [{ pos: 0, entry: say('v0', 'replayed words') }], true)
  expect(s.found('old')).toEqual([])
  expect(s.found('replayed')).toEqual([['s1', 0, 1]])
  s.db.remove(['s1'])
  s.indexer.removed(['s1'])
  expect(s.found('replayed')).toEqual([])
  expect(s.indexer.current().marks().size).toBe(0)
})

it('catches up on what an update missed, and drops what is gone, when it reconciles', async () => {
  const s = setup({ start: true })
  await s.idle()
  s.write('s1', [{ pos: 0, entry: say('u0', 'first message') }])
  // Written to the thread database but never applied, as after a crash.
  s.db.write('s1', { head, entries: [{ pos: 1, entry: say('u1', 'missed message') }] })
  // A later write that is applied cannot make the session look current.
  s.write('s1', [{ pos: 2, entry: say('u2', 'later message') }])
  expect(s.found('missed')).toEqual([])
  expect(s.indexer.current().mark('s1')).not.toBe(s.db.threadState('s1')!.updatedAt)
  // A thread the index still holds but the database lost.
  s.indexer
    .current()
    .replace('ghost', [{ pos: 0, entryId: 'g', role: 'user', text: 'ghost message' }], 1)
  const done = s.idle()
  s.indexer.recovered()
  await done
  expect(s.found('message').map(([id, pos, n]) => [id, pos, n])).toEqual([['s1', 2, 3]])
  expect(s.found('ghost')).toEqual([])
  expect(s.indexer.current().mark('s1')).toBe(s.db.threadState('s1')!.updatedAt)
})

it('does not stop for a failed update: it is logged and checked again', async () => {
  const s = setup({ start: true })
  await s.idle()
  s.write('s1', [{ pos: 0, entry: say('u0', 'kept message') }])
  const failing = s.indexer.current()
  failing.apply = () => {
    throw new Error('disk full')
  }
  const done = s.idle()
  s.write('s1', [{ pos: 1, entry: say('u1', 'missed message') }])
  expect(logs.some((line) => line.includes('disk full'))).toBe(true)
  delete (failing as { apply?: unknown }).apply
  await done
  expect(s.found('missed')).toEqual([['s1', 1, 1]])
})
