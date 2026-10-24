import { describe, expect, it } from 'vitest'
import type { ArtifactSummary } from '@shared/artifacts'
import {
  dateBucket,
  filterByTitle,
  groupArtifacts,
  sessionCount,
  type ArtifactGrouping,
  type ArtifactSort,
  type ListContext,
} from './model'

const NOW = new Date(2026, 9, 24, 15, 0).getTime()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let n = 0
function artifact(patch: Partial<ArtifactSummary>): ArtifactSummary {
  n++
  return {
    id: `art_${String(n).padStart(26, '0')}`,
    title: `Artifact ${n}`,
    project: '/work/acme',
    scratch: false,
    sessionId: 's1',
    version: 1,
    pages: 1,
    size: 100,
    updatedAt: NOW - n * HOUR,
    deletedAt: null,
    editing: [],
    ...patch,
  }
}

const SESSIONS: Record<string, { title: string; updatedAt: number }> = {
  s1: { title: 'Explore onboarding', updatedAt: NOW - 2 * HOUR },
  s2: { title: 'Build the deck', updatedAt: NOW - HOUR },
  s3: { title: 'Inbox sketch', updatedAt: NOW - 3 * HOUR },
}

const context: ListContext = {
  projects: [
    { path: '/work/deck', name: 'deck' },
    { path: '/work/acme', name: 'acme' },
  ],
  session: (id) => SESSIONS[id] ?? null,
  deletedSession: 'Deleted session',
  collator: new Intl.Collator('en', { numeric: true, sensitivity: 'base' }),
  now: NOW,
}

const titles = (groups: ReturnType<typeof groupArtifacts>) =>
  groups.map((g) => g.sections.map((s) => s.artifacts.map((a) => a.title)))

const group = (
  list: ArtifactSummary[],
  grouping: ArtifactGrouping,
  sort: ArtifactSort = 'newest',
) => groupArtifacts(list, grouping, sort, context)

describe('filterByTitle', () => {
  const list = [
    artifact({ title: 'Café menu' }),
    artifact({ title: 'Q3 Traffic report' }),
    artifact({ title: 'Slides' }),
  ]

  it('matches case- and accent-insensitively', () => {
    expect(filterByTitle(list, 'CAFE').map((a) => a.title)).toEqual(['Café menu'])
    expect(filterByTitle(list, 'traffic').map((a) => a.title)).toEqual(['Q3 Traffic report'])
  })

  it('keeps everything for a blank filter, and nothing for no match', () => {
    expect(filterByTitle(list, '  ')).toHaveLength(3)
    expect(filterByTitle(list, 'zz')).toEqual([])
  })
})

describe('dateBucket', () => {
  it.each([
    [NOW - HOUR, 'today'],
    [new Date(2026, 9, 24, 0, 1).getTime(), 'today'],
    [new Date(2026, 9, 23, 23, 59).getTime(), 'yesterday'],
    [NOW - 2 * DAY, 'week'],
    [NOW - 7 * DAY, 'week'],
    [NOW - 8 * DAY, 'month'],
    [NOW - 30 * DAY, 'month'],
    [NOW - 31 * DAY, 'older'],
  ])('puts %s in %s', (at, bucket) => {
    expect(dateBucket(at, NOW)).toBe(bucket)
  })
})

describe('groupArtifacts', () => {
  it("groups by project in the sidebar's order, then removed folders by name, then No project", () => {
    const list = [
      artifact({ title: 'Acme', project: '/work/acme' }),
      artifact({ title: 'Scratch', project: '/data/scratch/scratch-1', scratch: true }),
      artifact({ title: 'Zeta', project: '/old/zeta' }),
      artifact({ title: 'Alpha', project: '/old/alpha' }),
      artifact({ title: 'Deck', project: '/work/deck' }),
    ]
    const groups = group(list, 'project')
    expect(groups.map((g) => g.of)).toEqual([
      { kind: 'project', path: '/work/deck', name: 'deck' },
      { kind: 'project', path: '/work/acme', name: 'acme' },
      { kind: 'project', path: '/old/alpha', name: 'alpha' },
      { kind: 'project', path: '/old/zeta', name: 'zeta' },
      { kind: 'no-project' },
    ])
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1, 1, 1])
  })

  it('keeps the project order whatever the sort', () => {
    const list = [artifact({ project: '/work/acme' }), artifact({ project: '/work/deck' })]
    for (const sort of ['newest', 'oldest', 'name', 'name-desc'] as const) {
      expect(group(list, 'project', sort).map((g) => g.key)).toEqual(['/work/deck', '/work/acme'])
    }
  })

  it('puts sessions under their project, by their last update, each with its cards', () => {
    const list = [
      artifact({ title: 'One', sessionId: 's1', updatedAt: NOW - 3 * HOUR }),
      artifact({ title: 'Two', sessionId: 's2', updatedAt: NOW - 5 * HOUR }),
      artifact({ title: 'Three', sessionId: 's1', updatedAt: NOW - HOUR }),
    ]
    const [acme] = group(list, 'project-session')
    expect(acme!.sections.map((s) => s.sessionId)).toEqual(['s2', 's1'])
    expect(titles(group(list, 'project-session'))).toEqual([[['Two'], ['Three', 'One']]])
    expect(acme!.count).toBe(3)
    const oldest = group(list, 'project-session', 'oldest')
    expect(oldest[0]!.sections.map((s) => s.sessionId)).toEqual(['s1', 's2'])
  })

  it('sorts sessions by title, and a deleted session by its name and newest artifact', () => {
    const list = [
      artifact({ sessionId: 's1' }),
      artifact({ sessionId: 's2' }),
      artifact({ sessionId: 'gone', updatedAt: NOW }),
    ]
    const byName = group(list, 'project-session', 'name')[0]!.sections.map((s) => s.sessionId)
    expect(byName).toEqual(['s2', 'gone', 's1'])
    const newest = group(list, 'project-session')[0]!.sections.map((s) => s.sessionId)
    expect(newest).toEqual(['gone', 's2', 's1'])
  })

  it('sorts names in numeric order', () => {
    const list = ['Slide 10', 'slide 2', 'Slide 1'].map((title) => artifact({ title }))
    expect(titles(group(list, 'none', 'name'))).toEqual([[['Slide 1', 'slide 2', 'Slide 10']]])
    expect(titles(group(list, 'none', 'name-desc'))).toEqual([[['Slide 10', 'slide 2', 'Slide 1']]])
  })

  it('sorts by the latest version, newest or oldest first', () => {
    const list = [
      artifact({ title: 'Middle', updatedAt: NOW - 2 * HOUR }),
      artifact({ title: 'New', updatedAt: NOW - HOUR }),
      artifact({ title: 'Old', updatedAt: NOW - 3 * HOUR }),
    ]
    expect(titles(group(list, 'none'))).toEqual([[['New', 'Middle', 'Old']]])
    expect(titles(group(list, 'none', 'oldest'))).toEqual([[['Old', 'Middle', 'New']]])
  })

  it('groups by date, newest first unless sorted oldest first', () => {
    const list = [
      artifact({ title: 'Today', updatedAt: NOW - HOUR }),
      artifact({ title: 'Older', updatedAt: NOW - 90 * DAY }),
      artifact({ title: 'Week', updatedAt: NOW - 3 * DAY }),
    ]
    const buckets = (sort: ArtifactSort) =>
      group(list, 'date', sort).map((g) => (g.of.kind === 'date' ? g.of.bucket : null))
    expect(buckets('newest')).toEqual(['today', 'week', 'older'])
    expect(buckets('name')).toEqual(['today', 'week', 'older'])
    expect(buckets('oldest')).toEqual(['older', 'week', 'today'])
  })

  it('shows one unlabelled grid for None, and no group for nothing', () => {
    const list = [artifact({}), artifact({ project: '/work/deck' })]
    const groups = group(list, 'none')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.of).toEqual({ kind: 'all' })
    expect(groups[0]!.sections[0]!.sessionId).toBeNull()
    for (const grouping of ['project-session', 'project', 'date', 'none'] as const) {
      expect(group([], grouping)).toEqual([])
    }
  })
})

describe('sessionCount', () => {
  it('counts the sessions the artifacts show under', () => {
    expect(
      sessionCount([artifact({ sessionId: 'a' }), artifact({ sessionId: 'b' }), artifact({})]),
    ).toBe(3)
    expect(sessionCount([artifact({ sessionId: 'a' }), artifact({ sessionId: 'a' })])).toBe(1)
  })
})
