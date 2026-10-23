// @ts-check
// Opens a "Release vX.Y.Z" issue when a trigger in docs/workflow.md#6-release has fired and no
// release is open. CI runs it on every push to main and once a day; run it the same way, with
// DRY_RUN=1 to print the decision without opening anything:
//
//   DRY_RUN=1 node tools/workflow/release-check.mjs
//
// It reads main's history with git, so it needs every commit and tag, and GitHub with gh. No
// dependencies.

import { execFileSync } from 'node:child_process'
import { parseTitle } from './commit-title.mjs'

const USER_VISIBLE = ['feat', 'fix', 'perf']
const COUNT = 10
const HOUR = 60 * 60 * 1000
const SPACING = 24 * HOUR
const PERIOD = 7 * 24 * HOUR
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/
const RELEASE_ISSUE = /^Release v\d+\.\d+\.\d+\b/
const STEPS = 'https://github.com/overbench/overbench/blob/main/docs/workflow.md#6-release'
const ISSUE = { type: 'Task', labels: ['state:ready', 'area:build'] }

/** @typedef {{ sha: string, subject: string }} Commit */
/** @typedef {{ tag: string, draft: boolean, publishedAt: string | null }} Release */
/** @typedef {{ number: number, title: string, openIssues: number }} Milestone */
/** @typedef {{ number: number, title: string }} Item */
/** @typedef {{ number: number, labels: string[] }} LinkedIssue */
/** @typedef {{ name: 'Urgent' | 'Count' | 'Time', detail: string }} Trigger */
/** @typedef {{ version: string, milestone: Milestone, minor: boolean } | { problem: string }} Target */

/**
 * @typedef {object} Input
 * @property {Date} now
 * @property {string | null} lastTag the latest version tag on main, null before the first
 * @property {Commit[]} commits main's commits since lastTag, oldest first
 * @property {Release[]} releases
 * @property {Milestone[]} milestones the open ones
 * @property {Item[]} openIssues
 * @property {Item[]} openPulls
 * @property {Record<number, LinkedIssue[]>} closingIssues by the number of the pull request that
 *   closed them, for the pull requests in commits
 */

/**
 * @typedef {object} Decision
 * @property {'open' | 'none' | 'release-open' | 'no-version'} outcome
 * @property {string | null} lastTag
 * @property {{ tag: string, at: Date } | null} lastPublished
 * @property {Commit[]} commits
 * @property {Commit[]} changes the user-visible commits
 * @property {Trigger[]} fired
 * @property {Trigger[]} held fired, but within 24 hours of the last release
 * @property {string | null} releaseOpen why a release counts as open
 * @property {Target} target
 * @property {Date | null} heldUntil
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
  const type = parseTitle(subject)?.type
  return type !== undefined && USER_VISIBLE.includes(type)
}

/**
 * @param {string} subject
 * @returns {number | null} the pull request the squash merge names at the end
 */
export function pullNumber(subject) {
  const match = / \(#(\d+)\)$/.exec(subject)
  return match ? Number(match[1]) : null
}

/** @param {string} title */
function isReleasePull(title) {
  const parts = parseTitle(title)
  return parts?.type === 'chore' && parts.scope === 'release'
}

/**
 * @param {Release[]} releases
 * @returns {{ tag: string, at: Date } | null}
 */
export function lastPublished(releases) {
  let last = null
  for (const release of releases) {
    if (release.draft || !release.publishedAt) continue
    const at = new Date(release.publishedAt)
    if (!last || at > last.at) last = { tag: release.tag, at }
  }
  return last
}

/**
 * A release takes the earliest open patch milestone after the last tag. Once nothing is left
 * before a minor's own milestone and its issues have closed, it takes the minor.
 *
 * @param {Milestone[]} milestones
 * @param {string | null} lastTag
 * @returns {Target}
 */
export function releaseTarget(milestones, lastTag) {
  const last = lastTag ? parseVersion(lastTag) : null
  const planned = milestones
    .flatMap((milestone) => {
      const version = parseVersion(milestone.title)
      return version && (!last || compareVersions(version, last) > 0)
        ? [{ milestone, version }]
        : []
    })
    .sort((a, b) => compareVersions(a.version, b.version))
  const next = planned[0]
  if (!next) {
    return {
      problem: lastTag
        ? `No open milestone is planned after ${lastTag}.`
        : 'No open milestone is planned.',
    }
  }
  const { milestone, version } = next
  const minor = version[2] === 0
  if (minor && milestone.openIssues > 0) {
    return {
      problem: `No patch milestone is open before ${milestone.title}, which still has ${plural(milestone.openIssues, 'open issue', 'open issues')}.`,
    }
  }
  return { version: milestone.title, milestone, minor }
}

/**
 * @param {Pick<Input, 'lastTag' | 'commits' | 'releases' | 'openIssues' | 'openPulls'>} input
 * @returns {string | null} why a release counts as open, or null when none is
 */
export function releaseOpen({ lastTag, commits, releases, openIssues, openPulls }) {
  const issue = openIssues.find((item) => RELEASE_ISSUE.test(item.title))
  if (issue) return `#${issue.number}, "${issue.title}", is open.`
  const pull = openPulls.find((item) => isReleasePull(item.title))
  if (pull) return `#${pull.number}, "${pull.title}", is open.`
  const merged = commits.find((commit) => isReleasePull(commit.subject))
  if (merged) return `"${merged.subject}" has merged but is not tagged yet.`
  // The workflow's token sees no drafts, so a tag without a published release is still under way.
  if (lastTag && !releases.some((release) => release.tag === lastTag && !release.draft)) {
    return `${lastTag} is tagged but not published yet.`
  }
  return null
}

/**
 * @param {Input} input
 * @returns {Decision}
 */
export function decide(input) {
  const { now, lastTag, commits, closingIssues } = input
  const published = lastPublished(input.releases)
  const changes = commits.filter((commit) => isUserVisible(commit.subject))
  const since = lastTag ? `since ${lastTag}` : 'since the first commit'

  /** @type {Trigger[]} */
  const fired = []
  /** @type {Trigger[]} */
  const held = []
  const urgent = commits.flatMap((commit) => {
    const pull = pullNumber(commit.subject)
    const issues = (pull === null ? [] : (closingIssues[pull] ?? []))
      .filter((issue) => issue.labels.includes('urgent'))
      .map((issue) => `#${issue.number}`)
    return issues.length > 0 ? [`#${pull} closed urgent ${issues.join(', ')}`] : []
  })
  if (urgent.length > 0) fired.push({ name: 'Urgent', detail: `${urgent.join('; ')}.` })

  const age = published ? now.getTime() - published.at.getTime() : null
  const spaced = age === null || age >= SPACING
  if (changes.length >= COUNT) {
    /** @type {Trigger} */
    const count = {
      name: 'Count',
      detail: `${changes.length} user-visible changes have merged ${since}.`,
    }
    if (spaced) fired.push(count)
    else held.push(count)
  }
  if (published && age !== null && age >= PERIOD && changes.length > 0) {
    fired.push({
      name: 'Time',
      detail: `${plural(Math.floor(age / (24 * HOUR)), 'day has', 'days have')} passed since ${published.tag} was published, and ${plural(changes.length, 'user-visible change has', 'user-visible changes have')} merged since.`,
    })
  }

  const open = releaseOpen(input)
  const target = releaseTarget(input.milestones, lastTag)
  /** @type {Decision['outcome']} */
  let outcome = 'none'
  if (fired.length > 0)
    outcome = open ? 'release-open' : 'problem' in target ? 'no-version' : 'open'
  return {
    outcome,
    lastTag,
    lastPublished: published,
    commits,
    changes,
    fired,
    held,
    releaseOpen: open,
    target,
    heldUntil: held.length > 0 && published ? new Date(published.at.getTime() + SPACING) : null,
  }
}

/** @param {Target} target */
function targetText(target) {
  if ('problem' in target) return `none. ${target.problem}`
  return target.minor
    ? `${target.version}, as no patch milestone is left before it and its issues have all closed.`
    : `${target.version}, the earliest open patch milestone.`
}

/** @param {{ version: string }} target */
const issueTitle = (target) => `Release ${target.version}`

/**
 * @param {Decision} decision one whose outcome is `open`
 * @returns {string} the release issue's description, in Markdown
 */
export function issueBody(decision) {
  const { fired, changes, lastTag, target } = decision
  const triggers =
    fired.length === 1
      ? [`The ${fired[0].name} trigger fired: ${fired[0].detail}`]
      : [
          'Triggers that fired:',
          '',
          ...fired.map((trigger) => `- ${trigger.name}: ${trigger.detail}`),
        ]
  return [
    ...triggers,
    '',
    `The version is ${targetText(target)} The steps are in [release](${STEPS}).`,
    '',
    `User-visible changes ${lastTag ? `since ${lastTag}` : 'so far'}:`,
    '',
    ...changes.map((commit) => `- ${commit.subject}`),
    '',
  ].join('\n')
}

/**
 * @param {Decision} decision
 * @returns {string[]} what the check found, one line each, for the log
 */
export function summary(decision) {
  const { lastTag, lastPublished: published, commits, changes, fired, held } = decision
  const lines = [
    published
      ? `Last release: ${published.tag}, published ${iso(published.at)}.`
      : 'Last release: none yet.',
    `${lastTag ? `Since ${lastTag}` : 'Since the first commit'}: ${plural(commits.length, 'commit', 'commits')}, ${changes.length} user-visible.`,
    `Version: ${targetText(decision.target)}`,
  ]
  if (fired.length === 0 && held.length === 0) lines.push('Triggers: none fired.')
  for (const trigger of fired) lines.push(`Fired: ${trigger.name}, ${trigger.detail}`)
  for (const trigger of held) {
    const until = decision.heldUntil ? iso(decision.heldUntil) : ''
    lines.push(
      `Held: ${trigger.name}, ${trigger.detail} It can fire from ${until}, 24 hours after ${published?.tag} was published.`,
    )
  }
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

/**
 * @param {string} owner
 * @param {string} name
 * @param {Commit[]} commits
 * @returns {Record<number, LinkedIssue[]>}
 */
function closingIssuesOf(owner, name, commits) {
  const pulls = [...new Set(commits.flatMap((commit) => pullNumber(commit.subject) ?? []))]
  /** @type {Record<number, LinkedIssue[]>} */
  const result = {}
  for (let start = 0; start < pulls.length; start += 50) {
    const chunk = pulls.slice(start, start + 50)
    // issueOrPullRequest, unlike pullRequest, does not fail on a number that is an issue.
    const fields = chunk.map(
      (n) =>
        `p${n}: issueOrPullRequest(number: ${n}) { ... on PullRequest { closingIssuesReferences(first: 25) { nodes { number labels(first: 25) { nodes { name } } } } } }`,
    )
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
    const repository = JSON.parse(run('gh', args)).data.repository
    for (const n of chunk) {
      /** @type {{ number: number, labels: { nodes: { name: string }[] } }[]} */
      const nodes = repository[`p${n}`]?.closingIssuesReferences?.nodes ?? []
      result[n] = nodes.map((issue) => ({
        number: issue.number,
        labels: issue.labels.nodes.map((label) => label.name),
      }))
    }
  }
  return result
}

/** @param {string} message */
function fail(message) {
  console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error::${message}` : message)
  process.exitCode = 1
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
  const lastTag = latestTag(lines(run('git', ['tag', '--merged', 'HEAD', '--list', 'v*'])))
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  const commits = lines(
    run('git', ['log', '--first-parent', '--reverse', '--format=%H%x1f%s', range]),
  ).map((line) => {
    const [sha, subject] = line.split('\x1f')
    return { sha, subject }
  })
  const releases = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/releases?per_page=100`,
    '--jq',
    '.[] | {tag: .tag_name, draft, publishedAt: .published_at}',
  ])
  const milestones = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/milestones?state=open&per_page=100`,
    '--jq',
    '.[] | {number, title, openIssues: .open_issues}',
  ])
  // A list, not a search: the search index lags behind an issue opened moments ago.
  const open = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/issues?state=open&per_page=100`,
    '--jq',
    '.[] | {number, title, pull: (.pull_request != null)}',
  ])
  const decision = decide({
    now: new Date(),
    lastTag,
    commits,
    releases,
    milestones,
    openIssues: open.filter((item) => !item.pull),
    openPulls: open.filter((item) => item.pull),
    closingIssues: closingIssuesOf(owner, name, commits),
  })
  for (const line of summary(decision)) console.log(line)

  if (decision.outcome === 'no-version' && 'problem' in decision.target) {
    fail(`A release is due, but it has no version: ${decision.target.problem}`)
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
