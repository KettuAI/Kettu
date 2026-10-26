import { describe, expect, it } from 'vitest'
import type { ArtifactEntry, GitEntry, SessionView, ThreadEntry, ThreadState } from '@shared/thread'
import {
  agentEntryBefore,
  artifactWrite,
  gitPatch,
  ReplayKeeper,
  startedPatch,
  writePatch,
  type ArtifactWrite,
} from './entries'

const ID = 'art_01JB2QZ8X4K7M9N3P5R6S8T0VW'
const OTHER = 'art_01JB2QZ8X4K7M9N3P5R6S8T0VX'
const ok = (structuredContent: Record<string, unknown>) => ({ content: [], structuredContent })
const titled = (title: string | null) => () => Promise.resolve(title)

function threadOf(entries: ThreadEntry[]): ThreadState {
  return {
    session: {} as SessionView,
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  }
}

const user = (id: string): ThreadEntry => ({ kind: 'user', id, content: [] })
const tool = (id: string): ThreadEntry => ({
  kind: 'tool',
  id,
  title: 'execute',
  toolKind: 'other',
  status: 'in_progress',
  content: [],
  locations: [],
  permission: null,
  permissionResult: null,
})
const turnEnd = (id: string, after?: string | null): ThreadEntry => ({
  kind: 'turn_end',
  id,
  stopReason: 'end_turn',
  durationMs: 1,
  ...(after === undefined ? {} : { after }),
})
/** The host's own notice records `after`; an agent's, and one stored before, has none. */
const notice = (id: string, after?: string | null): ThreadEntry => ({
  kind: 'notice',
  id,
  severity: 'error',
  title: 'Out of credit',
  ...(after === undefined ? {} : { after }),
})
const card = (id: string, fields: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
  kind: 'artifact',
  id,
  artifactId: ID,
  title: 'Deck',
  action: 'create',
  version: 1,
  writes: 1,
  after: null,
  ...fields,
})
/** A git event, without `after` when it was stored before git events recorded one. */
const git = (id: string, after?: string | null): GitEntry => ({
  kind: 'git',
  id,
  event: 'branch',
  branch: 'feature',
  ...(after === undefined ? {} : { after }),
})
const write = (fields: Partial<ArtifactWrite> = {}): ArtifactWrite => ({
  artifactId: ID,
  title: 'Deck',
  action: 'update',
  version: 2,
  ...fields,
})

describe('artifactWrite', () => {
  it('takes the title from the call or its result', async () => {
    expect(
      await artifactWrite(
        'create_artifact',
        { title: 'Deck', html: '' },
        ok({ id: ID, version: 1 }),
        titled(null),
      ),
    ).toEqual({ artifactId: ID, title: 'Deck', action: 'create', version: 1 })
    expect(
      await artifactWrite(
        'restore_artifact_version',
        { id: ID, version: 1 },
        ok({ id: ID, title: 'Deck', version: 4 }),
        titled(null),
      ),
    ).toEqual({ artifactId: ID, title: 'Deck', action: 'restore', version: 4 })
  })

  it('looks the title up otherwise, and a deletion has no version', async () => {
    expect(
      await artifactWrite(
        'update_artifact',
        { id: ID, html: '' },
        ok({ id: ID, version: 2 }),
        titled('Deck'),
      ),
    ).toEqual({ artifactId: ID, title: 'Deck', action: 'update', version: 2 })
    expect(
      await artifactWrite('delete_artifact', { id: ID }, ok({ id: ID }), titled('Deck')),
    ).toEqual({ artifactId: ID, title: 'Deck', action: 'delete', version: null })
  })

  it('makes none for a read, a failed call, or an artifact it cannot name', async () => {
    const failed = { ...ok({ code: 'conflict', message: '' }), isError: true }
    expect(await artifactWrite('update_artifact', {}, failed, titled('Deck'))).toBeNull()
    expect(
      await artifactWrite('read_artifact', { id: ID }, ok({ id: ID, version: 1 }), titled('Deck')),
    ).toBeNull()
    expect(
      await artifactWrite('list_artifacts', {}, ok({ artifacts: [] }), titled(null)),
    ).toBeNull()
    expect(await artifactWrite('update_artifact', {}, ok({ id: ID }), titled(null))).toBeNull()
  })
})

describe('writePatch', () => {
  const newId = () => 'a:9'

  it('adds an entry at the end, after the call that is running there', () => {
    const thread = threadOf([user('e:1'), tool('t:1')])
    expect(writePatch(thread, write({ action: 'create', version: 1 }), newId)).toEqual({
      op: 'entry.add',
      entry: card('a:9', { after: 't:1' }),
    })
  })

  it("updates the turn's entry for the same artifact in place", () => {
    const thread = threadOf([user('e:1'), tool('t:1'), card('a:2', { after: 't:1' }), tool('t:3')])
    expect(writePatch(thread, write({ title: 'Deck 2', version: 3 }), newId)).toEqual({
      op: 'entry.update',
      id: 'a:2',
      changes: { title: 'Deck 2', version: 3, writes: 2 },
    })
  })

  it('starts a new entry in a new turn, for another artifact, and for a deletion', () => {
    const earlier = threadOf([user('e:1'), card('a:2'), turnEnd('e:3'), user('e:4'), tool('t:5')])
    expect(writePatch(earlier, write(), newId)).toMatchObject({ op: 'entry.add' })
    const same = threadOf([user('e:1'), card('a:2'), tool('t:3')])
    expect(writePatch(same, write({ artifactId: OTHER }), newId)).toMatchObject({
      op: 'entry.add',
      entry: { artifactId: OTHER, after: 't:3' },
    })
    expect(writePatch(same, write({ action: 'delete', version: null }), newId)).toEqual({
      op: 'entry.add',
      entry: card('a:9', { action: 'delete', version: null, after: 't:3' }),
    })
    const deleted = threadOf([user('e:1'), card('a:2', { action: 'delete', version: null })])
    expect(writePatch(deleted, write(), newId)).toMatchObject({ op: 'entry.add' })
  })

  it("joins the latest turn's entry after the turn ended, skipping the host's own entries", () => {
    const thread = threadOf([user('e:1'), tool('t:2'), card('a:3'), turnEnd('e:4')])
    expect(writePatch(thread, write(), newId)).toMatchObject({ op: 'entry.update', id: 'a:3' })
    const other = writePatch(thread, write({ artifactId: OTHER }), newId)
    expect(other).toMatchObject({ op: 'entry.add', entry: { after: 't:2' } })
    expect(writePatch(threadOf([]), write(), newId)).toMatchObject({ entry: { after: null } })
  })

  it("anchors on an agent's notice, which records no after, as on any entry of the agent's", () => {
    const thread = threadOf([user('e:1'), tool('t:2'), notice('e:3'), notice('e:4', 't:2')])
    expect(writePatch(thread, write(), newId)).toMatchObject({ entry: { after: 'e:3' } })
  })
})

describe('ReplayKeeper', () => {
  it('puts each entry back after the one it followed', () => {
    const keeper = new ReplayKeeper(
      threadOf([
        user('e:1'),
        tool('t:2'),
        card('a:3', { after: 't:2' }),
        card('a:4', { after: 't:2' }),
      ]),
    )
    expect(keeper.before(user('m:1'))).toEqual([])
    expect(keeper.after(user('m:1'))).toEqual([])
    expect(keeper.after(tool('t:2')).map((e) => e.id)).toEqual(['a:3', 'a:4'])
    expect(keeper.rest()).toEqual([])
  })

  it('puts one whose entry never comes back at the end of its turn, or of the replay', () => {
    const keeper = new ReplayKeeper(
      threadOf([
        user('e:1'),
        tool('t:2'),
        card('a:3', { after: 't:gone' }),
        user('e:4'),
        card('a:5', { after: 't:also-gone' }),
      ]),
    )
    expect(keeper.before(user('m:1'))).toEqual([])
    expect(keeper.after(tool('t:2'))).toEqual([])
    expect(keeper.before(user('m:2')).map((e) => e.id)).toEqual(['a:3'])
    expect(keeper.rest().map((e) => e.id)).toEqual(['a:5'])
    expect(keeper.empty).toBe(true)
  })

  it('never anchors on an entry the host adds itself', () => {
    const keeper = new ReplayKeeper(threadOf([user('e:1'), card('a:2', { after: 'e:3' })]))
    expect(keeper.after(turnEnd('e:3'))).toEqual([])
    expect(new ReplayKeeper(threadOf([user('e:1'), tool('t:2')])).empty).toBe(true)
  })

  it('keeps a started session as it keeps an artifact', () => {
    const keeper = new ReplayKeeper(
      threadOf([
        user('e:1'),
        tool('t:2'),
        { kind: 'session_started', id: 'e:3', sessionId: 'child', after: 't:2' },
        { kind: 'session_started', id: 'e:4', sessionId: 'gone', after: 't:gone' },
      ]),
    )
    expect(keeper.after(tool('t:2')).map((e) => e.id)).toEqual(['e:3'])
    expect(keeper.rest().map((e) => e.id)).toEqual(['e:4'])
  })

  it("puts git events back after the entry they followed, in their tool call's order", () => {
    const keeper = new ReplayKeeper(
      threadOf([user('e:1'), tool('t:2'), git('g:1', 't:2'), git('g:2', 't:2'), turnEnd('e:3')]),
    )
    expect(keeper.before(user('m:1'))).toEqual([])
    expect(keeper.after(tool('t:2')).map((e) => e.id)).toEqual(['g:1', 'g:2'])
    expect(keeper.rest().map((e) => e.id)).toEqual(['e:3'])
  })

  it('puts a git event whose entry never comes back at the end of its turn', () => {
    const keeper = new ReplayKeeper(
      threadOf([user('e:1'), tool('t:2'), git('g:1', 't:gone'), user('e:3'), tool('t:4')]),
    )
    expect(keeper.before(user('m:1'))).toEqual([])
    expect(keeper.after(tool('t:2'))).toEqual([])
    expect(keeper.before(user('m:2')).map((e) => e.id)).toEqual(['g:1'])
    expect(keeper.empty).toBe(true)
  })

  it('puts a git event stored without the entry before it at the end of its turn', () => {
    const keeper = new ReplayKeeper(
      threadOf([user('e:1'), tool('t:2'), git('g:1'), user('e:3'), tool('t:4'), git('g:2')]),
    )
    expect(keeper.before(user('m:1'))).toEqual([])
    expect(keeper.after(tool('t:2'))).toEqual([])
    expect(keeper.before(user('m:2')).map((e) => e.id)).toEqual(['g:1'])
    expect(keeper.after(tool('t:4'))).toEqual([])
    expect(keeper.rest().map((e) => e.id)).toEqual(['g:2'])
  })

  it('puts a turn end back after the entry it followed', () => {
    const keeper = new ReplayKeeper(
      threadOf([user('e:1'), tool('t:2'), turnEnd('e:3', 't:2'), user('e:4'), tool('t:5')]),
    )
    expect(keeper.before(user('m:1'))).toEqual([])
    expect(keeper.after(tool('t:2')).map((e) => e.id)).toEqual(['e:3'])
    expect(keeper.empty).toBe(true)
  })

  it('puts a turn end at the end of its turn when its entry never comes back, or it has none', () => {
    const keeper = new ReplayKeeper(
      threadOf([
        user('e:1'),
        tool('t:2'),
        turnEnd('e:3', 't:gone'),
        user('e:4'),
        tool('t:5'),
        turnEnd('e:6'),
      ]),
    )
    expect(keeper.before(user('m:1'))).toEqual([])
    expect(keeper.after(tool('t:2'))).toEqual([])
    expect(keeper.before(user('m:2')).map((e) => e.id)).toEqual(['e:3'])
    expect(keeper.after(tool('t:5'))).toEqual([])
    expect(keeper.rest().map((e) => e.id)).toEqual(['e:6'])
  })

  it("keeps the host's notices, null after included, and leaves the agent's to the replay", () => {
    const keeper = new ReplayKeeper(
      threadOf([
        notice('e:1', null),
        user('e:2'),
        tool('t:3'),
        notice('e:4', 't:3'),
        notice('e:5'),
      ]),
    )
    expect(keeper.before(user('m:1')).map((e) => e.id)).toEqual(['e:1'])
    expect(keeper.after(tool('t:3')).map((e) => e.id)).toEqual(['e:4'])
    expect(keeper.empty).toBe(true)
  })

  it("puts a turn end back after the agent's notice that ended its turn", () => {
    const live = [user('e:1'), tool('t:2'), notice('e:3')]
    const keeper = new ReplayKeeper(
      threadOf([...live, turnEnd('e:4', agentEntryBefore(threadOf(live)))]),
    )
    // The replay sends the agent's notice again under a new id.
    const replay = [user('e:5'), tool('t:2'), notice('e:6')]
    const order = replay.flatMap((entry) => [
      ...keeper.before(entry),
      entry,
      ...keeper.after(entry),
    ])
    expect([...order, ...keeper.rest()].map((e) => e.id)).toEqual(['e:5', 't:2', 'e:6', 'e:4'])
  })
})

describe('gitPatch', () => {
  it("adds the event after the agent's entry before the thread's end", () => {
    const thread = threadOf([
      user('e:1'),
      tool('t:2'),
      card('a:3', { after: 't:2' }),
      turnEnd('e:4'),
    ])
    const draft = { kind: 'git', event: 'branch', branch: 'feature' } as const
    expect(gitPatch(thread, draft, () => 'g:5')).toEqual({
      op: 'entry.add',
      entry: git('g:5', 't:2'),
    })
    expect(gitPatch(threadOf([]), draft, () => 'g:1')).toEqual({
      op: 'entry.add',
      entry: git('g:1', null),
    })
  })
})

describe('startedPatch', () => {
  it('adds the started session after the agent entry before it', () => {
    const thread = threadOf([user('e:1'), tool('t:2'), turnEnd('e:3')])
    expect(startedPatch(thread, 'child', () => 'e:4')).toEqual({
      op: 'entry.add',
      entry: { kind: 'session_started', id: 'e:4', sessionId: 'child', after: 't:2' },
    })
  })
})
