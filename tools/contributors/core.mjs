// @ts-check
// 社区贡献者聚合、综合贡献值排序、README 头像墙渲染、关联 Issue 解析与双语平铺发布说明模板纯函数。

export const DEFAULT_REPO = 'KettuAI/Kettu'

export const START_MARKER = '<!-- contributors:start -->'
export const END_MARKER = '<!-- contributors:end -->'

/** 项目维护者账号（小写）：README 贡献者墙纳入统计，单版本发布说明致谢中可选排除。 */
export const MAINTAINER_LOGINS = new Set(['amigoer'])

/** 排除的官方自动化账号、机器人与系统保留账号（小写）。 */
export const EXCLUDED_LOGINS = new Set([
  'kettu-builder',
  'kettu-planner',
  'kettu-reviewer',
  'kettu-ops',
  'dependabot',
  'github-actions',
  'renovate',
  'copilot',
  'ghost',
])

/** 开启中的 Issue 若带以下任意标签，则暂不计入已采纳社区贡献（小写）。 */
export const EXCLUDED_ISSUE_LABELS = new Set(['needs-info', 'invalid', 'duplicate', 'wontfix'])

/** 各类公开贡献的权重配置，用于计算综合贡献值并排序。 */
export const CONTRIBUTION_WEIGHTS = Object.freeze({
  /** 每次代码提交的贡献值 */
  commit: 1,
  /** 每个已合并 PR 的贡献值 */
  pr: 5,
  /** 每个已解决关闭（completed）公开 Issue 的贡献值 */
  completedIssue: 2,
  /** 每个已采纳开启中公开 Issue 的贡献值 */
  openIssue: 1,
})

/** 允许输出的 GitHub 头像 CDN 源。 */
const ALLOWED_AVATAR_ORIGIN = 'https://avatars.githubusercontent.com'

/**
 * @typedef {{ login?: string | null, type?: string | null, avatar_url?: string | null, avatarUrl?: string | null }} GitHubUser
 * @typedef {{ name?: string | null }} GitHubLabel
 * @typedef {{
 *   login?: string | null
 *   type?: string | null
 *   avatar_url?: string | null
 *   avatarUrl?: string | null
 *   contributions?: number | null
 * }} GitHubCommitContributor
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
 * @typedef {{
 *   login: string
 *   avatarUrl: string
 *   commits: number
 *   prs: number
 *   completedIssues: number
 *   openIssues: number
 *   issues: number
 *   total: number
 *   score: number
 * }} Contributor
 * @typedef {{
 *   number: number
 *   kind: 'pr' | 'issue'
 *   title: string
 *   credits: string[]
 *   linkedIssues: number[]
 * }} ReleaseEntry
 * @typedef {{ excludeMaintainers?: boolean }} ExcludeOptions
 */

/**
 * 判断账号是否应排除：默认排除所有机器人、自动化与系统保留账号，传入 excludeMaintainers 时同时排除维护者。
 *
 * @param {GitHubUser | null | undefined} user
 * @param {ExcludeOptions} [options]
 * @returns {boolean}
 */
export function isExcludedUser(user, options = {}) {
  const login = typeof user?.login === 'string' ? user.login.trim() : ''
  if (!login) return true
  const lower = login.toLowerCase()
  if (EXCLUDED_LOGINS.has(lower)) return true
  if (options.excludeMaintainers && MAINTAINER_LOGINS.has(lower)) return true
  if (typeof user?.type === 'string' && user.type.toLowerCase() === 'bot') return true
  if (lower.endsWith('[bot]')) return true
  return false
}

/**
 * 构造直连 avatars.githubusercontent.com 的 GitHub 头像地址。
 *
 * @param {string} login
 * @param {number} [size]
 * @returns {string}
 */
export function githubAvatarUrl(login, size = 96) {
  return `${ALLOWED_AVATAR_ORIGIN}/${encodeURIComponent(login)}?s=${size}`
}

/**
 * 规范化 GitHub API 返回的头像地址：仅保留 avatars.githubusercontent.com 域名并统一设置尺寸参数。
 *
 * @param {string | null | undefined} rawUrl
 * @param {string} login
 * @param {number} [size]
 * @returns {string}
 */
export function normalizeGitHubAvatarUrl(rawUrl, login, size = 96) {
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl)
      if (parsed.origin === ALLOWED_AVATAR_ORIGIN) {
        parsed.searchParams.set('s', String(size))
        parsed.searchParams.delete('size')
        return parsed.toString()
      }
    } catch {
      // 非法 URL 时回退到按登录名生成的直链
    }
  }
  return githubAvatarUrl(login, size)
}

/**
 * 判断头像地址是否已是带用户数字 ID 的永久 CDN 地址（/u/<id>）。
 *
 * @param {string} url
 * @returns {boolean}
 */
function isCanonicalAvatarUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin === ALLOWED_AVATAR_ORIGIN && parsed.pathname.startsWith('/u/')
  } catch {
    return false
  }
}

/**
 * 提取并归一化 Issue 标签名称（小写）。
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
 * 对单条 GitHub Issue 或 PR 进行贡献类型判定：
 * - 已合并 PR 返回 'pr'
 * - 已解决关闭（completed）Issue 返回 'completed_issue'
 * - 未带排除标签的开启中 Issue 返回 'open_issue'
 * - 其余返回 null
 *
 * @param {GitHubIssueLike} item
 * @param {ExcludeOptions} [options]
 * @returns {'pr' | 'completed_issue' | 'open_issue' | null}
 */
export function classifyContribution(item, options = {}) {
  if (!item || isExcludedUser(item.user, options)) return null
  if (item.pull_request != null) {
    return item.pull_request.merged_at != null ? 'pr' : null
  }
  const state = typeof item.state === 'string' ? item.state.toLowerCase() : ''
  if (state === 'closed') {
    const reason = typeof item.state_reason === 'string' ? item.state_reason.toLowerCase() : ''
    return reason === 'completed' ? 'completed_issue' : null
  }
  if (state === 'open') {
    const names = labelNames(item.labels)
    if (names.some((name) => EXCLUDED_ISSUE_LABELS.has(name))) return null
    return 'open_issue'
  }
  return null
}

/**
 * 按统一权重计算单个贡献者的综合贡献值。
 *
 * @param {{ commits: number, prs: number, completedIssues: number, openIssues: number }} counts
 * @returns {number}
 */
export function calculateContributionScore(counts) {
  return (
    counts.commits * CONTRIBUTION_WEIGHTS.commit +
    counts.prs * CONTRIBUTION_WEIGHTS.pr +
    counts.completedIssues * CONTRIBUTION_WEIGHTS.completedIssue +
    counts.openIssues * CONTRIBUTION_WEIGHTS.openIssue
  )
}

/**
 * 稳定排序比较器：综合贡献值降序 -> 已合并 PR 数降序 -> 代码提交数降序 -> 已解决 Issue 数降序 -> 有效 Issue 总数降序 -> 登录名字典序。
 *
 * @param {Contributor} a
 * @param {Contributor} b
 * @returns {number}
 */
export function compareContributors(a, b) {
  if (b.score !== a.score) return b.score - a.score
  if (b.prs !== a.prs) return b.prs - a.prs
  if (b.commits !== a.commits) return b.commits - a.commits
  if (b.completedIssues !== a.completedIssues) return b.completedIssues - a.completedIssues
  if (b.issues !== a.issues) return b.issues - a.issues
  const aLower = a.login.toLowerCase()
  const bLower = b.login.toLowerCase()
  if (aLower !== bLower) return aLower < bLower ? -1 : 1
  return a.login < b.login ? -1 : a.login > b.login ? 1 : 0
}

/**
 * 聚合仓库代码提交、已合并 PR 与有效公开 Issue 贡献者，按综合贡献值降序稳定排序。
 *
 * @param {Iterable<GitHubIssueLike>} items
 * @param {{
 *   commitContributors?: Iterable<GitHubCommitContributor>
 *   excludeMaintainers?: boolean
 * }} [options]
 * @returns {Contributor[]}
 */
export function aggregateContributors(items, options = {}) {
  const excludeOptions = { excludeMaintainers: Boolean(options.excludeMaintainers) }
  /** @type {Map<string, Contributor>} */
  const byLogin = new Map()

  /**
   * @param {GitHubUser} user
   * @returns {Contributor}
   */
  const ensure = (user) => {
    const login = String(user.login).trim()
    const key = login.toLowerCase()
    const rawAvatar = user.avatarUrl ?? user.avatar_url ?? null
    const candidateAvatar = normalizeGitHubAvatarUrl(rawAvatar, login, 96)
    let entry = byLogin.get(key)
    if (!entry) {
      entry = {
        login,
        avatarUrl: candidateAvatar,
        commits: 0,
        prs: 0,
        completedIssues: 0,
        openIssues: 0,
        issues: 0,
        total: 0,
        score: 0,
      }
      byLogin.set(key, entry)
    } else if (!isCanonicalAvatarUrl(entry.avatarUrl) && isCanonicalAvatarUrl(candidateAvatar)) {
      entry.avatarUrl = candidateAvatar
    }
    return entry
  }

  for (const record of options.commitContributors ?? []) {
    if (!record || typeof record.contributions !== 'number' || record.contributions <= 0) continue
    if (isExcludedUser(record, excludeOptions)) continue
    const entry = ensure(record)
    entry.commits += Math.floor(record.contributions)
  }

  for (const item of items) {
    const kind = classifyContribution(item, excludeOptions)
    if (!kind || !item.user?.login) continue
    const entry = ensure(item.user)
    if (kind === 'pr') entry.prs += 1
    else if (kind === 'completed_issue') entry.completedIssues += 1
    else entry.openIssues += 1
  }

  /** @type {Contributor[]} */
  const list = []
  for (const entry of byLogin.values()) {
    entry.issues = entry.completedIssues + entry.openIssues
    entry.total = entry.commits + entry.prs + entry.issues
    entry.score = calculateContributionScore(entry)
    if (entry.score > 0) list.push(entry)
  }

  return list.sort(compareContributors)
}

/**
 * 转义双引号 HTML 属性值。
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
 * 渲染紧凑、GitHub 原生支持的头像墙 HTML（直连 avatars.githubusercontent.com，不使用第三方代理或内联样式）。
 *
 * @param {ReadonlyArray<{ login: string, avatarUrl?: string | null }>} contributors
 * @param {{ size?: number }} [options]
 * @returns {string}
 */
export function renderAvatarWall(contributors, options = {}) {
  const size = options.size ?? 48
  if (contributors.length === 0) return ''
  const items = contributors.map((contributor) => {
    const { login } = contributor
    const encoded = encodeURIComponent(login)
    const label = escapeAttr(`@${login}`)
    const avatarSrc = escapeAttr(normalizeGitHubAvatarUrl(contributor.avatarUrl, login, 96))
    return `  <a href="https://github.com/${encoded}" title="${label}"><img src="${avatarSrc}" width="${size}" height="${size}" alt="${label}"></a>`
  })
  return ['<p>', ...items, '</p>'].join('\n')
}

/**
 * 渲染插入在 README 标记区间内的完整贡献者区块。
 *
 * @param {ReadonlyArray<{ login: string, avatarUrl?: string | null }>} contributors
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
 * 仅从 START_MARKER 与 END_MARKER 区间内提取已有贡献者登录名列表。
 *
 * @param {string} content
 * @returns {string[]}
 */
export function extractExistingContributorLogins(content) {
  const startIndex = content.indexOf(START_MARKER)
  const endIndex = content.indexOf(END_MARKER)
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return []

  const section = content.slice(startIndex + START_MARKER.length, endIndex)
  /** @type {string[]} */
  const logins = []
  /** @type {Set<string>} */
  const seen = new Set()

  for (const match of section.matchAll(/<a\s+href="https:\/\/github\.com\/([^/"?#]+)"/gi)) {
    const raw = match[1]
    if (!raw) continue
    let decoded
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      decoded = raw
    }
    const login = decoded.trim()
    if (!login) continue
    const key = login.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    logins.push(login)
  }

  return logins
}

/**
 * 统计 GitHub `/issues` 响应中的标准 Issue 与 PR 数量。
 *
 * @param {Iterable<GitHubIssueLike>} items
 * @returns {{ total: number, issues: number, pullRequests: number }}
 */
export function countApiItemKinds(items) {
  let total = 0
  let issues = 0
  let pullRequests = 0
  for (const item of items) {
    if (!item) continue
    total += 1
    if (item.pull_request != null) pullRequests += 1
    else issues += 1
  }
  return { total, issues, pullRequests }
}

/**
 * 防止 GitHub API 权限不足或返回空数据时误清空/大幅截断已有 README 贡献者墙。
 *
 * @param {{
 *   existingLogins: ReadonlyArray<string>
 *   nextContributors: ReadonlyArray<{ login: string }>
 *   items: Iterable<GitHubIssueLike>
 *   allowShrink?: boolean
 * }} input
 */
export function assertSafeContributorUpdate({
  existingLogins,
  nextContributors,
  items,
  allowShrink = false,
}) {
  if (existingLogins.length === 0) return

  const counts = countApiItemKinds(items)
  const nextKeys = new Set(nextContributors.map((c) => c.login.trim().toLowerCase()))
  const dropped = existingLogins.filter((login) => !nextKeys.has(login.trim().toLowerCase()))

  if (nextContributors.length === 0) {
    if (counts.total === 0) {
      throw new Error(
        `Refusing to clear ${existingLogins.length} existing contributors: GitHub API returned 0 items. Check authentication and repository access.`,
      )
    }
    if (counts.pullRequests > 0 && counts.issues === 0) {
      throw new Error(
        `Refusing to clear ${existingLogins.length} existing contributors: GitHub API returned ${counts.pullRequests} pull requests and 0 issues. Ensure GITHUB_TOKEN has "issues: read" permission.`,
      )
    }
    if (counts.issues > 0 && counts.pullRequests === 0) {
      throw new Error(
        `Refusing to clear ${existingLogins.length} existing contributors: GitHub API returned ${counts.issues} issues and 0 pull requests. Ensure GITHUB_TOKEN has "pull-requests: read" permission.`,
      )
    }
    throw new Error(
      `Refusing to clear ${existingLogins.length} existing contributors: aggregation produced 0 contributors from ${counts.total} API items.`,
    )
  }

  if (!allowShrink && dropped.length > 0) {
    if (counts.pullRequests > 0 && counts.issues === 0) {
      throw new Error(
        `Refusing to drop ${dropped.length} of ${existingLogins.length} existing contributors: GitHub API returned ${counts.pullRequests} pull requests and 0 issues. Ensure GITHUB_TOKEN has "issues: read" permission.`,
      )
    }
    if (counts.issues > 0 && counts.pullRequests === 0) {
      throw new Error(
        `Refusing to drop ${dropped.length} of ${existingLogins.length} existing contributors: GitHub API returned ${counts.issues} issues and 0 pull requests. Ensure GITHUB_TOKEN has "pull-requests: read" permission.`,
      )
    }
    if (existingLogins.length >= 4 && dropped.length >= Math.ceil(existingLogins.length / 2)) {
      throw new Error(
        `Refusing to drop ${dropped.length} of ${existingLogins.length} existing contributors (${nextContributors.length} remaining). Pass --allow-shrink if this removal is intentional.`,
      )
    }
  }
}

/**
 * 幂等插入或更新 README.md / README.zh-CN.md 中的贡献者墙区块。
 *
 * @param {string} content
 * @param {ReadonlyArray<{ login: string, avatarUrl?: string | null }>} contributors
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
 * 从 git 提交标题中提取 PR 编号（例如 "(#2679)" 或 "Merge pull request #2679"）。
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
 * 从 PR 或提交正文中提取关闭/修复关联的 Issue 编号（如 "Closes #2675"）。
 *
 * @param {string} text
 * @param {string} [repo]
 * @returns {number[]}
 */
export function extractClosingIssueNumbers(text, repo = DEFAULT_REPO) {
  if (!text) return []
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 匹配 GitHub 关闭关键词后跟一个或多个同仓库 Issue 编号
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
 * 去掉常规提交前缀与末尾 PR 编号，生成干净的发布条目文案。
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
 * 格式化发布说明条目末尾的致谢后缀。
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
 * 渲染兼容桌面端更新弹窗解析器的平铺双语 GitHub Release Notes 草稿：
 * 英文区块与中文区块平铺展示（不使用 `<details>` 折叠），正文条目内保留 `@login` 致谢，
 * 不在文末重复拼接手写 `## Contributors` 头像块（由 GitHub Releases 原生 Contributors 栏统一展示）。
 *
 * @param {{
 *   entries: ReadonlyArray<ReleaseEntry>
 *   contributors?: ReadonlyArray<Contributor>
 * }} input
 * @returns {string}
 */
export function renderReleaseNotesTemplate({ entries }) {
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
    '## 中文',
    '',
    ...(zhBullets.length > 0 ? zhBullets : ['- <!-- 在此处填写中文更新说明。 -->']),
  ]

  return `${sections.join('\n')}\n`
}
