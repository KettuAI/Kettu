// @ts-check
// 从 GitHub API 拉取 KettuAI/Kettu 的代码提交者、已合并 PR 与有效公开 Issue，
// 按综合贡献值排序后幂等更新 README.md 与 README.zh-CN.md 中的贡献者墙。
//
// 用法：
//   node tools/contributors/update-readme.mjs
//   node tools/contributors/update-readme.mjs --check
//   node tools/contributors/update-readme.mjs --dry-run
//   node tools/contributors/update-readme.mjs --json

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  aggregateContributors,
  assertSafeContributorUpdate,
  countApiItemKinds,
  DEFAULT_REPO,
  extractExistingContributorLogins,
  updateReadmeContent,
} from './core.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const README_EN = resolve(REPO_ROOT, 'README.md')
const README_ZH = resolve(REPO_ROOT, 'README.zh-CN.md')

/**
 * 依次从环境变量或本地已登录的 `gh` CLI 读取 GitHub 令牌。
 *
 * @returns {string}
 */
export function resolveGitHubToken() {
  const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  if (fromEnv) return fromEnv
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/**
 * 从 HTTP Link 响应头解析下一页 URL。
 *
 * @param {string | null} header
 * @returns {string | null}
 */
function nextLink(header) {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/i.exec(part.trim())
    if (match) return match[1]
  }
  return null
}

/**
 * 拉取 GitHub REST 列表接口的全部页面（兼容 204 空内容响应）。
 *
 * @param {string} startUrl
 * @param {string} token
 * @returns {Promise<any[]>}
 */
export async function fetchAllPages(startUrl, token) {
  /** @type {any[]} */
  const all = []
  /** @type {string | null} */
  let url = startUrl
  /** @type {Record<string, string>} */
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'kettu-contributors',
  }
  if (token) headers.authorization = `Bearer ${token}`

  while (url) {
    const response = await fetch(url, { headers })
    if (response.status === 204) break
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `GitHub API request failed (${response.status}) for ${url}: ${detail.slice(0, 200)}`,
      )
    }
    const page = await response.json()
    if (!Array.isArray(page)) {
      throw new Error(`Unexpected non-array response from ${url}`)
    }
    all.push(...page)
    url = nextLink(response.headers.get('link'))
  }
  return all
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let repo = DEFAULT_REPO
  let check = false
  let dryRun = false
  let json = false
  let allowShrink = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') check = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--json') json = true
    else if (arg === '--allow-shrink') allowShrink = true
    else if (arg === '--repo' && argv[i + 1]) {
      repo = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tools/contributors/update-readme.mjs [--repo owner/name] [--check] [--dry-run] [--json] [--allow-shrink]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { repo, check, dryRun, json, allowShrink }
}

async function main() {
  const { repo, check, dryRun, json, allowShrink } = parseArgs(process.argv.slice(2))
  const token = resolveGitHubToken()
  const [commitContributors, items] = await Promise.all([
    fetchAllPages(`https://api.github.com/repos/${repo}/contributors?per_page=100`, token),
    fetchAllPages(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100`, token),
  ])
  const counts = countApiItemKinds(items)
  const contributors = aggregateContributors(items, { commitContributors })

  if (json) {
    console.log(JSON.stringify({ repo, count: contributors.length, contributors }, null, 2))
    return
  }

  /** @type {Array<{ path: string, locale: 'en' | 'zh-CN' }>} */
  const targets = [
    { path: README_EN, locale: 'en' },
    { path: README_ZH, locale: 'zh-CN' },
  ]

  // 写入前先校验所有目标，避免权限缺失或异常响应误清空 README 贡献者墙
  /** @type {Array<{ path: string, current: string, next: string }>} */
  const planned = targets.map((target) => {
    const current = readFileSync(target.path, 'utf8')
    const existingLogins = extractExistingContributorLogins(current)
    assertSafeContributorUpdate({
      existingLogins,
      nextContributors: contributors,
      items,
      allowShrink,
    })
    const next = updateReadmeContent(current, contributors, target.locale)
    return { path: target.path, current, next }
  })

  let changed = false
  for (const plan of planned) {
    if (plan.next !== plan.current) {
      changed = true
      if (!check && !dryRun) {
        writeFileSync(plan.path, plan.next)
      }
    }
  }

  const summary = `${contributors.length} contributors from ${commitContributors.length} commit accounts, ${counts.issues} issues, and ${counts.pullRequests} pull requests`

  if (check) {
    if (changed) {
      console.error(
        `Contributors wall is out of date (${summary}). Run: node tools/contributors/update-readme.mjs`,
      )
      process.exit(1)
    }
    console.log(`Contributors wall is up to date (${summary})`)
    return
  }

  if (dryRun) {
    console.log(`Dry run: ${summary} (${changed ? 'README files would change' : 'no changes'})`)
    return
  }

  console.log(`${changed ? 'Updated' : 'Verified'} README files with ${summary}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
