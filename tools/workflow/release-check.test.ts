import { describe, expect, it } from 'vitest'
import {
  decide,
  isUserVisible,
  issueBody,
  lastPublished,
  latestTag,
  mergedPull,
  missing,
  nextVersion,
  pullNumber,
  readPull,
  releaseOpen,
  releaseTarget,
  summary,
} from './release-check.mjs'

type Input = Parameters<typeof decide>[0]

const NOW = new Date('2026-11-01T12:00:00Z')
const HOUR = 3_600_000
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString()
const commit = (subject: string, sha = subject, hours = 10) => ({
  sha,
  subject,
  date: hoursAgo(hours),
})
const commits = (...subjects: string[]) => subjects.map((subject) => commit(subject))
const fixes = (count: number) =>
  Array.from({ length: count }, (_, i) => commit(`fix: change ${i + 1} (#${101 + i})`))
const tag = (name: string, hours: number) => ({ name, date: hoursAgo(hours) })
const published = (name: string, hours: number) => ({
  tag: name,
  draft: false,
  prerelease: false,
  publishedAt: hoursAgo(hours),
})
const labeledPull = (label: string) => (number: number, issue: number) => ({
  number,
  issues: [{ number: issue, labels: ['area:session', label] }],
})
const corePull = labeledPull('core')
const urgentPull = labeledPull('urgent')
const milestone = (number: number, title: string, openIssues: number) => ({
  number,
  title,
  openIssues,
})

const base: Input = {
  now: NOW,
  tags: [tag('v0.0.4', 49)],
  commits: [],
  releases: [published('v0.0.4', 48)],
  milestones: [milestone(7, 'v0.0.6', 8), milestone(1, 'v0.1.0', 6), milestone(6, 'v0.0.5', 17)],
  openIssues: [{ number: 12, title: 'Use the installed agents' }],
  pulls: {},
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

describe('nextVersion', () => {
  it('takes the next patch after the last tag', () => {
    expect(nextVersion('v0.0.4')).toBe('v0.0.5')
    expect(nextVersion('v0.0.9')).toBe('v0.0.10')
    expect(nextVersion('v0.1.0')).toBe('v0.1.1')
    expect(nextVersion(null)).toBe('v0.0.1')
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

  it('leaves out docs, CI, refactors, reverts, other tasks and anything without a header', () => {
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
        { tag: 'v0.0.4', draft: true, prerelease: false, publishedAt: null },
        published('v0.0.2', 200),
        published('v0.0.3', 100),
      ]),
    ).toEqual({ tag: 'v0.0.3', at: new Date(hoursAgo(100)) })
  })

  it('ignores prereleases and tags that are not versions', () => {
    expect(
      lastPublished([
        published('v0.0.3', 48),
        { ...published('v0.0.4', 2), prerelease: true },
        published('v0.0.4-beta.1', 3),
        published('nightly', 1),
      ]),
    ).toEqual({ tag: 'v0.0.3', at: new Date(hoursAgo(48)) })
  })

  it('returns null when nothing is published', () => {
    expect(lastPublished([])).toBeNull()
    expect(
      lastPublished([{ tag: 'v0.0.1', draft: true, prerelease: false, publishedAt: null }]),
    ).toBeNull()
  })
})

describe('releaseTarget', () => {
  it('takes the earliest open milestone once all of its issues have closed', () => {
    expect(
      releaseTarget(
        [milestone(7, 'v0.0.6', 8), milestone(6, 'v0.0.5', 0), milestone(1, 'v0.1.0', 6)],
        'v0.0.4',
      ),
    ).toEqual({
      version: 'v0.0.5',
      milestone: milestone(6, 'v0.0.5', 0),
      done: true,
    })
    expect(
      releaseTarget([milestone(9, 'v0.0.10', 1), milestone(8, 'v0.0.9', 0)], 'v0.0.8'),
    ).toMatchObject({ version: 'v0.0.9', done: true })
  })

  it('waits while the earliest open milestone still has issues', () => {
    expect(releaseTarget(base.milestones, 'v0.0.4')).toEqual({
      problem: 'The earliest open milestone, v0.0.5, still has 17 open issues.',
    })
    expect(releaseTarget([milestone(6, 'v0.0.5', 1)], 'v0.0.4')).toEqual({
      problem: 'The earliest open milestone, v0.0.5, still has 1 open issue.',
    })
  })

  it('skips a milestone left open at or before the last tag, and titles that are not versions', () => {
    expect(
      releaseTarget(
        [
          milestone(2, 'Backlog', 40),
          milestone(3, 'v0.0.2', 1),
          milestone(7, 'v0.0', 1),
          milestone(4, 'v0.0.3', 0),
        ],
        'v0.0.2',
      ),
    ).toMatchObject({ version: 'v0.0.3', milestone: { number: 4 }, done: true })
  })

  it('takes the next version number for an early release, even with issues left', () => {
    expect(releaseTarget(base.milestones, 'v0.0.4', true)).toEqual({
      version: 'v0.0.5',
      milestone: milestone(6, 'v0.0.5', 17),
      done: false,
    })
    expect(releaseTarget([milestone(7, 'v0.0.6', 8)], 'v0.0.4', true)).toEqual({
      problem: 'No open milestone is planned for v0.0.5, the next version after v0.0.4.',
    })
  })

  it('names the problem when no version fits', () => {
    expect(releaseTarget([], 'v0.0.4')).toEqual({
      problem: 'No open milestone is planned after v0.0.4.',
    })
    expect(releaseTarget([], null)).toEqual({ problem: 'No open milestone is planned.' })
  })

  it('considers every milestone before the first tag', () => {
    expect(
      releaseTarget([milestone(1, 'v0.1.0', 6), milestone(2, 'v0.0.1', 0)], null),
    ).toMatchObject({ version: 'v0.0.1', done: true })
    expect(releaseTarget([milestone(2, 'v0.0.1', 3)], null)).toEqual({
      problem: 'The earliest open milestone, v0.0.1, still has 3 open issues.',
    })
    expect(releaseTarget([milestone(2, 'v0.0.1', 3)], null, true)).toEqual({
      version: 'v0.0.1',
      milestone: milestone(2, 'v0.0.1', 3),
      done: false,
    })
  })
})

describe('releaseOpen', () => {
  it('finds nothing when no release is under way', () => {
    expect(releaseOpen(base)).toEqual({ open: null, warnings: [] })
    expect(releaseOpen(input({ tags: [], releases: [] }))).toEqual({ open: null, warnings: [] })
  })

  it('counts an open issue titled exactly "Release vX.Y.Z" above the last tag', () => {
    expect(
      releaseOpen(
        input({ openIssues: [...base.openIssues, { number: 61, title: 'Release v0.0.5' }] }),
      ),
    ).toEqual({ open: { reason: '#61, "Release v0.0.5", is open.', since: null }, warnings: [] })
  })

  it('warns about a release issue left open after its version shipped, and does not count it', () => {
    expect(
      releaseOpen(
        input({
          tags: [tag('v0.0.4', 200), tag('v0.0.5', 49)],
          releases: [published('v0.0.4', 200), published('v0.0.5', 48)],
          openIssues: [{ number: 61, title: 'Release v0.0.5' }],
        }),
      ),
    ).toEqual({
      open: null,
      warnings: [
        '#61, "Release v0.0.5", is open, but v0.0.5 is not above the last tag, v0.0.5, so it does not count as an open release.',
      ],
    })
  })

  it('warns about an issue that only starts like a release issue', () => {
    expect(
      releaseOpen(
        input({
          openIssues: [
            { number: 90, title: 'Release v0.0.5 crashes on launch' },
            { number: 70, title: 'Release view crashes' },
            { number: 71, title: 'Plan the Release v0.0.5 notes' },
          ],
        }),
      ),
    ).toEqual({
      open: null,
      warnings: [
        '#90, "Release v0.0.5 crashes on launch", does not count as an open release: only the exact title "Release vX.Y.Z" does.',
      ],
    })
  })

  it('clears a release whose tag sits on a commit outside main', () => {
    expect(
      releaseOpen(
        input({
          tags: [tag('v0.0.4', 200), tag('v0.0.5', 31)],
          releases: [published('v0.0.4', 200), published('v0.0.5', 30)],
          commits: fixes(3),
        }),
      ),
    ).toEqual({ open: null, warnings: [] })
  })

  it('counts the latest tag while it has no published release, whether its draft is visible or not', () => {
    const tags = [tag('v0.0.4', 200), tag('v0.0.5', 5)]
    const expected = {
      open: {
        reason: 'v0.0.5 is tagged, and no release of it is published yet.',
        since: new Date(hoursAgo(5)),
      },
      warnings: [],
    }
    const draft = { tag: 'v0.0.5', draft: true, prerelease: false, publishedAt: null }
    expect(releaseOpen(input({ tags, releases: [draft, ...base.releases] }))).toEqual(expected)
    expect(releaseOpen(input({ tags }))).toEqual(expected)
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
      changes: commits('fix: a (#24)', 'fix: c (#26)'),
      target: { problem: 'The earliest open milestone, v0.0.5, still has 17 open issues.' },
      releaseOpen: null,
      warnings: [],
      failure: null,
    })
  })

  it('fires Milestone once the earliest open milestone has no open issues', () => {
    expect(
      decide(input({ milestones: [milestone(6, 'v0.0.5', 0), milestone(7, 'v0.0.6', 8)] })),
    ).toMatchObject({
      outcome: 'open',
      fired: [{ name: 'Milestone', detail: 'v0.0.5 is done: all its issues have closed.' }],
      target: { version: 'v0.0.5', milestone: milestone(6, 'v0.0.5', 0), done: true },
    })
  })

  it('fires Milestone on the push that completes it, however soon after the previous release', () => {
    expect(
      decide(
        input({ milestones: [milestone(6, 'v0.0.5', 0)], releases: [published('v0.0.4', 1)] }),
      ),
    ).toMatchObject({
      outcome: 'open',
      fired: [{ name: 'Milestone', detail: 'v0.0.5 is done: all its issues have closed.' }],
      target: { version: 'v0.0.5', done: true },
    })
  })

  it('fires Count once 10 user-visible changes have merged since the latest tag', () => {
    const others = commits(
      'docs: a (#200)',
      'ci: b (#201)',
      'chore: c (#202)',
      'revert: feat: add login (#33) (#203)',
    )
    expect(decide(input({ commits: [...fixes(9), ...others] }))).toMatchObject({
      outcome: 'none',
      fired: [],
    })
    expect(
      decide(
        input({
          commits: [
            ...fixes(8),
            commit('feat(usage): add a one-day range (#300)'),
            commit('perf(thread): virtualize entries (#301)'),
            ...others,
          ],
        }),
      ),
    ).toMatchObject({
      outcome: 'open',
      fired: [{ name: 'Count', detail: '10 user-visible changes have merged since v0.0.4.' }],
      target: { version: 'v0.0.5', milestone: milestone(6, 'v0.0.5', 17), done: false },
    })
  })

  it('fires Count on the push after a release, however soon', () => {
    const decision = decide(input({ releases: [published('v0.0.4', 1)], commits: fixes(10) }))
    expect(decision).toMatchObject({ outcome: 'open', fired: [{ name: 'Count' }] })
  })

  it('fires Core at once for a merged change of a core issue', () => {
    const decision = decide(
      input({
        releases: [published('v0.0.4', 1)],
        commits: [
          commit('feat(browser): add the browser pane (#60)', 'c60'),
          commit('revert: feat: add the media viewer (#33) (#81)', 'c81'),
        ],
        pulls: { c60: corePull(60, 47), c81: corePull(81, 43) },
      }),
    )
    expect(decision).toMatchObject({
      outcome: 'open',
      fired: [
        {
          name: 'Core',
          detail:
            '"feat(browser): add the browser pane (#60)" closed core #47; "revert: feat: add the media viewer (#33) (#81)" closed core #43.',
        },
      ],
      target: { version: 'v0.0.5', milestone: milestone(6, 'v0.0.5', 17), done: false },
    })
  })

  it('ignores docs, CI and other tasks that close a core issue, and changes that close none', () => {
    expect(
      decide(
        input({
          commits: [
            commit('docs: describe the browser pane (#80)', 'c80'),
            commit('ci: retry the flaky job (#83)', 'c83'),
            commit('feat: add a setting (#84)', 'c84'),
            commit('fix: a (#30)', 'c30'),
          ],
          pulls: {
            c80: corePull(80, 47),
            c83: corePull(83, 47),
            c84: { number: 84, issues: [{ number: 85, labels: ['area:settings'] }] },
            c30: { number: 30, issues: [{ number: 29, labels: ['regression'] }] },
          },
        }),
      ),
    ).toMatchObject({ outcome: 'none', fired: [] })
  })

  it('takes the milestone version when a core change completes the milestone', () => {
    expect(
      decide(
        input({
          milestones: [milestone(6, 'v0.0.5', 0)],
          releases: [published('v0.0.4', 1)],
          commits: [commit('feat(browser): add the browser pane (#60)', 'c60')],
          pulls: { c60: corePull(60, 47) },
        }),
      ),
    ).toMatchObject({
      outcome: 'open',
      fired: [{ name: 'Core' }, { name: 'Milestone' }],
      target: { version: 'v0.0.5', milestone: milestone(6, 'v0.0.5', 0), done: true },
    })
  })

  it('fires Urgent at once for a merged fix or revert of an urgent issue', () => {
    const decision = decide(
      input({
        releases: [published('v0.0.4', 1)],
        commits: [
          commit('fix(session): keep threads on crash (#30)', 'c30'),
          commit('revert: feat: add login (#33) (#81)', 'c81'),
        ],
        pulls: {
          c30: {
            number: 30,
            issues: [
              { number: 29, labels: ['area:session', 'urgent'] },
              { number: 31, labels: ['regression'] },
            ],
          },
          c81: urgentPull(81, 82),
        },
      }),
    )
    expect(decision).toMatchObject({
      outcome: 'open',
      fired: [
        {
          name: 'Urgent',
          detail:
            '"fix(session): keep threads on crash (#30)" closed urgent #29; "revert: feat: add login (#33) (#81)" closed urgent #82.',
        },
      ],
      target: { version: 'v0.0.5', milestone: milestone(6, 'v0.0.5', 17), done: false },
    })
  })

  it('ignores docs, CI and other tasks that close an urgent issue, and fixes that close none', () => {
    expect(
      decide(
        input({
          releases: [published('v0.0.4', 1)],
          commits: [
            commit('docs: note the workaround (#80)', 'c80'),
            commit('ci: retry the flaky job (#83)', 'c83'),
            commit('fix: a (#30)', 'c30'),
          ],
          pulls: {
            c80: urgentPull(80, 79),
            c83: urgentPull(83, 79),
            c30: { number: 30, issues: [{ number: 29, labels: ['regression'] }] },
          },
        }),
      ),
    ).toMatchObject({ outcome: 'none', fired: [] })
  })

  it('fires Core and Urgent both for one change that closes a core and an urgent issue', () => {
    const decision = decide(
      input({
        commits: [commit('fix(session): keep threads on crash (#30)', 'c30')],
        pulls: {
          c30: {
            number: 30,
            issues: [
              { number: 29, labels: ['area:session', 'urgent'] },
              { number: 31, labels: ['core'] },
            ],
          },
        },
      }),
    )
    expect(decision.fired).toEqual([
      { name: 'Core', detail: '"fix(session): keep threads on crash (#30)" closed core #31.' },
      { name: 'Urgent', detail: '"fix(session): keep threads on crash (#30)" closed urgent #29.' },
    ])
  })

  it('names every trigger that fired, in the order Core, Urgent, Milestone, Count', () => {
    const decision = decide(
      input({
        milestones: [milestone(6, 'v0.0.5', 0)],
        releases: [published('v0.0.4', 1)],
        commits: [...fixes(10), commit('feat(browser): add the browser pane (#60)', 'c60')],
        pulls: { 'fix: change 2 (#102)': urgentPull(102, 40), c60: corePull(60, 47) },
      }),
    )
    expect(decision.fired.map((trigger) => trigger.name)).toEqual([
      'Core',
      'Urgent',
      'Milestone',
      'Count',
    ])
  })

  it('opens nothing while a release issue is open, without a warning', () => {
    expect(
      decide(
        input({
          milestones: [milestone(6, 'v0.0.5', 0)],
          openIssues: [{ number: 61, title: 'Release v0.0.5' }],
        }),
      ),
    ).toMatchObject({
      outcome: 'release-open',
      fired: [{ name: 'Milestone' }],
      releaseOpen: '#61, "Release v0.0.5", is open.',
      warnings: [],
      failure: null,
    })
  })

  it('warns while an unpublished release holds back a trigger', () => {
    expect(
      decide(
        input({
          tags: [tag('v0.0.4', 200), tag('v0.0.5', 47)],
          releases: [published('v0.0.4', 200)],
          milestones: [milestone(7, 'v0.0.6', 0)],
        }),
      ),
    ).toMatchObject({
      outcome: 'release-open',
      warnings: [
        'A release is due (Milestone), but v0.0.5 is tagged, and no release of it is published yet.',
      ],
      failure: null,
    })
  })

  it('fails once an unpublished release has held a trigger back for 48 hours', () => {
    expect(
      decide(
        input({
          tags: [tag('v0.0.4', 200), tag('v0.0.5', 48)],
          releases: [published('v0.0.4', 200)],
          milestones: [milestone(7, 'v0.0.6', 0)],
        }),
      ),
    ).toMatchObject({
      outcome: 'release-open',
      warnings: [],
      failure: `A release is due (Milestone), but v0.0.5 is tagged, and no release of it is published yet. That has held since ${hoursAgo(48).replace('.000Z', 'Z')}, over 48 hours; finish that release.`,
    })
    expect(
      decide(
        input({
          tags: [tag('v0.0.4', 400), tag('v0.0.5', 300)],
          releases: [published('v0.0.4', 400)],
          milestones: [milestone(7, 'v0.0.6', 0)],
          commits: fixes(1),
        }),
      ),
    ).toMatchObject({
      outcome: 'release-open',
      fired: [{ name: 'Milestone' }],
      failure: `A release is due (Milestone), but v0.0.5 is tagged, and no release of it is published yet. That has held since ${hoursAgo(300).replace('.000Z', 'Z')}, over 48 hours; finish that release.`,
    })
  })

  it('neither warns nor fails about a release under way when nothing is due', () => {
    expect(
      decide(
        input({
          tags: [tag('v0.0.4', 400), tag('v0.0.5', 300)],
          releases: [published('v0.0.4', 400)],
          milestones: [milestone(7, 'v0.0.6', 2)],
          commits: fixes(2),
        }),
      ),
    ).toMatchObject({
      outcome: 'none',
      releaseOpen: 'v0.0.5 is tagged, and no release of it is published yet.',
      warnings: [],
      failure: null,
    })
  })

  it('fails when a trigger fired but no milestone gives a version', () => {
    const milestones = [milestone(1, 'v0.1.0', 3)]
    const problem = 'No open milestone is planned for v0.0.5, the next version after v0.0.4.'
    const commits = [commit('fix(session): keep threads on crash (#30)', 'c30')]
    for (const [trigger, decision] of [
      ['Urgent', decide(input({ milestones, commits, pulls: { c30: urgentPull(30, 29) } }))],
      ['Core', decide(input({ milestones, commits, pulls: { c30: corePull(30, 29) } }))],
      ['Count', decide(input({ milestones, commits: fixes(10) }))],
    ] as const) {
      expect(decision, trigger).toMatchObject({
        outcome: 'no-version',
        target: { problem },
        failure: `A release is due (${trigger}), but it has no version: ${problem}`,
      })
    }
    expect(decide(input({ milestones, commits: fixes(2) }))).toMatchObject({
      outcome: 'none',
      failure: null,
    })
  })

  it('releases the first milestone before any tag', () => {
    const first = { tags: [], releases: [] }
    expect(decide(input({ ...first, milestones: [milestone(2, 'v0.0.1', 0)] }))).toMatchObject({
      outcome: 'open',
      lastTag: null,
      lastPublished: null,
      fired: [{ name: 'Milestone', detail: 'v0.0.1 is done: all its issues have closed.' }],
      target: { version: 'v0.0.1', done: true },
    })
    expect(decide(input({ ...first, milestones: [milestone(2, 'v0.0.1', 3)] }))).toMatchObject({
      outcome: 'none',
      fired: [],
    })
    expect(
      decide(input({ ...first, milestones: [milestone(2, 'v0.0.1', 3)], commits: fixes(10) })),
    ).toMatchObject({
      outcome: 'open',
      fired: [
        { name: 'Count', detail: '10 user-visible changes have merged since the first commit.' },
      ],
      target: { version: 'v0.0.1', milestone: milestone(2, 'v0.0.1', 3), done: false },
    })
  })
})

describe('issueBody', () => {
  it('names the done milestone and the version, and lists the user-visible changes and reverts', () => {
    const decision = decide(
      input({
        milestones: [milestone(6, 'v0.0.5', 0)],
        commits: [
          commit('feat(usage): add a one-day range (#45)'),
          commit('docs: explain the release (#46)'),
          commit('perf(thread): virtualize entries (#47)'),
        ],
      }),
    )
    expect(issueBody(decision)).toBe(
      [
        'The Milestone trigger fired: v0.0.5 is done: all its issues have closed.',
        '',
        'The version is v0.0.5, the earliest open milestone, whose issues have all closed.',
        '',
        'User-visible changes and reverts since v0.0.4:',
        '',
        '- feat(usage): add a one-day range (#45)',
        '- perf(thread): virtualize entries (#47)',
        '',
      ].join('\n'),
    )
  })

  it('says an urgent release moves the unfinished issues up', () => {
    const decision = decide(
      input({
        releases: [published('v0.0.4', 1)],
        commits: [commit('fix(session): keep threads on crash (#30)', 'c30')],
        pulls: { c30: urgentPull(30, 29) },
      }),
    )
    expect(issueBody(decision)).toBe(
      [
        'The Urgent trigger fired: "fix(session): keep threads on crash (#30)" closed urgent #29.',
        '',
        'The version is v0.0.5, the next version number.',
        '',
        'The unfinished issues of its milestone move to the next version, and the planned milestones after it move up one number.',
        '',
        'User-visible changes and reverts since v0.0.4:',
        '',
        '- fix(session): keep threads on crash (#30)',
        '',
      ].join('\n'),
    )
  })

  it('says a core release moves the unfinished issues up', () => {
    const decision = decide(
      input({
        releases: [published('v0.0.4', 1)],
        commits: [commit('feat(browser): add the browser pane (#60)', 'c60')],
        pulls: { c60: corePull(60, 47) },
      }),
    )
    expect(issueBody(decision)).toBe(
      [
        'The Core trigger fired: "feat(browser): add the browser pane (#60)" closed core #47.',
        '',
        'The version is v0.0.5, the next version number.',
        '',
        'The unfinished issues of its milestone move to the next version, and the planned milestones after it move up one number.',
        '',
        'User-visible changes and reverts since v0.0.4:',
        '',
        '- feat(browser): add the browser pane (#60)',
        '',
      ].join('\n'),
    )
  })

  it('names the count and lists every change it counted', () => {
    const decision = decide(input({ commits: fixes(10) }))
    expect(issueBody(decision)).toBe(
      [
        'The Count trigger fired: 10 user-visible changes have merged since v0.0.4.',
        '',
        'The version is v0.0.5, the next version number.',
        '',
        'The unfinished issues of its milestone move to the next version, and the planned milestones after it move up one number.',
        '',
        'User-visible changes and reverts since v0.0.4:',
        '',
        ...fixes(10).map((change) => `- ${change.subject}`),
        '',
      ].join('\n'),
    )
  })

  it('lists several triggers and keeps a done milestone version', () => {
    const decision = decide(
      input({
        milestones: [milestone(6, 'v0.0.5', 0)],
        releases: [published('v0.0.4', 1)],
        commits: [commit('fix(session): keep threads on crash (#30)', 'c30')],
        pulls: { c30: urgentPull(30, 29) },
      }),
    )
    const body = issueBody(decision)
    expect(body).toContain(
      [
        'Triggers that fired:',
        '',
        '- Urgent: "fix(session): keep threads on crash (#30)" closed urgent #29.',
        '- Milestone: v0.0.5 is done: all its issues have closed.',
        '',
        'The version is v0.0.5, the earliest open milestone, whose issues have all closed.',
      ].join('\n'),
    )
    expect(body).toContain(
      'User-visible changes and reverts since v0.0.4:\n\n- fix(session): keep threads on crash (#30)\n',
    )
  })

  it('lists Core, Urgent, Milestone and Count together', () => {
    const decision = decide(
      input({
        milestones: [milestone(6, 'v0.0.5', 0)],
        commits: [
          commit('fix(session): keep threads on crash (#30)', 'c30'),
          commit('feat(browser): add the browser pane (#60)', 'c60'),
          ...fixes(9),
        ],
        pulls: { c30: urgentPull(30, 29), c60: corePull(60, 47) },
      }),
    )
    expect(issueBody(decision)).toContain(
      [
        'Triggers that fired:',
        '',
        '- Core: "feat(browser): add the browser pane (#60)" closed core #47.',
        '- Urgent: "fix(session): keep threads on crash (#30)" closed urgent #29.',
        '- Milestone: v0.0.5 is done: all its issues have closed.',
        '- Count: 11 user-visible changes have merged since v0.0.4.',
        '',
        'The version is v0.0.5, the earliest open milestone, whose issues have all closed.',
      ].join('\n'),
    )
  })
})

describe('summary', () => {
  it('says what it found and why nothing opens', () => {
    expect(
      summary(
        decide(
          input({
            releases: [{ ...published('v0.0.4', 0), publishedAt: '2026-11-01T00:00:00Z' }],
            commits: [...fixes(2), commit('docs: a (#200)')],
          }),
        ),
      ),
    ).toEqual([
      'Last release: v0.0.4, published 2026-11-01T00:00:00Z.',
      'Since v0.0.4: 3 commits, 2 user-visible.',
      'Version: none. The earliest open milestone, v0.0.5, still has 17 open issues.',
      'Triggers: none fired.',
      'Decision: no release is due.',
    ])
  })

  it('names Core and Count, one line each', () => {
    expect(
      summary(
        decide(
          input({
            commits: [commit('feat(browser): add the browser pane (#60)', 'c60'), ...fixes(9)],
            pulls: { c60: corePull(60, 47) },
          }),
        ),
      ),
    ).toEqual([
      `Last release: v0.0.4, published ${hoursAgo(48).replace('.000Z', 'Z')}.`,
      'Since v0.0.4: 10 commits, 10 user-visible.',
      'Version: v0.0.5, the next version number.',
      'Fired: Core, "feat(browser): add the browser pane (#60)" closed core #47.',
      'Fired: Count, 10 user-visible changes have merged since v0.0.4.',
      'Decision: open "Release v0.0.5".',
    ])
  })

  it('names the open release, a missing version and the issue to open', () => {
    expect(
      summary(
        decide(
          input({
            milestones: [milestone(6, 'v0.0.5', 0)],
            openIssues: [...base.openIssues, { number: 60, title: 'Release v0.0.5' }],
          }),
        ),
      ),
    ).toEqual([
      `Last release: v0.0.4, published ${hoursAgo(48).replace('.000Z', 'Z')}.`,
      'Since v0.0.4: 0 commits, 0 user-visible.',
      'Version: v0.0.5, the earliest open milestone, whose issues have all closed.',
      'Fired: Milestone, v0.0.5 is done: all its issues have closed.',
      'Release open: #60, "Release v0.0.5", is open.',
      'Decision: no new issue, because a release is open.',
    ])
    expect(
      summary(
        decide(
          input({
            milestones: [milestone(1, 'v0.1.0', 3)],
            commits: [commit('fix(session): keep threads on crash (#30)', 'c30')],
            pulls: { c30: urgentPull(30, 29) },
          }),
        ),
      ).slice(2),
    ).toEqual([
      'Version: none. No open milestone is planned for v0.0.5, the next version after v0.0.4.',
      'Fired: Urgent, "fix(session): keep threads on crash (#30)" closed urgent #29.',
      'Decision: a release is due, but no milestone gives its version; plan one.',
    ])
    expect(
      summary(
        decide(
          input({
            tags: [],
            releases: [],
            milestones: [milestone(2, 'v0.0.1', 0)],
            commits: fixes(1),
          }),
        ),
      ),
    ).toEqual([
      'Last release: none yet.',
      'Since the first commit: 1 commit, 1 user-visible.',
      'Version: v0.0.1, the earliest open milestone, whose issues have all closed.',
      'Fired: Milestone, v0.0.1 is done: all its issues have closed.',
      'Decision: open "Release v0.0.1".',
    ])
  })
})

describe('mergedPull', () => {
  const squash = commit('fix: a (#30)', 'f'.repeat(40))
  const pull = (number: number, oid: string | null) => ({
    number,
    mergeCommit: oid ? { oid } : null,
  })

  it('takes the pull request whose squash merge made the commit', () => {
    const object = {
      associatedPullRequests: { nodes: [pull(29, 'a'.repeat(40)), pull(31, squash.sha)] },
    }
    expect(mergedPull(squash, object)).toEqual(pull(31, squash.sha))
  })

  it('returns null when GitHub links none, or does not know the commit', () => {
    expect(mergedPull(squash, { associatedPullRequests: { nodes: [pull(32, null)] } })).toBeNull()
    expect(mergedPull(squash, null)).toBeNull()
  })
})

describe('readPull', () => {
  const squash = commit('fix: a (#30)')
  const labels = (...names: string[]) => ({
    totalCount: names.length,
    nodes: names.map((name) => ({ name })),
  })

  it('reads the issues a pull request closed, with their labels', () => {
    expect(
      readPull(squash, {
        number: 30,
        closingIssuesReferences: {
          totalCount: 2,
          nodes: [
            { number: 29, labels: labels('urgent', 'area:session') },
            { number: 31, labels: labels() },
          ],
        },
      }),
    ).toEqual({
      pull: {
        number: 30,
        issues: [
          { number: 29, labels: ['urgent', 'area:session'] },
          { number: 31, labels: [] },
        ],
      },
      warnings: [],
    })
  })

  it('warns when a page leaves issues or labels out', () => {
    expect(
      readPull(squash, {
        number: 30,
        closingIssuesReferences: {
          totalCount: 26,
          nodes: [{ number: 29, labels: { totalCount: 30, nodes: [{ name: 'area:git' }] } }],
        },
      }).warnings,
    ).toEqual([
      '#30 closed 26 issues; the Urgent check read the first 1.',
      '#29 has 30 labels; the Urgent check read the first 1.',
    ])
  })

  it('skips a number that is not a pull request, with a warning', () => {
    const warning =
      '"fix: a (#30)" names no pull request GitHub knows, so the Urgent check skips it.'
    expect(readPull(squash, null)).toEqual({ pull: null, warnings: [warning] })
    expect(readPull(squash, {})).toEqual({ pull: null, warnings: [warning] })
  })
})

describe('missing', () => {
  const want = { type: 'Task', milestone: 6, labels: ['state:ready', 'area:build'] }

  it('finds nothing missing on a complete issue', () => {
    expect(
      missing(
        {
          type: { name: 'Task' },
          milestone: { number: 6 },
          labels: [{ name: 'area:build' }, { name: 'state:ready' }],
        },
        want,
      ),
    ).toEqual([])
  })

  it('names what the token could not set', () => {
    expect(missing({ type: null, milestone: null, labels: [] }, want)).toEqual([
      'type Task',
      'milestone #6',
      'label state:ready',
      'label area:build',
    ])
    expect(
      missing(
        { type: { name: 'Bug' }, milestone: { number: 6 }, labels: [{ name: 'state:ready' }] },
        want,
      ),
    ).toEqual(['type Task', 'label area:build'])
  })
})
