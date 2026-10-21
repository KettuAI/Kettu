// Pure parsers for the machine-readable output of git and the text of gh.

export interface PorcelainStatus {
  /** Null on an unborn branch. */
  oid: string | null
  /** Null when detached. */
  branch: string | null
  detached: boolean
  upstream: string | null
  /** Null when git reports no counts: no upstream, or the upstream branch is gone. */
  ahead: number | null
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parsePorcelainStatus(output: string): PorcelainStatus {
  const result: PorcelainStatus = {
    oid: null,
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  }
  const records = output.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record === '') continue
    if (record.startsWith('# ')) {
      parseHeader(record, result)
      continue
    }
    switch (record[0]) {
      case '1':
      case '2':
        if (record[2] !== '.') result.staged++
        if (record[3] !== '.') result.unstaged++
        // A rename or copy entry is followed by its original path as one more record.
        if (record[0] === '2') i++
        break
      case 'u':
        result.conflicted++
        break
      case '?':
        result.untracked++
        break
    }
  }
  return result
}

function parseHeader(record: string, result: PorcelainStatus): void {
  const space = record.indexOf(' ', 2)
  if (space < 0) return
  const name = record.slice(2, space)
  const value = record.slice(space + 1)
  switch (name) {
    case 'branch.oid':
      result.oid = value === '(initial)' ? null : value
      break
    case 'branch.head':
      result.detached = value === '(detached)'
      result.branch = result.detached ? null : value
      break
    case 'branch.upstream':
      result.upstream = value
      break
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value)
      if (match) {
        result.ahead = Number(match[1])
        result.behind = Number(match[2])
      }
      break
    }
  }
}

/** Parses `git diff --shortstat`, whose output is empty when nothing differs. */
export function parseShortstat(output: string): { insertions: number; deletions: number } {
  const insertions = /(\d+) insertions?\(\+\)/.exec(output)
  const deletions = /(\d+) deletions?\(-\)/.exec(output)
  return { insertions: Number(insertions?.[1] ?? 0), deletions: Number(deletions?.[1] ?? 0) }
}

/** Parses `git rev-list --left-right --count A...B`: commits only in A, then only in B. */
export function parseLeftRightCount(output: string): { left: number; right: number } {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(output)
  if (!match) throw new Error(`Unexpected rev-list count output: ${JSON.stringify(output)}`)
  return { left: Number(match[1]), right: Number(match[2]) }
}

export interface LogLine {
  oid: string
  subject: string
  /** Seconds since the epoch. */
  time: number
}

/** Parses `git log --format=%H%x00%s%x00%at` (or `%ct`), one commit per line. */
export function parseLog(output: string): LogLine[] {
  const lines: LogLine[] = []
  for (const line of output.split('\n')) {
    const [oid, subject, time] = line.split('\0')
    if (!oid || subject === undefined || time === undefined) continue
    lines.push({ oid, subject: subject.replace(/\r$/, ''), time: Number(time) || 0 })
  }
  return lines
}

export function parseOidLines(output: string): string[] {
  return output.split('\n').filter((line) => /^[0-9a-f]{40,64}$/.test(line.trim()))
}

/** Parses `git config -z --get-regexp ...`: records of `key\nvalue` ended by NUL. */
export function parseConfigEntries(output: string): [key: string, value: string][] {
  const entries: [string, string][] = []
  for (const record of output.split('\0')) {
    if (record === '') continue
    const newline = record.indexOf('\n')
    if (newline < 0) entries.push([record, ''])
    else entries.push([record.slice(0, newline), record.slice(newline + 1)])
  }
  return entries
}

export interface RemoteInfo {
  name: string
  url: string
}

/**
 * Picks the upstream's remote, else `origin`, from the entries of
 * `remote.<name>.url` and `branch.<name>.remote`.
 */
export function pickRemote(
  entries: readonly [string, string][],
  branch: string | null,
): RemoteInfo | null {
  const urls = new Map<string, string>()
  let branchRemote: string | null = null
  for (const [key, value] of entries) {
    const remote = /^remote\.(.+)\.url$/.exec(key)
    if (remote && !urls.has(remote[1]!)) urls.set(remote[1]!, value)
    if (branch !== null && key === `branch.${branch}.remote` && value !== '.') branchRemote = value
  }
  for (const name of [branchRemote, 'origin']) {
    const url = name === null ? undefined : urls.get(name)
    if (name !== null && url !== undefined) return { name, url }
  }
  return null
}

export interface GithubRepo {
  owner: string
  repo: string
}

const GITHUB_PATH = /^\/?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com'])

/** Reads owner and repository from a github.com remote URL; other hosts give null. */
export function parseGithubRemote(url: string): GithubRepo | null {
  const trimmed = url.trim()
  let host: string
  let path: string
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(trimmed)
  if (scheme) {
    host = scheme[2]!.replace(/^[^@]*@/, '').replace(/:\d*$/, '')
    path = scheme[3] ?? ''
  } else {
    // scp-like form: [user@]host:owner/repo
    const scp = /^(?:[^@/\\:]+@)?([^/\\:]+):(?!\/\/)(.+)$/.exec(trimmed)
    if (!scp) return null
    host = scp[1]!
    path = scp[2]!
  }
  if (!GITHUB_HOSTS.has(host.toLowerCase())) return null
  const match = GITHUB_PATH.exec(path)
  return match ? { owner: match[1]!, repo: match[2]! } : null
}

/** `git version 2.51.2`, `git version 2.39.5 (Apple Git-154)`, `git version 2.43.0.windows.1`. */
export function parseGitVersion(output: string): string | null {
  return /git version (\S+)/.exec(output)?.[1] ?? null
}

/** `gh version 2.98.0 (2026-08-20)`. */
export function parseGhVersion(output: string): string | null {
  return /gh version (\S+)/.exec(output)?.[1] ?? null
}

/**
 * The signed-in account in `gh auth status` output, which spells it
 * `Logged in to github.com account NAME (...)`, or `as NAME` in older versions. With
 * several accounts, the one marked active wins.
 */
export function parseGhAccount(output: string): string | null {
  const accounts: { name: string; active: boolean }[] = []
  for (const line of output.split(/\r?\n/)) {
    const login = /Logged in to \S+ (?:account|as) (\S+)/.exec(line)
    if (login) accounts.push({ name: login[1]!, active: false })
    else if (/Active account: true/.test(line) && accounts.length > 0) {
      accounts[accounts.length - 1]!.active = true
    }
  }
  return (accounts.find((account) => account.active) ?? accounts[0])?.name ?? null
}

/** True when `gh pr view` failed only because the branch has no pull request. */
export function isNoPullRequestMessage(stderr: string): boolean {
  return /no pull requests? found/i.test(stderr)
}
