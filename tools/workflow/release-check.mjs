// @ts-check
// Opens a "Release vX.Y.Z" issue when a release trigger has fired and no release is open. CI runs
// it on every push to main; run it the same way, with DRY_RUN=1 to print the decision without
// opening anything:
//
//   DRY_RUN=1 node tools/workflow/release-check.mjs
//
// It reads main's history with git, so it needs every commit and tag, and GitHub with gh. No
// dependencies.

import { execFileSync } from 'node:child_process'
import { parseTitle } from './commit-title.mjs'

const USER_VISIBLE = ['feat', 'fix', 'perf']
// The types that can fix a core or an urgent issue, and that the release notes list.
const FIXING = [...USER_VISIBLE, 'revert']
// User-visible changes since the latest tag that fire Count.
const COUNT = 10
const HOUR = 60 * 60 * 1000
const STALE = 48 * HOUR
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/
const RELEASE_ISSUE = /^Release (v\d+\.\d+\.\d+)$/
const LIKE_RELEASE_ISSUE = /^release v\d/i
const ISSUE = { type: 'Task', labels: ['state:ready', 'area:build'] }
const PAGE = 25

/** @typedef {{ sha: string, subject: string, date: string }} Commit */
/** @typedef {{ name: string, date: string }} Tag */
/** @typedef {{ tag: string, draft: boolean, prerelease: boolean, publishedAt: string | null }} Release */
/** @typedef {{ number: number, title: string, openIssues: number }} Milestone */
/** @typedef {{ number: number, title: string }} Item */
/** @typedef {{ number: number, labels: string[] }} LinkedIssue */
/** @typedef {{ number: number, issues: LinkedIssue[] }} Pull */
/** @typedef {{ name: 'Core' | 'Urgent' | 'Milestone' | 'Count', detail: string }} Trigger */
/** @typedef {{ version: string, milestone: Milestone, done: boolean } | { problem: string }} Target */
/** @typedef {{ reason: string, since: Date | null }} Open */

/**
 * @typedef {object} Input
 * @property {Date} now
 * @property {Tag[]} tags every tag in the repository
 * @property {Commit[]} commits main's commits since the latest version tag, oldest first
 * @property {Release[]} releases
 * @property {Milestone[]} milestones the open ones
 * @property {Item[]} openIssues
 * @property {Record<string, Pull>} pulls by commit sha, the pull request each commit came from
 */

/**
 * @typedef {object} Decision
 * @property {'open' | 'none' | 'release-open' | 'no-version'} outcome
 * @property {string | null} lastTag
 * @property {{ tag: string, at: Date } | null} lastPublished
 * @property {Commit[]} commits
 * @property {Commit[]} changes the user-visible commits
 * @property {Trigger[]} fired
 * @property {string | null} releaseOpen why a release counts as open
 * @property {Target} target
 * @property {string[]} warnings
 * @property {string | null} failure why the run should fail
 */

/** @param {string} text */
function parseVersion(text) {
  const match = VERSION.exec(text)
  return match ? match.slice(1).map(Number) : null
}

/** @param {number[]} a @param {number[]} b */
function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** @param {number} count @param {string} one @param {string} many */
function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

/** @param {Date} date */
function iso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** @param {string} subject */
const typeOf = (subject) => parseTitle(subject)?.type ?? ''

/**
 * @param {string[]} tags
 * @returns {string | null} the highest `vX.Y.Z` tag
 */
export function latestTag(tags) {
  let best = null
  let bestVersion = null
  for (const tag of tags) {
    const version = parseVersion(tag)
    if (version && (!bestVersion || compareVersions(version, bestVersion) > 0)) {
      best = tag
      bestVersion = version
    }
  }
  return best
}

/** @param {string} subject a squash commit's subject */
export function isUserVisible(subject) {
  return USER_VISIBLE.includes(typeOf(subject))
}

/**
 * @param {string} subject
 * @returns {number | null} the pull request the squash merge names at the end
 */
export function pullNumber(subject) {
  const match = / \(#(\d+)\)$/.exec(subject)
  return match ? Number(match[1]) : null
}

/**
 * @param {Release[]} releases
 * @returns {{ tag: string, at: Date } | null} the latest published `vX.Y.Z` release
 */
export function lastPublished(releases) {
  let last = null
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.publishedAt) continue
    if (!VERSION.test(release.tag)) continue
    const at = new Date(release.publishedAt)
    if (!last || at > last.at) last = { tag: release.tag, at }
  }
  return last
}

/**
 * @param {string | null} lastTag
 * @returns {string} the version after it
 */
export function nextVersion(lastTag) {
  const last = lastTag ? parseVersion(lastTag) : null
  const [major, minor, patch] = last ?? [0, 0, 0]
  return `v${major}.${minor}.${patch + 1}`
}

/**
 * @param {Milestone[]} milestones
 * @param {string | null} lastTag
 * @returns {{ milestone: Milestone, version: number[] }[]} the open milestones above the last tag,
 *   oldest first
 */
function planned(milestones, lastTag) {
  const last = lastTag ? parseVersion(lastTag) : null
  return milestones
    .flatMap((milestone) => {
      const version = parseVersion(milestone.title)
      return version && (!last || compareVersions(version, last) > 0)
        ? [{ milestone, version }]
        : []
    })
    .sort((a, b) => compareVersions(a.version, b.version))
}

/**
 * @param {Milestone[]} milestones
 * @param {string | null} lastTag
 * @returns {Milestone | null} the earliest open milestone above the last tag
 */
export function earliestMilestone(milestones, lastTag) {
  return planned(milestones, lastTag)[0]?.milestone ?? null
}

/**
 * The earliest open milestone above the last tag gives the version once all of its issues have
 * closed. A release that does not wait for that, because Core, Urgent or Count fired, takes the
 * next version number after the last tag instead, which then ships with its milestone still open.
 *
 * @param {Milestone[]} milestones
 * @param {string | null} lastTag
 * @param {boolean} [early] whether any trigger other than Milestone fired
 * @returns {Target}
 */
export function releaseTarget(milestones, lastTag, early = false) {
  const open = planned(milestones, lastTag)
  const earliest = open[0]
  if (!earliest) {
    return {
      problem: lastTag
        ? `No open milestone is planned after ${lastTag}.`
        : 'No open milestone is planned.',
    }
  }
  if (earliest.milestone.openIssues === 0) {
    return { version: earliest.milestone.title, milestone: earliest.milestone, done: true }
  }
  if (!early) {
    return {
      problem: `The earliest open milestone, ${earliest.milestone.title}, still has ${plural(earliest.milestone.openIssues, 'open issue', 'open issues')}.`,
    }
  }
  const version = nextVersion(lastTag)
  const wanted = parseVersion(version)
  const milestone = open.find(
    (candidate) => wanted && compareVersions(candidate.version, wanted) === 0,
  )?.milestone
  if (!milestone) {
    return {
      problem: `No open milestone is planned for ${version}, the next version after ${lastTag ?? 'the first commit'}.`,
    }
  }
  return { version, milestone, done: false }
}

/**
 * @param {Pick<Input, 'tags' | 'releases' | 'openIssues'>} input
 * @returns {{ open: Open | null, warnings: string[] }} the release under way, if any, and the
 *   issues that look like one but do not count
 */
export function releaseOpen({ tags, releases, openIssues }) {
  const lastTag = latestTag(tags.map((tag) => tag.name))
  const last = lastTag ? parseVersion(lastTag) : null
  /** @param {string} version */
  const pending = (version) => {
    const parsed = parseVersion(version)
    return parsed !== null && (!last || compareVersions(parsed, last) > 0)
  }
  /** @param {string} version */
  const published = (version) =>
    releases.some((release) => release.tag === version && !release.draft)
  /** @type {Open[]} */
  const found = []
  const warnings = []

  for (const issue of openIssues) {
    const version = RELEASE_ISSUE.exec(issue.title)?.[1]
    if (version && pending(version)) {
      found.push({ reason: `#${issue.number}, "${issue.title}", is open.`, since: null })
    } else if (version) {
      warnings.push(
        `#${issue.number}, "${issue.title}", is open, but ${version} is not above the last tag, ${lastTag}, so it does not count as an open release.`,
      )
    } else if (LIKE_RELEASE_ISSUE.test(issue.title)) {
      warnings.push(
        `#${issue.number}, "${issue.title}", does not count as an open release: only the exact title "Release vX.Y.Z" does.`,
      )
    }
  }
  // The workflow's token sees no drafts, so a tag without a published release is still under way.
  const tag = tags.find((candidate) => candidate.name === lastTag)
  if (tag && !published(tag.name)) {
    found.push({
      reason: `${tag.name} is tagged, and no release of it is published yet.`,
      since: new Date(tag.date),
    })
  }
  return { open: found[0] ?? null, warnings }
}

/**
 * @param {Commit[]} commits
 * @param {Record<string, Pull>} pulls
 * @param {string} label
 * @returns {string[]} one entry for each fixing commit whose pull request closed an issue with the
 *   label
 */
function closedWith(commits, pulls, label) {
  return commits.flatMap((commit) => {
    if (!FIXING.includes(typeOf(commit.subject))) return []
    const issues = (pulls[commit.sha]?.issues ?? [])
      .filter((issue) => issue.labels.includes(label))
      .map((issue) => `#${issue.number}`)
    return issues.length > 0 ? [`"${commit.subject}" closed ${label} ${issues.join(', ')}`] : []
  })
}

/**
 * @param {Input} input
 * @returns {Decision}
 */
export function decide(input) {
  const { now, commits, pulls } = input
  const lastTag = latestTag(input.tags.map((tag) => tag.name))
  const published = lastPublished(input.releases)
  const changes = commits.filter((commit) => isUserVisible(commit.subject))

  /** @type {Trigger[]} */
  const fired = []
  const core = closedWith(commits, pulls, 'core')
  if (core.length > 0) fired.push({ name: 'Core', detail: `${core.join('; ')}.` })
  const urgent = closedWith(commits, pulls, 'urgent')
  if (urgent.length > 0) fired.push({ name: 'Urgent', detail: `${urgent.join('; ')}.` })
  const done = earliestMilestone(input.milestones, lastTag)
  if (done && done.openIssues === 0) {
    fired.push({ name: 'Milestone', detail: `${done.title} is done: all its issues have closed.` })
  }
  if (changes.length >= COUNT) {
    fired.push({
      name: 'Count',
      detail: `${changes.length} user-visible changes have merged since ${lastTag ?? 'the first commit'}.`,
    })
  }

  const { open, warnings } = releaseOpen(input)
  const early = fired.some((trigger) => trigger.name !== 'Milestone')
  const target = releaseTarget(input.milestones, lastTag, early)
  const due = `A release is due (${fired.map((trigger) => trigger.name).join(', ')})`
  /** @type {Decision['outcome']} */
  let outcome = 'none'
  let failure = null
  if (fired.length > 0 && open) {
    outcome = 'release-open'
    // A tag without a published release has nothing open tracking it.
    if (open.since && now.getTime() - open.since.getTime() >= STALE) {
      failure = `${due}, but ${open.reason} That has held since ${iso(open.since)}, over 48 hours; finish that release.`
    } else if (open.since) {
      warnings.push(`${due}, but ${open.reason}`)
    }
  } else if (fired.length > 0 && 'problem' in target) {
    outcome = 'no-version'
    failure = `${due}, but it has no version: ${target.problem}`
  } else if (fired.length > 0) {
    outcome = 'open'
  }
  return {
    outcome,
    lastTag,
    lastPublished: published,
    commits,
    changes,
    fired,
    releaseOpen: open?.reason ?? null,
    target,
    warnings,
    failure,
  }
}

/** @param {Target} target */
function targetText(target) {
  if ('problem' in target) return `none. ${target.problem}`
  return target.done
    ? `${target.version}, the earliest open milestone, whose issues have all closed.`
    : `${target.version}, the next version number.`
}

/** @param {{ version: string }} target */
const issueTitle = (target) => `Release ${target.version}`

/**
 * @param {Decision} decision one whose outcome is `open`
 * @returns {string} the release issue's description, in Markdown
 */
export function issueBody(decision) {
  const { fired, commits, lastTag, target } = decision
  const triggers =
    fired.length === 1
      ? [`The ${fired[0].name} trigger fired: ${fired[0].detail}`]
      : [
          'Triggers that fired:',
          '',
          ...fired.map((trigger) => `- ${trigger.name}: ${trigger.detail}`),
        ]
  const shift =
    'problem' in target || target.done
      ? []
      : [
          '',
          'The unfinished issues of its milestone move to the next version, and the planned milestones after it move up one number.',
        ]
  const listed = commits.filter((commit) => FIXING.includes(typeOf(commit.subject)))
  return [
    ...triggers,
    '',
    `The version is ${targetText(target)}`,
    ...shift,
    '',
    `User-visible changes and reverts ${lastTag ? `since ${lastTag}` : 'so far'}:`,
    '',
    ...listed.map((commit) => `- ${commit.subject}`),
    '',
  ].join('\n')
}

/**
 * @param {Decision} decision
 * @returns {string[]} what the check found, one line each, for the log
 */
export function summary(decision) {
  const { lastTag, lastPublished: published, commits, changes, fired } = decision
  const lines = [
    published
      ? `Last release: ${published.tag}, published ${iso(published.at)}.`
      : 'Last release: none yet.',
    `${lastTag ? `Since ${lastTag}` : 'Since the first commit'}: ${plural(commits.length, 'commit', 'commits')}, ${changes.length} user-visible.`,
    `Version: ${targetText(decision.target)}`,
  ]
  if (fired.length === 0) lines.push('Triggers: none fired.')
  for (const trigger of fired) lines.push(`Fired: ${trigger.name}, ${trigger.detail}`)
  if (decision.releaseOpen) lines.push(`Release open: ${decision.releaseOpen}`)
  const { outcome, target } = decision
  let verdict = 'no release is due.'
  if (outcome === 'release-open') verdict = 'no new issue, because a release is open.'
  if (outcome === 'no-version') {
    verdict = 'a release is due, but no milestone gives its version; plan one.'
  }
  if (outcome === 'open' && 'version' in target) verdict = `open "${issueTitle(target)}".`
  lines.push(`Decision: ${verdict}`)
  return lines
}

/**
 * @param {Commit} commit
 * @param {any} object the commit's GraphQL `object(oid:)`, null when GitHub does not have it
 * @returns {any} the pull request whose squash merge made the commit, or null
 */
export function mergedPull(commit, object) {
  const pulls = object?.associatedPullRequests?.nodes ?? []
  return pulls.find((/** @type {any} */ pull) => pull.mergeCommit?.oid === commit.sha) ?? null
}

/**
 * @param {Commit} commit
 * @param {any} pull a GraphQL pull request with `closingIssuesReferences`, or null or a non-pull
 *   request when the subject's `(#N)` did not resolve to one
 * @returns {{ pull: Pull | null, warnings: string[] }}
 */
export function readPull(commit, pull) {
  if (typeof pull?.number !== 'number' || !pull.closingIssuesReferences) {
    return {
      pull: null,
      warnings: [
        `"${commit.subject}" names no pull request GitHub knows, so the Urgent check skips it.`,
      ],
    }
  }
  const warnings = []
  const closing = pull.closingIssuesReferences
  if (closing.totalCount > closing.nodes.length) {
    warnings.push(
      `#${pull.number} closed ${closing.totalCount} issues; the Urgent check read the first ${closing.nodes.length}.`,
    )
  }
  /** @type {LinkedIssue[]} */
  const issues = closing.nodes.map((/** @type {any} */ issue) => {
    if (issue.labels.totalCount > issue.labels.nodes.length) {
      warnings.push(
        `#${issue.number} has ${issue.labels.totalCount} labels; the Urgent check read the first ${issue.labels.nodes.length}.`,
      )
    }
    return {
      number: issue.number,
      labels: issue.labels.nodes.map((/** @type {any} */ label) => label.name),
    }
  })
  return { pull: { number: pull.number, issues }, warnings }
}

/**
 * @param {{ type: { name: string } | null, milestone: { number: number } | null, labels: { name: string }[] }} issue
 *   as the REST API returns it
 * @param {{ type: string, milestone: number, labels: string[] }} want
 * @returns {string[]} what the issue lacks
 */
export function missing(issue, want) {
  const lacks = []
  if (issue.type?.name !== want.type) lacks.push(`type ${want.type}`)
  if (issue.milestone?.number !== want.milestone) lacks.push(`milestone #${want.milestone}`)
  const labels = new Set(issue.labels.map((label) => label.name))
  for (const label of want.labels) if (!labels.has(label)) lacks.push(`label ${label}`)
  return lacks
}

/** @param {string} command @param {string[]} args @param {string} [input] */
function run(command, args, input) {
  return execFileSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
}

/** @param {string} text */
const lines = (text) => text.split('\n').filter((line) => line !== '')

/** @param {string[]} args gh arguments whose --jq prints one JSON value per line */
const ghLines = (args) => lines(run('gh', args)).map((line) => JSON.parse(line))

/** @param {string} level @param {string} message */
function annotate(level, message) {
  console.log(process.env.GITHUB_ACTIONS === 'true' ? `::${level}::${message}` : message)
}

/** @param {string} message */
function fail(message) {
  annotate('error', message)
  process.exitCode = 1
}

const CLOSING = `closingIssuesReferences(first: ${PAGE}) { totalCount nodes { number labels(first: ${PAGE}) { totalCount nodes { name } } } }`

/**
 * Runs one GraphQL query of aliased fields and returns the repository's data. gh exits with 1
 * when any field is not found, though the others still resolve; those come back as null.
 *
 * @param {string} owner
 * @param {string} name
 * @param {string[]} fields
 * @returns {Record<string, any>}
 */
function repositoryQuery(owner, name, fields) {
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
  ]
  let output
  try {
    output = run('gh', args)
  } catch (error) {
    const stdout = /** @type {{ stdout?: string }} */ (error).stdout ?? ''
    const response = stdout ? JSON.parse(stdout) : null
    const errors = response?.errors ?? []
    const notFound = errors.every((/** @type {any} */ entry) => entry.type === 'NOT_FOUND')
    if (!response?.data || errors.length === 0 || !notFound) throw error
    output = stdout
  }
  return JSON.parse(output).data.repository
}

/**
 * @param {string} owner
 * @param {string} name
 * @param {Commit[]} commits
 * @returns {{ pulls: Record<string, Pull>, warnings: string[] }}
 */
function pullsOf(owner, name, commits) {
  const candidates = commits.filter(
    (commit) => FIXING.includes(typeOf(commit.subject)) && /^[0-9a-f]{40}$/.test(commit.sha),
  )
  /** @type {Record<string, Pull>} */
  const pulls = {}
  /** @type {string[]} */
  const warnings = []
  /** @type {Commit[]} */
  const byNumber = []
  for (let start = 0; start < candidates.length; start += 50) {
    const chunk = candidates.slice(start, start + 50)
    const data = repositoryQuery(
      owner,
      name,
      chunk.map(
        (commit, i) =>
          `c${i}: object(oid: "${commit.sha}") { ... on Commit { associatedPullRequests(first: 10) { nodes { number mergeCommit { oid } ${CLOSING} } } } }`,
      ),
    )
    chunk.forEach((commit, i) => {
      const pull = mergedPull(commit, data[`c${i}`])
      if (pull) {
        const read = readPull(commit, pull)
        if (read.pull) pulls[commit.sha] = read.pull
        warnings.push(...read.warnings)
      } else if (pullNumber(commit.subject) !== null) {
        byNumber.push(commit)
      }
    })
  }
  // A commit GitHub links to no merged pull request falls back to the number in its subject.
  for (let start = 0; start < byNumber.length; start += 50) {
    const chunk = byNumber.slice(start, start + 50)
    const data = repositoryQuery(
      owner,
      name,
      chunk.map(
        (commit, i) =>
          `p${i}: issueOrPullRequest(number: ${pullNumber(commit.subject)}) { ... on PullRequest { number ${CLOSING} } }`,
      ),
    )
    chunk.forEach((commit, i) => {
      const read = readPull(commit, data[`p${i}`])
      if (read.pull) pulls[commit.sha] = read.pull
      warnings.push(...read.warnings)
    })
  }
  return { pulls, warnings }
}

function main() {
  const dryRun = process.env.DRY_RUN === '1'
  if (run('git', ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    fail('The clone is shallow, so the commits and tags since the last release are missing.')
    return
  }
  const repo = run('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]).trim()
  const [owner, name] = repo.split('/')
  const tags = lines(
    run('git', [
      'for-each-ref',
      'refs/tags',
      '--format=%(refname:short)%09%(creatordate:iso-strict)',
    ]),
  ).map((line) => {
    const [tag, date] = line.split('\t')
    return { name: tag, date }
  })
  const lastTag = latestTag(tags.map((tag) => tag.name))
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  const commits = lines(
    run('git', ['log', '--first-parent', '--reverse', '--format=%H%x1f%cI%x1f%s', range]),
  ).map((line) => {
    const [sha, date, subject] = line.split('\x1f')
    return { sha, subject, date }
  })
  const releases = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/releases?per_page=100`,
    '--jq',
    '.[] | {tag: .tag_name, draft, prerelease, publishedAt: .published_at}',
  ])
  const milestones = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/milestones?state=open&per_page=100`,
    '--jq',
    '.[] | {number, title, openIssues: .open_issues}',
  ])
  // A list, not a search: the search index lags behind an issue opened moments ago. The list
  // holds pull requests too, which the filter drops.
  const openIssues = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/issues?state=open&per_page=100`,
    '--jq',
    '.[] | select(.pull_request == null) | {number, title}',
  ])
  const { pulls, warnings } = pullsOf(owner, name, commits)
  const decision = decide({
    now: new Date(),
    tags,
    commits,
    releases,
    milestones,
    openIssues,
    pulls,
  })
  for (const line of summary(decision)) console.log(line)
  for (const warning of [...warnings, ...decision.warnings]) annotate('warning', warning)
  if (decision.failure) {
    fail(decision.failure)
    return
  }
  if (decision.outcome !== 'open' || !('version' in decision.target)) return

  const title = issueTitle(decision.target)
  const body = issueBody(decision)
  if (dryRun) {
    console.log(`\nDry run: would open "${title}":\n\n${body}`)
    return
  }
  const want = { ...ISSUE, milestone: decision.target.milestone.number }
  // One REST call sets the type with everything else. gh issue create --type sets it in a second
  // call, after the issue exists, and on failure exits without printing which issue it opened.
  let issue = JSON.parse(
    run(
      'gh',
      ['api', '--method', 'POST', `repos/${repo}/issues`, '--input', '-'],
      JSON.stringify({ title, body, ...want }),
    ),
  )
  console.log(`Opened ${issue.html_url}`)
  // GitHub drops fields the token may not set instead of failing, so check what it kept.
  let lacks = missing(issue, want)
  if (lacks.length > 0) {
    issue = JSON.parse(
      run(
        'gh',
        ['api', '--method', 'PATCH', `repos/${repo}/issues/${issue.number}`, '--input', '-'],
        JSON.stringify(want),
      ),
    )
    lacks = missing(issue, want)
  }
  if (lacks.length > 0) {
    fail(
      `#${issue.number} lacks ${lacks.join(', ')}, which the token could not set; set them by hand.`,
    )
  }
}

if (import.meta.main) main()
