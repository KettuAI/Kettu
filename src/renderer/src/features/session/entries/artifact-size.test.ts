import { describe, expect, it } from 'vitest'
import type { ArtifactAction, ThreadEntry } from '@shared/thread'
import { artifactCardSize, isLastArtifactEntry } from './artifact-size'

const user = (id: string, steered = false): ThreadEntry => ({
  kind: 'user',
  id,
  content: [],
  ...(steered && { steered }),
})
const agent = (id: string): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown: '',
  attachments: [],
  streaming: false,
})
const end = (id: string): ThreadEntry => ({
  kind: 'turn_end',
  id,
  stopReason: 'end_turn',
  durationMs: 0,
})
const artifact = (id: string, artifactId: string, action: ArtifactAction): ThreadEntry => ({
  kind: 'artifact',
  id,
  artifactId,
  title: artifactId,
  action,
  version: action === 'delete' ? null : 1,
  writes: 1,
  after: null,
})

function thread(...entries: ThreadEntry[]) {
  return {
    order: entries.map((entry) => entry.id),
    byId: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
  }
}

describe('artifactCardSize', () => {
  it('draws large what a turn created when it is the only artifact the turn wrote', () => {
    const t = thread(user('u1'), agent('a1'), artifact('x', 'art_1', 'create'), end('e1'))
    expect(artifactCardSize(t, 'x')).toBe('large')
  })

  it('draws compact an update or a restore, even alone in its turn', () => {
    const t = thread(
      user('u1'),
      artifact('x', 'art_1', 'update'),
      user('u2'),
      artifact('y', 'art_2', 'restore'),
    )
    expect(artifactCardSize(t, 'x')).toBe('compact')
    expect(artifactCardSize(t, 'y')).toBe('compact')
  })

  it('draws compact every artifact of a turn that wrote several', () => {
    const t = thread(
      user('u1'),
      artifact('x', 'art_1', 'create'),
      agent('a1'),
      artifact('y', 'art_2', 'update'),
    )
    expect(artifactCardSize(t, 'x')).toBe('compact')
    expect(artifactCardSize(t, 'y')).toBe('compact')
  })

  it('leaves a deletion out of the count', () => {
    const t = thread(user('u1'), artifact('x', 'art_1', 'create'), artifact('d', 'art_2', 'delete'))
    expect(artifactCardSize(t, 'x')).toBe('large')
  })

  it('counts a steered message as part of the turn it was sent into', () => {
    const t = thread(
      user('u1'),
      artifact('x', 'art_1', 'create'),
      user('s1', true),
      artifact('y', 'art_2', 'create'),
    )
    expect(artifactCardSize(t, 'x')).toBe('compact')
  })

  it('starts a turn after a turn end, as the host does', () => {
    const t = thread(
      user('u1'),
      artifact('x', 'art_1', 'create'),
      end('e1'),
      artifact('y', 'art_2', 'create'),
    )
    expect(artifactCardSize(t, 'x')).toBe('large')
    expect(artifactCardSize(t, 'y')).toBe('large')
  })

  it('answers compact for an entry it does not know', () => {
    expect(artifactCardSize(thread(user('u1')), 'missing')).toBe('compact')
  })

  it('reads a thread again once an entry joins it', () => {
    const first = thread(user('u1'), artifact('x', 'art_1', 'create'))
    expect(artifactCardSize(first, 'x')).toBe('large')
    const later = thread(
      user('u1'),
      artifact('x', 'art_1', 'create'),
      artifact('y', 'art_2', 'create'),
    )
    expect(artifactCardSize(later, 'x')).toBe('compact')
  })
})

describe('isLastArtifactEntry', () => {
  it("is true only for an artifact's last entry in the thread", () => {
    const t = thread(
      user('u1'),
      artifact('x', 'art_1', 'create'),
      artifact('y', 'art_2', 'create'),
      user('u2'),
      artifact('z', 'art_1', 'update'),
    )
    expect(isLastArtifactEntry(t, 'x')).toBe(false)
    expect(isLastArtifactEntry(t, 'y')).toBe(true)
    expect(isLastArtifactEntry(t, 'z')).toBe(true)
    expect(isLastArtifactEntry(t, 'u1')).toBe(false)
  })
})
