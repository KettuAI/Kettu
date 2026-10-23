import { describe, expect, it } from 'vitest'
import {
  decide,
  isUserVisible,
  issueBody,
  lastPublished,
  latestTag,
  mergedPull,
  missing,
  pullNumber,
  readPull,
  releaseOpen,
  releaseTarget,
  summary,
} from './release-check.mjs'

type Input = Parameters<typeof decide>[0]

const NOW = new Date('2026-11-01T12:00:00Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
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
const urgentPull = (number: number, issue: number) => ({
  number,
  issues: [{ number: issue, labels: ['area:session', 'urgent'] }],
})

const base: Input = {
  now: NOW,
  tags: [tag('v0.0.1', 49)],
  commits: [],
  releases: [published('v0.0.1', 48)],
  milestones: [
    { number: 1, title: 'v0.1.0', openIssues: 6 },
    { number: 4, title: 'v0.0.3', openIssues: 8 },
    { number: 3, title: 'v0.0.2', openIssues: 5 },
  ],
  openIssues: [{ number: 12, title: 'Use the installed agents' }],
  openPulls: [{ number: 52, title: 'fix(agents): run the installed claude and codex' }],
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
        { tag: 'v0.0.3', draft: true, prerelease: false, publishedAt: null },
        published('v0.0.1', 200),
        published('v0.0.2', 100),
      ]),
    ).toEqual({ tag: 'v0.0.2', at: new Date(hoursAgo(100)) })
  })

  it('ignores prereleases and tags that are not versions', () => {
    expect(
      lastPublished([
        published('v0.0.1', 48),
        { ...published('v0.0.2', 2), prerelease: true },
        published('v0.0.2-beta.1', 3),
        published('nightly', 1),
      ]),
    ).toEqual({ tag: 'v0.0.1', at: new Date(hoursAgo(48)) })
  })

  it('returns null when nothing is published', () => {
    expect(lastPublished([])).toBeNull()
    expect(
      lastPublished([{ tag: 'v0.0.1', draft: true, prerelease: false, publishedAt: null }]),
    ).toBeNull()
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
  it('finds nothing when no release is under way', () => {
    expect(releaseOpen(base)).toEqual({ open: null, warnings: [] })
    expect(releaseOpen(input({ tags: [], releases: [] }))).toEqual({ open: null, warnings: [] })
  })

  it('counts an open issue titled exactly "Release vX.Y.Z" above the last tag', () => {
    expect(
      releaseOpen(
        input({ openIssues: [...base.openIssues, { number: 61, title: 'Release v0.0.2' }] }),
      ),
    ).toEqual({ open: { reason: '#61, "Release v0.0.2", is open.', since: null }, warnings: [] })
  })

  it('warns about a release issue left open after its version shipped, and does not count it', () => {
    expect(
      releaseOpen(
        input({
          tags: [tag('v0.0.1', 200), tag('v0.0.2', 49)],
          releases: [published('v0.0.1', 200), published('v0.0.2', 48)],
          openIssues: [{ number: 61, title: 'Release v0.0.2' }],
        }),
      ),
    ).toEqual({
      open: null,
      warnings: [
        '#61, "Release v0.0.2", is open, but v0.0.2 is not above the last tag, v0.0.2, so it does not count as an open release.',
      ],
    })
  })

  it('warns about an issue that only starts like a release issue', () => {
    expect(
      releaseOpen(
        input({
          openIssues: [
            { number: 90, title: 'Release v0.0.3 crashes on launch' },
            { number: 70, title: 'Release view crashes' },
            { number: 71, title: 'Plan the Release v0.0.2 notes' },
          ],
        }),
      ),
    ).toEqual({
      open: null,
      warnings: [
        '#90, "Release v0.0.3 crashes on launch", does not count as an open release: only the exact title "Release vX.Y.Z" does.',
      ],
    })
  })

  it('counts an open pull request titled exactly "chore(release): vX.Y.Z" above the last tag', () => {
    expect(
      releaseOpen(
        input({ openPulls: [...base.openPulls, { number: 60, title: 'chore(release): v0.0.2' }] }),
      ),
    ).toEqual({
      open: { reason: '#60, "chore(release): v0.0.2", is open.', since: null },
      warnings: [],
    })
  })

  it('warns about other chore(release) pull requests, and does not count them', () => {
    expect(
      releaseOpen(
        input({
          openPulls: [
            { number: 71, title: 'chore(release): drop the intel mac build' },
            { number: 72, title: 'chore(release): v0.0.1' },
            { number: 62, title: 'chore: release notes' },
          ],
        }),
      ),
    ).toEqual({
      open: null,
      warnings: [
        '#71, "chore(release): drop the intel mac build", does not count as a release pull request: only the exact title "chore(release): vX.Y.Z" does.',
        '#72, "chore(release): v0.0.1", is open, but v0.0.1 is not above the last tag, v0.0.1, so it does not count as an open release.',
      ],
    })
  })

  it('counts a merged release commit while its version has neither a tag nor a release', () => {
    expect(
      releaseOpen(
        input({
          commits: [commit('fix: a (#58)'), commit('chore(release): v0.0.2 (#60)', 'r', 5)],
        }),
      ),
    ).toEqual({
      open: {
        reason: '"chore(release): v0.0.2 (#60)" has merged, and v0.0.2 is not tagged yet.',
        since: new Date(hoursAgo(5)),
      },
      warnings: [],
    })
  })

  it('warns about a tooling chore(release) commit, and does not count it', () => {
    expect(
      releaseOpen(
        input({ commits: [...fixes(2), commit('chore(release): sign the macos build (#70)')] }),
      ),
    ).toEqual({
      open: null,
      warnings: [
        '"chore(release): sign the macos build (#70)" does not count as a release: only "chore(release): vX.Y.Z" does.',
      ],
    })
  })

  it('clears a release whose tag sits on a commit outside main', () => {
    expect(
      releaseOpen(
        input({
          tags: [tag('v0.0.1', 200), tag('v0.0.2', 31)],
          releases: [published('v0.0.1', 200), published('v0.0.2', 30)],
          commits: [commit('chore(release): v0.0.2 (#60)'), ...fixes(3)],
        }),
      ),
    ).toEqual({ open: null, warnings: [] })
  })

  it('counts the latest tag while it has no published release, whether its draft is visible or not', () => {
    const tags = [tag('v0.0.1', 200), tag('v0.0.2', 5)]
    const expected = {
      open: {
        reason: 'v0.0.2 is tagged, and no release of it is published yet.',
        since: new Date(hoursAgo(5)),
      },
      warnings: [],
    }
    const draft = { tag: 'v0.0.2', draft: true, prerelease: false, publishedAt: null }
    expect(releaseOpen(input({ tags, releases: [draft, ...base.releases] }))).toEqual(expected)
    expect(releaseOpen(input({ tags }))).toEqual(expected)
    expect(releaseOpen(input({ tags, commits: [commit('chore(release): v0.0.2 (#60)')] }))).toEqual(
      expected,
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
      changes: commits('fix: a (#24)', 'fix: c (#26)'),
      target: { version: 'v0.0.2' },
      releaseOpen: null,
      warnings: [],
      failure: null,
    })
  })

  it('fires Count at 10 user-visible changes, not 9', () => {
    expect(decide(input({ commits: fixes(10) }))).toMatchObject({
      outcome: 'open',
      fired: [{ name: 'Count', detail: '10 user-visible changes have merged since v0.0.1.' }],
    })
    const nine = [...fixes(9), ...commits('docs: a (#90)', 'ci: b (#91)', 'revert: c (#92)')]
    expect(decide(input({ commits: nine }))).toMatchObject({ outcome: 'none', fired: [] })
  })

  it('holds Count until 24 hours after the previous release', () => {
    expect(
      decide(input({ commits: fixes(12), releases: [published('v0.0.1', 23)] })),
    ).toMatchObject({
      outcome: 'none',
      fired: [],
      held: [{ name: 'Count', detail: '12 user-visible changes have merged since v0.0.1.' }],
    })
    expect(
      decide(input({ commits: fixes(12), releases: [published('v0.0.1', 24)] })),
    ).toMatchObject({ outcome: 'open', fired: [{ name: 'Count' }], held: [] })
  })

  it('fires Time 7 days after the last release when a user-visible change has merged', () => {
    const week = [published('v0.0.1', 7 * 24)]
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
      decide(input({ commits: commits('docs: a (#1)', 'revert: b (#2)'), releases: week })),
    ).toMatchObject({ outcome: 'none', fired: [] })
    expect(
      decide(input({ commits: fixes(3), releases: [published('v0.0.1', 7 * 24 - 1)] })),
    ).toMatchObject({ outcome: 'none', fired: [] })
  })

  it('fires Urgent at once for a merged fix or revert of an urgent issue', () => {
    const decision = decide(
      input({
        releases: [published('v0.0.1', 1)],
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
    })
  })

  it('ignores docs, CI and other tasks that close an urgent issue, and fixes that close none', () => {
    expect(
      decide(
        input({
          releases: [published('v0.0.1', 1)],
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

  it('names every trigger that fired, Urgent first', () => {
    const decision = decide(
      input({
        releases: [published('v0.0.1', 8 * 24)],
        commits: fixes(10),
        pulls: { 'fix: change 5 (#105)': urgentPull(105, 40) },
      }),
    )
    expect(decision.fired.map((trigger) => trigger.name)).toEqual(['Urgent', 'Count', 'Time'])
  })

  it('opens nothing while a release issue is open, without a warning', () => {
    expect(
      decide(input({ commits: fixes(10), openIssues: [{ number: 61, title: 'Release v0.0.2' }] })),
    ).toMatchObject({
      outcome: 'release-open',
      fired: [{ name: 'Count' }],
      releaseOpen: '#61, "Release v0.0.2", is open.',
      warnings: [],
      failure: null,
    })
  })

  it('warns while an untagged or unpublished release holds back a trigger', () => {
    expect(
      decide(input({ commits: [commit('chore(release): v0.0.2 (#60)', 'r', 47), ...fixes(10)] })),
    ).toMatchObject({
      outcome: 'release-open',
      warnings: [
        'A release is due (Count), but "chore(release): v0.0.2 (#60)" has merged, and v0.0.2 is not tagged yet.',
      ],
      failure: null,
    })
    expect(
      decide(input({ tags: [tag('v0.0.1', 200), tag('v0.0.2', 47)], commits: fixes(10) })),
    ).toMatchObject({
      outcome: 'release-open',
      warnings: [
        'A release is due (Count), but v0.0.2 is tagged, and no release of it is published yet.',
      ],
      failure: null,
    })
  })

  it('fails once an untagged or unpublished release has held a trigger back for 48 hours', () => {
    expect(
      decide(input({ commits: [commit('chore(release): v0.0.2 (#60)', 'r', 48), ...fixes(10)] })),
    ).toMatchObject({
      outcome: 'release-open',
      warnings: [],
      failure: `A release is due (Count), but "chore(release): v0.0.2 (#60)" has merged, and v0.0.2 is not tagged yet. That has held since ${hoursAgo(48).replace('.000Z', 'Z')}, over 48 hours; finish that release.`,
    })
    expect(
      decide(
        input({
          tags: [tag('v0.0.1', 400), tag('v0.0.2', 300)],
          releases: [published('v0.0.1', 400)],
          commits: fixes(1),
        }),
      ),
    ).toMatchObject({
      outcome: 'release-open',
      fired: [{ name: 'Time' }],
      failure: `A release is due (Time), but v0.0.2 is tagged, and no release of it is published yet. That has held since ${hoursAgo(300).replace('.000Z', 'Z')}, over 48 hours; finish that release.`,
    })
  })

  it('neither warns nor fails about a release under way when nothing is due', () => {
    expect(
      decide(input({ tags: [tag('v0.0.1', 400), tag('v0.0.2', 300)], commits: fixes(2) })),
    ).toMatchObject({
      outcome: 'none',
      releaseOpen: 'v0.0.2 is tagged, and no release of it is published yet.',
      warnings: [],
      failure: null,
    })
  })

  it('fails when a trigger fired but no milestone gives a version', () => {
    const milestones = [{ number: 1, title: 'v0.1.0', openIssues: 3 }]
    expect(decide(input({ commits: fixes(10), milestones }))).toMatchObject({
      outcome: 'no-version',
      target: {
        problem: 'No patch milestone is open before v0.1.0, which still has 3 open issues.',
      },
      failure:
        'A release is due (Count), but it has no version: No patch milestone is open before v0.1.0, which still has 3 open issues.',
    })
    expect(decide(input({ commits: fixes(2), milestones }))).toMatchObject({
      outcome: 'none',
      failure: null,
    })
  })

  it('counts from the first commit before any release, and never fires Time', () => {
    const first = { tags: [], releases: [] }
    expect(decide(input({ ...first, commits: fixes(10) }))).toMatchObject({
      outcome: 'open',
      lastTag: null,
      lastPublished: null,
      fired: [
        { name: 'Count', detail: '10 user-visible changes have merged since the first commit.' },
      ],
    })
    expect(decide(input({ ...first, commits: fixes(9) }))).toMatchObject({ outcome: 'none' })
  })
})

describe('issueBody', () => {
  it('names the trigger and the version, and lists the user-visible changes and reverts', () => {
    const decision = decide(
      input({
        releases: [published('v0.0.1', 1)],
        commits: [
          commit('feat(usage): add a one-day range (#45)'),
          commit('docs: explain the release (#46)'),
          commit('revert: feat: add login (#33) (#81)', 'c81'),
          commit('perf(thread): virtualize entries (#47)'),
        ],
        pulls: { c81: urgentPull(81, 82) },
      }),
    )
    expect(issueBody(decision)).toBe(
      [
        'The Urgent trigger fired: "revert: feat: add login (#33) (#81)" closed urgent #82.',
        '',
        'The version is v0.0.2, the earliest open patch milestone. The steps are in [release](https://github.com/overbench/overbench/blob/main/docs/workflow.md#6-release).',
        '',
        'User-visible changes and reverts since v0.0.1:',
        '',
        '- feat(usage): add a one-day range (#45)',
        '- revert: feat: add login (#33) (#81)',
        '- perf(thread): virtualize entries (#47)',
        '',
      ].join('\n'),
    )
  })

  it('lists several triggers and says why a minor is next', () => {
    const decision = decide(
      input({
        tags: [tag('v0.0.5', 8 * 24 + 1)],
        releases: [published('v0.0.5', 8 * 24)],
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
    expect(body).toContain(
      'User-visible changes and reverts since v0.0.5:\n\n- fix: change 1 (#101)\n',
    )
  })
})

describe('summary', () => {
  it('says what it found and why nothing opens', () => {
    expect(
      summary(
        decide(
          input({
            releases: [{ ...published('v0.0.1', 0), publishedAt: '2026-11-01T00:00:00Z' }],
            commits: [...fixes(10), commit('docs: a (#200)')],
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
    expect(summary(decide(input({ tags: [], releases: [], commits: fixes(10) })))).toEqual([
      'Last release: none yet.',
      'Since the first commit: 10 commits, 10 user-visible.',
      'Version: v0.0.2, the earliest open patch milestone.',
      'Fired: Count, 10 user-visible changes have merged since the first commit.',
      'Decision: open "Release v0.0.2".',
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
