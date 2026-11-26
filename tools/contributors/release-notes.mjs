// @ts-check
// Extracts external PR and linked-issue contributors for a release range or explicit issue/PR list
// and outputs:
//   1. Per-PR / per-issue external @login attribution map
//   2. A bilingual collapsible GitHub Release Notes draft (English expanded, Simplified Chinese
//      folded in <details>, and a compact Contributors avatar row at the bottom).
//
// Usage:
//   node tools/contributors/release-notes.mjs --from v0.1.25 --to HEAD
//   node tools/contributors/release-notes.mjs --numbers 2675,2676,2679
//   node tools/contributors/release-notes.mjs --from v0.1.25 --json

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  classifyContribution,
  compareContributors,
  DEFAULT_REPO,
  extractClosingIssueNumbers,
  extractPrNumbersFromSubject,
  isExcludedUser,
  renderReleaseNotesTemplate,
} from './core.mjs'
import { resolveGitHubToken } from './update-readme.mjs'

/**
 * Fetches a single JSON resource from the GitHub REST API.
 *
 * @param {string} url
 * @param {string} token
 * @returns {Promise<any>}
 */
async function githubJson(url, token) {
  /** @type {Record<string, string>} */
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'kettu-contributors',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`GitHub API ${response.status} for ${url}: ${detail.slice(0, 200)}`)
  }
  return response.json()
}

/**
 * Uses GitHub GraphQL (when authenticated) to find closing issues connected via either
 * PR text or GitHub's Development sidebar panel.
 *
 * @param {string} repo
 * @param {number} prNumber
 * @param {string} token
 * @returns {Promise<number[]>}
 */
async function fetchClosingIssuesGraphQL(repo, prNumber, token) {
  if (!token) return []
  const [owner, name] = repo.split('/')
  if (!owner || !name) return []
  try {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'kettu-contributors',
      },
      body: JSON.stringify({
        query: `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              closingIssuesReferences(first: 20) {
                nodes { number repository { nameWithOwner } }
              }
            }
          }
        }`,
        variables: { owner, name, number: prNumber },
      }),
    })
    if (!response.ok) return []
    /** @type {any} */
    const payload = await response.json()
    const nodes = payload?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes
    if (!Array.isArray(nodes)) return []
    return nodes
      .filter(
        (node) =>
          typeof node?.number === 'number' &&
          (!node?.repository?.nameWithOwner ||
            node.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()),
      )
      .map((node) => node.number)
  } catch {
    return []
  }
}

/**
 * Returns the latest v* git tag in the repository if --from is omitted.
 *
 * @returns {string}
 */
function latestVersionTag() {
  return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Lists commits in `<from>..<to>` with subject and body.
 *
 * @param {string} fromRef
 * @param {string} toRef
 * @returns {Array<{ sha: string, subject: string, body: string }>}
 */
function readCommits(fromRef, toRef) {
  const raw = execFileSync(
    'git',
    ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', `${fromRef}..${toRef}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = '', subject = '', body = ''] = chunk.split('\x1f')
      return { sha, subject: subject.trim(), body: body.trim() }
    })
}

/**
 * Parses CLI flags.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let repo = DEFAULT_REPO
  let from = ''
  let to = 'HEAD'
  /** @type {number[]} */
  const numbers = []
  let json = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo' && argv[i + 1]) {
      repo = argv[i + 1]
      i += 1
    } else if (arg === '--from' && argv[i + 1]) {
      from = argv[i + 1]
      i += 1
    } else if (arg === '--to' && argv[i + 1]) {
      to = argv[i + 1]
      i += 1
    } else if ((arg === '--numbers' || arg === '--issues') && argv[i + 1]) {
      for (const token of argv[i + 1].split(',')) {
        const num = Number(token.trim().replace(/^#/, ''))
        if (Number.isSafeInteger(num) && num > 0) numbers.push(num)
      }
      i += 1
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage:',
          '  node tools/contributors/release-notes.mjs --from <tag> [--to <ref>] [--repo owner/name] [--json]',
          '  node tools/contributors/release-notes.mjs --numbers 2675,2676,2679 [--repo owner/name] [--json]',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { repo, from, to, numbers, json }
}

/**
 * Collects per-item attribution entries and aggregated external contributors.
 *
 * @param {{ repo: string, from: string, to: string, numbers: number[], token: string }} options
 */
async function collectReleaseAttribution({ repo, from, to, numbers, token }) {
  /** @type {Map<number, any>} */
  const issueCache = new Map()

  /** @param {number} num */
  const getIssue = async (num) => {
    if (issueCache.has(num)) return issueCache.get(num)
    const data = await githubJson(`https://api.github.com/repos/${repo}/issues/${num}`, token)
    issueCache.set(num, data)
    return data
  }

  /** @type {Array<{ number: number, extraIssues: number[] }>} */
  const targets = []
  /** @type {Set<number>} */
  const seenTargets = new Set()

  if (numbers.length > 0) {
    for (const num of numbers) {
      if (!seenTargets.has(num)) {
        seenTargets.add(num)
        targets.push({ number: num, extraIssues: [] })
      }
    }
  } else {
    const baseRef = from || latestVersionTag()
    const commits = readCommits(baseRef, to)
    for (const commit of commits) {
      const prNums = extractPrNumbersFromSubject(commit.subject)
      const commitIssues = extractClosingIssueNumbers(`${commit.subject}\n${commit.body}`, repo)
      if (prNums.length > 0) {
        for (const num of prNums) {
          if (!seenTargets.has(num)) {
            seenTargets.add(num)
            targets.push({ number: num, extraIssues: commitIssues })
          }
        }
      } else {
        for (const num of commitIssues) {
          if (!seenTargets.has(num)) {
            seenTargets.add(num)
            targets.push({ number: num, extraIssues: [] })
          }
        }
      }
    }
  }

  /** @type {import('./core.mjs').ReleaseEntry[]} */
  const entries = []
  /** @type {Map<string, import('./core.mjs').Contributor>} */
  const contributorMap = new Map()

  /**
   * @param {string} login
   * @param {'pr' | 'issue'} kind
   */
  const recordContributor = (login, kind) => {
    const key = login.toLowerCase()
    let entry = contributorMap.get(key)
    if (!entry) {
      entry = { login, prs: 0, issues: 0, total: 0 }
      contributorMap.set(key, entry)
    }
    if (kind === 'pr') entry.prs += 1
    else entry.issues += 1
    entry.total += 1
  }

  for (const target of targets) {
    const item = await getIssue(target.number)
    const isPr = item.pull_request != null
    /** @type {Set<string>} */
    const credits = new Set()
    /** @type {Set<number>} */
    const linked = new Set(target.extraIssues)

    if (isPr) {
      // Only merged PRs count as PR contributions.
      if (item.pull_request.merged_at != null && !isExcludedUser(item.user)) {
        const login = String(item.user.login).trim()
        credits.add(login)
        recordContributor(login, 'pr')
      }
      for (const issueNum of extractClosingIssueNumbers(item.body ?? '', repo)) {
        linked.add(issueNum)
      }
      for (const issueNum of await fetchClosingIssuesGraphQL(repo, target.number, token)) {
        linked.add(issueNum)
      }
      linked.delete(target.number)

      for (const issueNum of [...linked].sort((a, b) => a - b)) {
        const issue = await getIssue(issueNum)
        if (classifyContribution(issue) === 'issue') {
          const login = String(issue.user.login).trim()
          credits.add(login)
          recordContributor(login, 'issue')
        }
      }
    } else if (classifyContribution(item) === 'issue') {
      const login = String(item.user.login).trim()
      credits.add(login)
      recordContributor(login, 'issue')
    }

    entries.push({
      number: target.number,
      kind: isPr ? 'pr' : 'issue',
      title: typeof item.title === 'string' ? item.title : '',
      credits: [...credits].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      linkedIssues: [...linked].sort((a, b) => a - b),
    })
  }

  const contributors = [...contributorMap.values()].sort(compareContributors)
  return { entries, contributors }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const token = resolveGitHubToken()
  const { entries, contributors } = await collectReleaseAttribution({ ...args, token })
  const template = renderReleaseNotesTemplate({ entries, contributors })

  if (args.json) {
    console.log(JSON.stringify({ repo: args.repo, entries, contributors, template }, null, 2))
    return
  }

  console.log('# External contributor attribution map\n')
  for (const entry of entries) {
    const linkedPart =
      entry.linkedIssues.length > 0
        ? ` (issues: ${entry.linkedIssues.map((n) => `#${n}`).join(', ')})`
        : ''
    const creditPart =
      entry.credits.length > 0 ? entry.credits.map((u) => `@${u}`).join(', ') : '(maintainer only)'
    console.log(`- #${entry.number}${linkedPart}: ${creditPart} — ${entry.title}`)
  }

  console.log('\n# Release notes draft\n')
  process.stdout.write(template)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
