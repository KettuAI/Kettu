import { describe, expect, it } from 'vitest'
import {
  decide,
  isUserVisible,
  issueBody,
  lastPublished,
  latestTag,
  missing,
  pullNumber,
  releaseOpen,
  releaseTarget,
  summary,
} from './release-check.mjs'

type Input = Parameters<typeof decide>[0]

const NOW = new Date('2026-11-01T12:00:00Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
const commits = (...subjects: string[]) => subjects.map((subject, i) => ({ sha: `c${i}`, subject }))
const fixes = (count: number) =>
  commits(...Array.from({ length: count }, (_, i) => `fix: change ${i + 1} (#${101 + i})`))

const base: Input = {
  now: NOW,
  lastTag: 'v0.0.1',
  commits: [],
  releases: [{ tag: 'v0.0.1', draft: false, publishedAt: hoursAgo(48) }],
  milestones: [
    { number: 1, title: 'v0.1.0', openIssues: 6 },
    { number: 4, title: 'v0.0.3', openIssues: 8 },
    { number: 3, title: 'v0.0.2', openIssues: 5 },
  ],
  openIssues: [{ number: 12, title: 'Use the installed agents' }],
  openPulls: [{ number: 52, title: 'fix(agents): run the installed claude and codex' }],
  closingIssues: {},
}
const input = (overrides: Partial<Input>): Input => ({ ...base, ...overrides })

describe('latestTag', () => {
  it('picks the highest version, comparing numbers', () => {
    expect(latestTag(['v0.0.9', 'v0.0.10', 'v0.0.2'])).toBe('v0.0.10')
    expect(latestTag(['v0.1.0', 'v0.0.12', 'v1.0.0'])).toBe('v1.0.0')
  })

  it('ignores tags that are not versions', () => {
    expect(latestTag(['v1.0.0-beta.1', 'nightly', 'v0.1', 'v0.0.3'])).toBe('v0.0.3')
  })

  it('returns null before the first release', () => {
    expect(latestTag([])).toBeNull()
    expect(latestTag(['nightly'])).toBeNull()
  })
})

describe('isUserVisible', () => {
  it('counts feat, fix and perf, with or without scope and breaking mark', () => {
    for (const subject of [
      'feat(usage): add a one-day range (#45)',
      'fix: close the model menu (#12)',
      'perf(thread)!: virtualize entries (#30)',
    ]) {
      expect(isUserVisible(subject), subject).toBe(true)
    }
  })

  it('leaves out docs, CI, refactors, other tasks and anything without a header', () => {
    for (const subject of [
      'docs(workflow): plan small patch iterations (#50)',
      'ci: check pull request titles and links (#27)',
      'chore(release): v0.0.2 (#60)',
      'refactor: split the store (#31)',
      'build: bump electron (#32)',
      'revert: feat: add login (#33)',
      'test: cover the mapper (#34)',
      'style: format (#35)',
      'Fix: close the menu',
      'Merge branch main',
    ]) {
      expect(isUserVisible(subject), subject).toBe(false)
    }
  })
})

describe('pullNumber', () => {
  it('reads the number the squash merge appends', () => {
    expect(pullNumber('fix(usage): show the agent switch under both sources (#26)')).toBe(26)
    expect(pullNumber('fix: handle (#3) and more (#24)')).toBe(24)
  })

  it('returns null without one at the end', () => {
    expect(pullNumber('fix: close the menu')).toBeNull()
    expect(pullNumber('fix: close the menu (#24) again')).toBeNull()
    expect(pullNumber('fix: close the menu (24)')).toBeNull()
  })
})

describe('lastPublished', () => {
  it('takes the latest published release and ignores drafts', () => {
    expect(
      lastPublished([
        { tag: 'v0.0.3', draft: true, publishedAt: null },
        { tag: 'v0.0.1', draft: false, publishedAt: '2026-10-23T04:12:08Z' },
        { tag: 'v0.0.2', draft: false, publishedAt: '2026-10-25T09:00:00Z' },
      ]),
    ).toEqual({ tag: 'v0.0.2', at: new Date('2026-10-25T09:00:00Z') })
  })

  it('returns null when nothing is published', () => {
    expect(lastPublished([])).toBeNull()
    expect(lastPublished([{ tag: 'v0.0.1', draft: true, publishedAt: null }])).toBeNull()
  })
})

describe('releaseTarget', () => {
  it('takes the earliest open patch milestone after the last tag', () => {
    expect(releaseTarget(base.milestones, 'v0.0.1')).toEqual({
      version: 'v0.0.2',
      milestone: { number: 3, title: 'v0.0.2', openIssues: 5 },
      minor: false,
    })
    expect(
      releaseTarget(
        [
          { number: 9, title: 'v0.0.10', openIssues: 1 },
          { number: 8, title: 'v0.0.9', openIssues: 4 },
        ],
        'v0.0.8',
      ),
    ).toMatchObject({ version: 'v0.0.9' })
  })

  it('skips a milestone left open at or before the last tag, and titles that are not versions', () => {
    expect(
      releaseTarget(
        [
          { number: 2, title: 'Backlog', openIssues: 40 },
          { number: 3, title: 'v0.0.2', openIssues: 1 },
          { number: 7, title: 'v0.0', openIssues: 1 },
          { number: 4, title: 'v0.0.3', openIssues: 8 },
        ],
        'v0.0.2',
      ),
    ).toMatchObject({ version: 'v0.0.3', milestone: { number: 4 } })
  })

  it('takes the minor once nothing is left before it and its issues have closed', () => {
    expect(
      releaseTarget(
        [
          { number: 10, title: 'v0.1.1', openIssues: 3 },
          { number: 1, title: 'v0.1.0', openIssues: 0 },
        ],
        'v0.0.5',
      ),
    ).toEqual({
      version: 'v0.1.0',
      milestone: { number: 1, title: 'v0.1.0', openIssues: 0 },
      minor: true,
    })
  })

  it('names the problem when no version fits', () => {
    expect(
      releaseTarget(
        [
          { number: 10, title: 'v0.1.1', openIssues: 3 },
          { number: 1, title: 'v0.1.0', openIssues: 2 },
        ],
        'v0.0.5',
      ),
    ).toEqual({
      problem: 'No patch milestone is open before v0.1.0, which still has 2 open issues.',
    })
    expect(releaseTarget([{ number: 1, title: 'v0.1.0', openIssues: 1 }], 'v0.0.5')).toEqual({
      problem: 'No patch milestone is open before v0.1.0, which still has 1 open issue.',
    })
    expect(releaseTarget([], 'v0.0.1')).toEqual({
      problem: 'No open milestone is planned after v0.0.1.',
    })
    expect(releaseTarget([], null)).toEqual({ problem: 'No open milestone is planned.' })
  })

  it('considers every milestone before the first tag', () => {
    expect(
      releaseTarget(
        [
          { number: 1, title: 'v0.1.0', openIssues: 6 },
          { number: 2, title: 'v0.0.1', openIssues: 3 },
        ],
        null,
      ),
    ).toMatchObject({ version: 'v0.0.1' })
  })
})

describe('releaseOpen', () => {
  it('returns null when no release is under way', () => {
    expect(releaseOpen(base)).toBeNull()
    expect(releaseOpen(input({ lastTag: null, releases: [] }))).toBeNull()
  })

  it('finds an open release issue by its title', () => {
    expect(
      releaseOpen(
        input({ openIssues: [...base.openIssues, { number: 61, title: 'Release v0.0.2' }] }),
      ),
    ).toBe('#61, "Release v0.0.2", is open.')
    expect(
      releaseOpen(
        input({
          openIssues: [
            { number: 70, title: 'Release view crashes' },
            { number: 71, title: 'Plan the Release v0.0.2 notes' },
          ],
        }),
      ),
    ).toBeNull()
  })

  it('finds an open release pull request', () => {
    expect(
      releaseOpen(
        input({ openPulls: [...base.openPulls, { number: 60, title: 'chore(release): v0.0.2' }] }),
      ),
    ).toBe('#60, "chore(release): v0.0.2", is open.')
    expect(
      releaseOpen(input({ openPulls: [{ number: 62, title: 'chore: release notes' }] })),
    ).toBeNull()
  })

  it('finds a release that merged but is not tagged yet', () => {
    expect(
      releaseOpen(input({ commits: commits('fix: a (#58)', 'chore(release): v0.0.2 (#60)') })),
    ).toBe('"chore(release): v0.0.2 (#60)" has merged but is not tagged yet.')
  })

  it('finds a tag that is not published yet, whether its draft is visible or not', () => {
    const published = base.releases
    expect(
      releaseOpen(
        input({
          lastTag: 'v0.0.2',
          releases: [{ tag: 'v0.0.2', draft: true, publishedAt: null }, ...published],
        }),
      ),
    ).toBe('v0.0.2 is tagged but not published yet.')
    expect(releaseOpen(input({ lastTag: 'v0.0.2', releases: published }))).toBe(
      'v0.0.2 is tagged but not published yet.',
    )
  })
})

describe('decide', () => {
  it('opens nothing when no trigger has fired', () => {
    const decision = decide(
      input({ commits: commits('fix: a (#24)', 'docs: b (#25)', 'fix: c (#26)') }),
    )
    expect(decision).toMatchObject({
      outcome: 'none',
      fired: [],
      held: [],
      changes: commits('fix: a (#24)', 'docs: b (#25)', 'fix: c (#26)').filter((_, i) => i !== 1),
      target: { version: 'v0.0.2' },
      releaseOpen: null,
    })
  })

  it('fires Count at 10 user-visible changes, not 9', () => {
    expect(decide(input({ commits: fixes(10) }))).toMatchObject({
      outcome: 'open',
      fired: [{ name: 'Count', detail: '10 user-visible changes have merged since v0.0.1.' }],
    })
    const nine = [...fixes(9), ...commits('docs: a (#90)', 'ci: b (#91)', 'chore: c (#92)')]
    expect(decide(input({ commits: nine }))).toMatchObject({ outcome: 'none', fired: [] })
  })

  it('holds Count until 24 hours after the previous release', () => {
    const recent = [{ tag: 'v0.0.1', draft: false, publishedAt: hoursAgo(23) }]
    expect(decide(input({ commits: fixes(12), releases: recent }))).toMatchObject({
      outcome: 'none',
      fired: [],
      held: [{ name: 'Count', detail: '12 user-visible changes have merged since v0.0.1.' }],
    })
    const day = [{ tag: 'v0.0.1', draft: false, publishedAt: hoursAgo(24) }]
    expect(decide(input({ commits: fixes(12), releases: day }))).toMatchObject({
      outcome: 'open',
      fired: [{ name: 'Count' }],
      held: [],
    })
  })

  it('fires Time 7 days after the last release when a user-visible change has merged', () => {
    const week = [{ tag: 'v0.0.1', draft: false, publishedAt: hoursAgo(7 * 24) }]
    expect(decide(input({ commits: fixes(1), releases: week }))).toMatchObject({
      outcome: 'open',
      fired: [
        {
          name: 'Time',
          detail:
            '7 days have passed since v0.0.1 was published, and 1 user-visible change has merged since.',
        },
      ],
    })
    expect(
      decide(input({ commits: commits('docs: a (#1)', 'ci: b (#2)'), releases: week })),
    ).toMatchObject({ outcome: 'none', fired: [] })
    const almost = [{ tag: 'v0.0.1', draft: false, publishedAt: hoursAgo(7 * 24 - 1) }]
    expect(decide(input({ commits: fixes(3), releases: almost }))).toMatchObject({
      outcome: 'none',
      fired: [],
    })
  })

  it('fires Urgent at once for a merged fix of an urgent issue', () => {
    const decision = decide(
      input({
        releases: [{ tag: 'v0.0.1', draft: false, publishedAt: hoursAgo(1) }],
        commits: commits('docs: a (#28)', 'fix(session): keep threads on crash (#30)'),
        closingIssues: {
          28: [{ number: 27, labels: ['urgent'] }],
          30: [
            { number: 29, labels: ['area:session', 'urgent'] },
            { number: 31, labels: ['regression'] },
          ],
        },
      }),
    )
    expect(decision).toMatchObject({
      outcome: 'open',
      fired: [{ name: 'Urgent', detail: '#28 closed urgent #27; #30 closed urgent #29.' }],
    })
  })

  it('ignores pull requests that close no urgent issue', () => {
    expect(
      decide(
        input({
          commits: commits('fix: a (#30)', 'fix: b'),
          closingIssues: { 30: [{ number: 29, labels: ['regression'] }] },
        }),
      ),
    ).toMatchObject({ outcome: 'none', fired: [] })
  })

  it('names every trigger that fired, Urgent first', () => {
    const decision = decide(
      input({
        releases: [{ tag: 'v0.0.1', draft: false, publishedAt: hoursAgo(8 * 24) }],
        commits: fixes(10),
        closingIssues: { 105: [{ number: 40, labels: ['urgent'] }] },
      }),
    )
    expect(decision.fired.map((trigger) => trigger.name)).toEqual(['Urgent', 'Count', 'Time'])
  })

  it('opens nothing while a release is open', () => {
    expect(
      decide(input({ commits: fixes(10), openIssues: [{ number: 61, title: 'Release v0.0.2' }] })),
    ).toMatchObject({
      outcome: 'release-open',
      fired: [{ name: 'Count' }],
      releaseOpen: '#61, "Release v0.0.2", is open.',
    })
  })

  it('reports a fired trigger without a planned version', () => {
    const milestones = [{ number: 1, title: 'v0.1.0', openIssues: 3 }]
    expect(decide(input({ commits: fixes(10), milestones }))).toMatchObject({
      outcome: 'no-version',
      target: {
        problem: 'No patch milestone is open before v0.1.0, which still has 3 open issues.',
      },
    })
    expect(decide(input({ commits: fixes(2), milestones }))).toMatchObject({ outcome: 'none' })
  })

  it('counts from the first commit before any release, and never fires Time', () => {
    const first = { lastTag: null, releases: [] }
    expect(decide(input({ ...first, commits: fixes(10) }))).toMatchObject({
      outcome: 'open',
      lastPublished: null,
      fired: [
        { name: 'Count', detail: '10 user-visible changes have merged since the first commit.' },
      ],
    })
    expect(decide(input({ ...first, commits: fixes(9) }))).toMatchObject({ outcome: 'none' })
  })
})

describe('issueBody', () => {
  it('names the triggers and the version, and lists the user-visible changes', () => {
    const decision = decide(
      input({
        releases: [{ tag: 'v0.0.1', draft: false, publishedAt: hoursAgo(1) }],
        commits: commits(
          'feat(usage): add a one-day range (#45)',
          'docs: explain the release (#46)',
          'fix(session): keep threads on crash (#30)',
        ),
        closingIssues: { 30: [{ number: 29, labels: ['urgent'] }] },
      }),
    )
    expect(issueBody(decision)).toBe(
      [
        'The Urgent trigger fired: #30 closed urgent #29.',
        '',
        'The version is v0.0.2, the earliest open patch milestone. The steps are in [release](https://github.com/overbench/overbench/blob/main/docs/workflow.md#6-release).',
        '',
        'User-visible changes since v0.0.1:',
        '',
        '- feat(usage): add a one-day range (#45)',
        '- fix(session): keep threads on crash (#30)',
        '',
      ].join('\n'),
    )
  })

  it('lists several triggers and says why a minor is next', () => {
    const decision = decide(
      input({
        lastTag: 'v0.0.5',
        releases: [{ tag: 'v0.0.5', draft: false, publishedAt: hoursAgo(8 * 24) }],
        milestones: [
          { number: 1, title: 'v0.1.0', openIssues: 0 },
          { number: 10, title: 'v0.1.1', openIssues: 2 },
        ],
        commits: fixes(10),
      }),
    )
    const body = issueBody(decision)
    expect(body).toContain(
      [
        'Triggers that fired:',
        '',
        '- Count: 10 user-visible changes have merged since v0.0.5.',
        '- Time: 8 days have passed since v0.0.5 was published, and 10 user-visible changes have merged since.',
        '',
        'The version is v0.1.0, as no patch milestone is left before it and its issues have all closed.',
      ].join('\n'),
    )
    expect(body).toContain('User-visible changes since v0.0.5:\n\n- fix: change 1 (#101)\n')
  })
})

describe('summary', () => {
  it('says what it found and why nothing opens', () => {
    expect(
      summary(
        decide(
          input({
            releases: [{ tag: 'v0.0.1', draft: false, publishedAt: '2026-11-01T00:00:00Z' }],
            commits: [...fixes(10), ...commits('docs: a (#200)')],
          }),
        ),
      ),
    ).toEqual([
      'Last release: v0.0.1, published 2026-11-01T00:00:00Z.',
      'Since v0.0.1: 11 commits, 10 user-visible.',
      'Version: v0.0.2, the earliest open patch milestone.',
      'Held: Count, 10 user-visible changes have merged since v0.0.1. It can fire from 2026-11-02T00:00:00Z, 24 hours after v0.0.1 was published.',
      'Decision: no release is due.',
    ])
  })

  it('names the open release, a missing version and the issue to open', () => {
    expect(
      summary(
        decide(
          input({
            commits: fixes(10),
            openPulls: [{ number: 60, title: 'chore(release): v0.0.2' }],
          }),
        ),
      ),
    ).toEqual([
      `Last release: v0.0.1, published ${hoursAgo(48).replace('.000Z', 'Z')}.`,
      'Since v0.0.1: 10 commits, 10 user-visible.',
      'Version: v0.0.2, the earliest open patch milestone.',
      'Fired: Count, 10 user-visible changes have merged since v0.0.1.',
      'Release open: #60, "chore(release): v0.0.2", is open.',
      'Decision: no new issue, because a release is open.',
    ])
    expect(
      summary(
        decide(
          input({
            commits: fixes(10),
            milestones: [{ number: 1, title: 'v0.1.0', openIssues: 3 }],
          }),
        ),
      ).slice(2),
    ).toEqual([
      'Version: none. No patch milestone is open before v0.1.0, which still has 3 open issues.',
      'Fired: Count, 10 user-visible changes have merged since v0.0.1.',
      'Decision: a release is due, but no milestone gives its version; plan one.',
    ])
    expect(summary(decide(input({ lastTag: null, releases: [], commits: fixes(10) })))).toEqual([
      'Last release: none yet.',
      'Since the first commit: 10 commits, 10 user-visible.',
      'Version: v0.0.2, the earliest open patch milestone.',
      'Fired: Count, 10 user-visible changes have merged since the first commit.',
      'Decision: open "Release v0.0.2".',
    ])
  })
})

describe('missing', () => {
  const want = { type: 'Task', milestone: 3, labels: ['state:ready', 'area:build'] }

  it('finds nothing missing on a complete issue', () => {
    expect(
      missing(
        {
          type: { name: 'Task' },
          milestone: { number: 3 },
          labels: [{ name: 'area:build' }, { name: 'state:ready' }],
        },
        want,
      ),
    ).toEqual([])
  })

  it('names what the token could not set', () => {
    expect(missing({ type: null, milestone: null, labels: [] }, want)).toEqual([
      'type Task',
      'milestone #3',
      'label state:ready',
      'label area:build',
    ])
    expect(
      missing(
        { type: { name: 'Bug' }, milestone: { number: 3 }, labels: [{ name: 'state:ready' }] },
        want,
      ),
    ).toEqual(['type Task', 'label area:build'])
  })
})
