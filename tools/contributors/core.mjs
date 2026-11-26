// @ts-check
// Pure logic for community contributor aggregation, README avatar wall rendering,
// linked-issue parsing, and bilingual collapsible release notes templates.

export const DEFAULT_REPO = 'KettuAI/Kettu'

export const START_MARKER = '<!-- contributors:start -->'
export const END_MARKER = '<!-- contributors:end -->'

/** Maintainers and automation accounts excluded from community contributor credits. */
export const EXCLUDED_LOGINS = new Set([
  'amigoer',
  'kettu-builder',
  'kettu-planner',
  'kettu-reviewer',
  'kettu-ops',
])

/** Labels that disqualify an open issue from counting as an accepted contribution. */
export const EXCLUDED_ISSUE_LABELS = new Set(['needs-info', 'invalid', 'duplicate', 'wontfix'])

/**
 * @typedef {{ login?: string | null, type?: string | null }} GitHubUser
 * @typedef {{ name?: string | null }} GitHubLabel
 * @typedef {{
 *   number: number
 *   title?: string | null
 *   body?: string | null
 *   state?: string | null
 *   state_reason?: string | null
 *   user?: GitHubUser | null
 *   labels?: ReadonlyArray<string | GitHubLabel> | null
 *   pull_request?: { merged_at?: string | null } | null
 * }} GitHubIssueLike
 * @typedef {{ login: string, prs: number, issues: number, total: number }} Contributor
 * @typedef {{
 *   number: number
 *   kind: 'pr' | 'issue'
 *   title: string
 *   credits: string[]
 *   linkedIssues: number[]
 * }} ReleaseEntry
 */

/**
 * Whether an account is a maintainer, automation account, bot, or missing a login.
 *
 * @param {GitHubUser | null | undefined} user
 * @returns {boolean}
 */
export function isExcludedUser(user) {
  const login = typeof user?.login === 'string' ? user.login.trim() : ''
  if (!login) return true
  const lower = login.toLowerCase()
  if (EXCLUDED_LOGINS.has(lower)) return true
  if (user?.type === 'Bot') return true
  if (lower.endsWith('[bot]')) return true
  return false
}

/**
 * Extracts normalized lower-case label names from a GitHub issue payload.
 *
 * @param {ReadonlyArray<string | GitHubLabel> | null | undefined} labels
 * @returns {string[]}
 */
function labelNames(labels) {
  if (!Array.isArray(labels)) return []
  /** @type {string[]} */
  const out = []
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name
    if (typeof name === 'string' && name.trim()) out.push(name.trim().toLowerCase())
  }
  return out
}

/**
 * Classifies a GitHub issue or pull request item for contributor eligibility.
 * Returns 'pr' for merged PRs, 'issue' for completed or accepted open issues, or null otherwise.
 *
 * @param {GitHubIssueLike} item
 * @returns {'pr' | 'issue' | null}
 */
export function classifyContribution(item) {
  if (!item || isExcludedUser(item.user)) return null
  if (item.pull_request != null) {
    return item.pull_request.merged_at != null ? 'pr' : null
  }
  if (item.state === 'closed') {
    return item.state_reason === 'completed' ? 'issue' : null
  }
  if (item.state === 'open') {
    const names = labelNames(item.labels)
    if (names.some((name) => EXCLUDED_ISSUE_LABELS.has(name))) return null
    return 'issue'
  }
  return null
}

/**
 * Deterministic comparator: highest total count first, then ASCII/case-insensitive login order.
 *
 * @param {Contributor} a
 * @param {Contributor} b
 * @returns {number}
 */
export function compareContributors(a, b) {
  if (b.total !== a.total) return b.total - a.total
  const aLower = a.login.toLowerCase()
  const bLower = b.login.toLowerCase()
  if (aLower !== bLower) return aLower < bLower ? -1 : 1
  return a.login < b.login ? -1 : a.login > b.login ? 1 : 0
}

/**
 * Aggregates eligible external contributors from GitHub issues and pull requests.
 *
 * @param {Iterable<GitHubIssueLike>} items
 * @returns {Contributor[]}
 */
export function aggregateContributors(items) {
  /** @type {Map<string, Contributor>} */
  const byLogin = new Map()
  for (const item of items) {
    const kind = classifyContribution(item)
    if (!kind) continue
    const rawLogin = item.user?.login
    if (typeof rawLogin !== 'string') continue
    const login = rawLogin.trim()
    const key = login.toLowerCase()
    let entry = byLogin.get(key)
    if (!entry) {
      entry = { login, prs: 0, issues: 0, total: 0 }
      byLogin.set(key, entry)
    }
    if (kind === 'pr') entry.prs += 1
    else entry.issues += 1
    entry.total += 1
  }
  return [...byLogin.values()].sort(compareContributors)
}

/**
 * Escapes text for use inside double-quoted HTML attributes.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Renders a compact, GitHub-safe avatar grid using native GitHub avatars only.
 *
 * @param {ReadonlyArray<{ login: string }>} contributors
 * @param {{ size?: number }} [options]
 * @returns {string}
 */
export function renderAvatarWall(contributors, options = {}) {
  const size = options.size ?? 48
  if (contributors.length === 0) return ''
  const items = contributors.map(({ login }) => {
    const encoded = encodeURIComponent(login)
    const label = escapeAttr(`@${login}`)
    return `  <a href="https://github.com/${encoded}" title="${label}"><img src="https://github.com/${encoded}.png?size=96" width="${size}" height="${size}" alt="${label}"></a>`
  })
  return ['<p>', ...items, '</p>'].join('\n')
}

/**
 * Renders the body placed between START_MARKER and END_MARKER in README files.
 *
 * @param {ReadonlyArray<{ login: string }>} contributors
 * @param {'en' | 'zh-CN'} locale
 * @returns {string}
 */
export function renderContributorsBlock(contributors, locale) {
  const intro =
    locale === 'zh-CN'
      ? '感谢每一位帮助打磨 Kettu 的社区协作者——无论是提交 PR 的开发者，还是提出被采纳 Issue 与反馈的朋友，都在共同塑造这款产品。'
      : 'Thank you to everyone helping shape Kettu — whether through merged pull requests or through accepted bug reports, ideas, and feedback.'
  const wall = renderAvatarWall(contributors, { size: 48 })
  const inner = wall ? `${intro}\n\n${wall}` : intro
  return `${START_MARKER}\n\n${inner}\n\n${END_MARKER}`
}

/**
 * Inserts or idempotently updates the Contributors section in README.md / README.zh-CN.md.
 *
 * @param {string} content
 * @param {ReadonlyArray<{ login: string }>} contributors
 * @param {'en' | 'zh-CN'} locale
 * @returns {string}
 */
export function updateReadmeContent(content, contributors, locale) {
  const block = renderContributorsBlock(contributors, locale)
  const startIndex = content.indexOf(START_MARKER)
  const endIndex = content.indexOf(END_MARKER)

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = content.slice(0, startIndex)
    const after = content.slice(endIndex + END_MARKER.length)
    return `${before}${block}${after}`
  }

  const heading = locale === 'zh-CN' ? '## 贡献者' : '## Contributors'
  const anchors =
    locale === 'zh-CN'
      ? ['\n## 社区与参与贡献\n', '\n## 反馈\n']
      : ['\n## Community & Contributing\n', '\n## Feedback\n']

  for (const anchor of anchors) {
    const index = content.indexOf(anchor)
    if (index !== -1) {
      const before = content.slice(0, index)
      const after = content.slice(index)
      return `${before}\n${heading}\n\n${block}\n${after}`
    }
  }

  throw new Error(
    `Could not locate Contributors markers or target anchor heading for locale "${locale}"`,
  )
}

/**
 * Extracts pull request numbers mentioned in git commit subjects, e.g. "(#2679)" or
 * "Merge pull request #2679".
 *
 * @param {string} subject
 * @returns {number[]}
 */
export function extractPrNumbersFromSubject(subject) {
  /** @type {Set<number>} */
  const numbers = new Set()
  for (const match of subject.matchAll(/\(#(\d+)\)|Merge pull request #(\d+)\b/gi)) {
    const raw = match[1] ?? match[2]
    const num = Number(raw)
    if (Number.isSafeInteger(num) && num > 0) numbers.add(num)
  }
  return [...numbers]
}

/**
 * Extracts closing/linked issue numbers from PR or commit text (e.g. "Closes #2675",
 * "Fixes #2675, #2676", "Resolves KettuAI/Kettu#2675").
 *
 * @param {string} text
 * @param {string} [repo]
 * @returns {number[]}
 */
export function extractClosingIssueNumbers(text, repo = DEFAULT_REPO) {
  if (!text) return []
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match GitHub closing keywords followed by one or more issue refs in the same repository.
  const clause = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*:?\\s*((?:(?:${escapedRepo})?#\\d+(?:\\s*(?:,|and)\\s*)?)+)`,
    'gi',
  )
  const ref = new RegExp(`(?:${escapedRepo})?#(\\d+)`, 'gi')
  /** @type {Set<number>} */
  const numbers = new Set()
  for (const match of text.matchAll(clause)) {
    const group = match[1] ?? ''
    for (const item of group.matchAll(ref)) {
      const num = Number(item[1])
      if (Number.isSafeInteger(num) && num > 0) numbers.add(num)
    }
  }
  return [...numbers].sort((a, b) => a - b)
}

/**
 * Strips conventional commit prefix and trailing PR ref from a title for cleaner release bullets.
 *
 * @param {string} title
 * @returns {string}
 */
function cleanTitle(title) {
  return title
    .replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .trim()
}

/**
 * Formats inline attribution suffix for a release bullet.
 *
 * @param {number[]} refs
 * @param {string[]} credits
 * @param {'en' | 'zh-CN'} locale
 * @returns {string}
 */
export function formatAttribution(refs, credits, locale) {
  const uniqueRefs = [...new Set(refs)].sort((a, b) => a - b)
  const refPart = uniqueRefs.map((n) => `#${n}`).join(', ')
  const mentionPart = credits.map((login) => `@${login}`).join(locale === 'zh-CN' ? '、' : ', ')
  if (refPart && mentionPart) {
    return locale === 'zh-CN'
      ? `(${refPart}，感谢 ${mentionPart})`
      : `(${refPart}, thanks ${mentionPart})`
  }
  if (refPart) return `(${refPart})`
  if (mentionPart) {
    return locale === 'zh-CN' ? `(感谢 ${mentionPart})` : `(thanks ${mentionPart})`
  }
  return ''
}

/**
 * Renders the compact Contributors avatar row appended to GitHub Release Notes.
 *
 * @param {ReadonlyArray<{ login: string }>} contributors
 * @returns {string}
 */
export function renderReleaseContributorsSection(contributors) {
  if (contributors.length === 0) return ''
  return ['## Contributors', '', renderAvatarWall(contributors, { size: 36 })].join('\n')
}

/**
 * Renders a bilingual collapsible GitHub Release Notes draft compatible with
 * the desktop updater's releaseHighlights() parser.
 *
 * @param {{
 *   entries: ReadonlyArray<ReleaseEntry>
 *   contributors: ReadonlyArray<Contributor>
 * }} input
 * @returns {string}
 */
export function renderReleaseNotesTemplate({ entries, contributors }) {
  const enBullets = entries.map((entry) => {
    const refs = entry.linkedIssues.length > 0 ? entry.linkedIssues : [entry.number]
    const suffix = formatAttribution(refs, entry.credits, 'en')
    const summary = cleanTitle(entry.title) || `Change #${entry.number}`
    return suffix ? `- ${summary} ${suffix}` : `- ${summary}`
  })

  const zhBullets = entries.map((entry) => {
    const refs = entry.linkedIssues.length > 0 ? entry.linkedIssues : [entry.number]
    const suffix = formatAttribution(refs, entry.credits, 'zh-CN')
    const summary = cleanTitle(entry.title) || `变更 #${entry.number}`
    return suffix ? `- ${summary} ${suffix}` : `- ${summary}`
  })

  const sections = [
    '## What changed',
    '',
    ...(enBullets.length > 0 ? enBullets : ['- <!-- Summarize notable changes here. -->']),
    '',
    '<details>',
    '<summary>简体中文更新说明</summary>',
    '',
    '## 中文',
    '',
    ...(zhBullets.length > 0 ? zhBullets : ['- <!-- 在此处填写中文更新说明。 -->']),
    '',
    '</details>',
  ]

  const creditsSection = renderReleaseContributorsSection(contributors)
  if (creditsSection) {
    sections.push('', creditsSection)
  }

  return `${sections.join('\n')}\n`
}
