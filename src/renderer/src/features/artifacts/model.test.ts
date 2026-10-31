import { describe, expect, it } from 'vitest'
import { NO_SESSION, type ArtifactSession, type ArtifactSummary } from '@shared/artifacts'
import {
  artifactKind,
  daysLeft,
  filterArtifacts,
  groupArtifacts,
  NO_PROJECT,
  parseOpened,
  presenceShown,
  projectsOf,
  recency,
  withAskLine,
  withOpened,
  type ArtifactGrouping,
  type ArtifactSort,
  type ListContext,
  type ListFilter,
  type OpenedTimes,
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
  imported: 'Imported',
  collator: new Intl.Collator('en', { numeric: true, sensitivity: 'base' }),
  opened: {},
}

const titles = (groups: ReturnType<typeof groupArtifacts>) =>
  groups.map((g) => g.sections.map((s) => s.artifacts.map((a) => a.title)))

const group = (
  list: ArtifactSummary[],
  grouping: ArtifactGrouping,
  sort: ArtifactSort = 'recent',
  opened: OpenedTimes = {},
) => groupArtifacts(list, grouping, sort, { ...context, opened })

describe('filterArtifacts', () => {
  const ALL: ListFilter = { title: '', kind: null, project: null }
  const list = [
    artifact({ title: 'Café menu' }),
    artifact({ title: 'Q3 Traffic report', project: '/work/deck' }),
    artifact({ title: 'Slides', pages: 3 }),
    artifact({ title: 'Scratch', project: '/data/scratch/scratch-1', scratch: true }),
  ]
  const titles = (filter: Partial<ListFilter>) =>
    filterArtifacts(list, { ...ALL, ...filter }).map((a) => a.title)

  it('matches the title case- and accent-insensitively', () => {
    expect(titles({ title: 'CAFE' })).toEqual(['Café menu'])
    expect(titles({ title: 'traffic' })).toEqual(['Q3 Traffic report'])
    expect(titles({ title: 'zz' })).toEqual([])
  })

  it('keeps everything for a blank filter', () => {
    expect(titles({ title: '  ' })).toHaveLength(4)
  })

  it('keeps one kind, a canvas being two or more pages', () => {
    expect(titles({ kind: 'canvas' })).toEqual(['Slides'])
    expect(titles({ kind: 'web' })).toEqual(['Café menu', 'Q3 Traffic report', 'Scratch'])
  })

  it('keeps one project, or No project', () => {
    expect(titles({ project: '/work/deck' })).toEqual(['Q3 Traffic report'])
    expect(titles({ project: NO_PROJECT })).toEqual(['Scratch'])
    expect(titles({ project: '/work/acme', kind: 'canvas' })).toEqual(['Slides'])
  })
})

describe('artifactKind', () => {
  it('reads two or more pages as a canvas', () => {
    expect(artifactKind(artifact({ pages: 1 }))).toBe('web')
    expect(artifactKind(artifact({ pages: 2 }))).toBe('canvas')
  })
})

describe('opened times', () => {
  it('takes the later of the open and the latest version', () => {
    const a = artifact({ updatedAt: NOW - HOUR })
    expect(recency(a, {})).toBe(NOW - HOUR)
    expect(recency(a, { [a.id]: NOW })).toBe(NOW)
    expect(recency(a, { [a.id]: NOW - DAY })).toBe(NOW - HOUR)
  })

  it('records an open, dropping artifacts no longer listed once the lists are known', () => {
    expect(withOpened({ a: 1, b: 2 }, 'c', 3, null)).toEqual({ a: 1, b: 2, c: 3 })
    expect(withOpened({ a: 1, b: 2 }, 'a', 5, null)).toEqual({ a: 5, b: 2 })
    expect(withOpened({ a: 1, b: 2 }, 'c', 3, new Set(['b', 'c']))).toEqual({ b: 2, c: 3 })
  })

  it('reads only well-formed stored times', () => {
    expect(parseOpened({ a: 1, b: 'x', c: Number.NaN, d: null })).toEqual({ a: 1 })
    expect(parseOpened(null)).toEqual({})
    expect(parseOpened([1, 2])).toEqual({})
  })
})

describe('withAskLine', () => {
  it("writes the line into an empty draft, and after a blank line under the user's text", () => {
    expect(withAskLine('', 'Make a web page artifact: ')).toBe('Make a web page artifact: ')
    expect(withAskLine('Notes so far\n\n', 'Make a canvas: ')).toBe(
      'Notes so far\n\nMake a canvas: ',
    )
  })
})

describe('projectsOf', () => {
  it('lists the projects with artifacts as the grouping orders them', () => {
    const list = [
      artifact({ project: '/work/acme' }),
      artifact({ project: '/data/scratch/scratch-1', scratch: true }),
      artifact({ project: '/old/zeta' }),
      artifact({ project: '/work/deck' }),
    ]
    expect(projectsOf(list, context)).toEqual([
      { kind: 'project', path: '/work/deck', name: 'deck' },
      { kind: 'project', path: '/work/acme', name: 'acme' },
      { kind: 'project', path: '/old/zeta', name: 'zeta' },
      { kind: 'no-project' },
    ])
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
    const groups = group(list, 'project-session')
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
    for (const sort of ['recent', 'updated', 'name'] as const) {
      expect(group(list, 'project-session', sort).map((g) => g.key)).toEqual([
        '/work/deck',
        '/work/acme',
      ])
    }
  })

  it('puts sessions under their project, by their most recent card, each with its cards', () => {
    const list = [
      artifact({ title: 'One', sessionId: 's1', updatedAt: NOW - 3 * HOUR }),
      artifact({ title: 'Two', sessionId: 's2', updatedAt: NOW - 5 * HOUR }),
      artifact({ title: 'Three', sessionId: 's1', updatedAt: NOW - HOUR }),
    ]
    const [acme] = group(list, 'project-session')
    expect(acme!.sections.map((s) => s.sessionId)).toEqual(['s1', 's2'])
    expect(titles(group(list, 'project-session'))).toEqual([[['Three', 'One'], ['Two']]])
    expect(acme!.count).toBe(3)
    const opened = group(list, 'project-session', 'recent', { [list[1]!.id]: NOW })
    expect(titles(opened)).toEqual([[['Two'], ['Three', 'One']]])
  })

  it('orders sessions by their own last update when sorted by update', () => {
    const list = [
      artifact({ sessionId: 's1', updatedAt: NOW - 3 * HOUR }),
      artifact({ sessionId: 's2', updatedAt: NOW - 5 * HOUR }),
    ]
    const updated = group(list, 'project-session', 'updated')[0]!.sections.map((s) => s.sessionId)
    expect(updated).toEqual(['s2', 's1'])
  })

  it('sorts sessions by title, and a deleted session by its name and newest artifact', () => {
    const list = [
      artifact({ sessionId: 's1' }),
      artifact({ sessionId: 's2' }),
      artifact({ sessionId: 'gone', updatedAt: NOW }),
    ]
    const byName = group(list, 'project-session', 'name')[0]!.sections.map((s) => s.sessionId)
    expect(byName).toEqual(['s2', 'gone', 's1'])
    const updated = group(list, 'project-session', 'updated')[0]!.sections.map((s) => s.sessionId)
    expect(updated).toEqual(['gone', 's2', 's1'])
  })

  it('puts what the user imported under its own label, by its newest artifact', () => {
    const list = [
      artifact({ sessionId: 's1' }),
      artifact({ sessionId: NO_SESSION, title: 'Mock', updatedAt: NOW }),
      artifact({ sessionId: 's3' }),
    ]
    expect(group(list, 'project-session')[0]!.sections.map((s) => s.sessionId)).toEqual([
      NO_SESSION,
      's1',
      's3',
    ])
    const byName = group(list, 'project-session', 'name')[0]!.sections.map((s) => s.sessionId)
    expect(byName).toEqual(['s1', NO_SESSION, 's3'])
  })

  it('sorts names in numeric order', () => {
    const list = ['Slide 10', 'slide 2', 'Slide 1'].map((title) => artifact({ title }))
    expect(titles(group(list, 'none', 'name'))).toEqual([[['Slide 1', 'slide 2', 'Slide 10']]])
  })

  it('puts the most recently opened or written first, or the latest version first', () => {
    const list = [
      artifact({ title: 'Middle', updatedAt: NOW - 2 * HOUR }),
      artifact({ title: 'New', updatedAt: NOW - HOUR }),
      artifact({ title: 'Old', updatedAt: NOW - 3 * HOUR }),
    ]
    expect(titles(group(list, 'none'))).toEqual([[['New', 'Middle', 'Old']]])
    const opened = { [list[2]!.id]: NOW }
    expect(titles(group(list, 'none', 'recent', opened))).toEqual([[['Old', 'New', 'Middle']]])
    expect(titles(group(list, 'none', 'updated', opened))).toEqual([[['New', 'Middle', 'Old']]])
  })

  it('shows one unlabelled grid when flat, and no group for nothing', () => {
    const list = [artifact({}), artifact({ project: '/work/deck' })]
    const groups = group(list, 'none')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.of).toEqual({ kind: 'all' })
    expect(groups[0]!.sections[0]!.sessionId).toBeNull()
    for (const grouping of ['project-session', 'none'] as const) {
      expect(group([], grouping)).toEqual([])
    }
  })
})

describe('daysLeft', () => {
  it('starts at 30 and never says less than one', () => {
    expect(daysLeft(NOW, NOW)).toBe(30)
    expect(daysLeft(NOW - HOUR, NOW)).toBe(30)
    expect(daysLeft(NOW - DAY - HOUR, NOW)).toBe(29)
    expect(daysLeft(NOW - 29 * DAY - HOUR, NOW)).toBe(1)
    expect(daysLeft(NOW - 31 * DAY, NOW)).toBe(1)
  })

  it('says 30 for a deletion newer than the clock the view last read', () => {
    expect(daysLeft(NOW + 40_000, NOW)).toBe(30)
  })
})

describe('presenceShown', () => {
  const session = (sessionId: string, editing = false): ArtifactSession => ({ sessionId, editing })

  it('shows nobody for none', () => {
    expect(presenceShown([])).toEqual({ all: [], shown: [], more: 0 })
  })

  it('puts the editing sessions first, each kind in the order they started', () => {
    const sessions = [session('a'), session('b', true), session('c'), session('d', true)]
    expect(presenceShown(sessions).all.map((s) => s.sessionId)).toEqual(['b', 'd', 'a', 'c'])
    expect(presenceShown(sessions).shown.map((s) => s.sessionId)).toEqual(['b', 'd'])
    expect(presenceShown(sessions).more).toBe(2)
  })

  it('shows the first one or two whole, and all three from three', () => {
    expect(presenceShown([session('a')])).toEqual({
      all: [session('a')],
      shown: [session('a')],
      more: 0,
    })
    const two = presenceShown([session('a'), session('b')])
    expect(two.shown.map((s) => s.sessionId)).toEqual(['a', 'b'])
    expect(two.more).toBe(0)
    const three = presenceShown([session('a'), session('b'), session('c')])
    expect(three.shown.map((s) => s.sessionId)).toEqual(['a', 'b', 'c'])
    expect(three.more).toBe(0)
  })

  it('shows two and counts the rest from four', () => {
    const four = presenceShown([session('a'), session('b'), session('c'), session('d')])
    expect(four.shown.map((s) => s.sessionId)).toEqual(['a', 'b'])
    expect(four.more).toBe(2)
    expect(four.all).toHaveLength(4)
    const five = presenceShown([
      session('a'),
      session('b'),
      session('c'),
      session('d'),
      session('e'),
    ])
    expect(five.shown.map((s) => s.sessionId)).toEqual(['a', 'b'])
    expect(five.more).toBe(3)
  })
})
