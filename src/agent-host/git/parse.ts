// Pure parsers for the machine-readable output of git and the text of gh.

import type { ChangedFile, ChangeStatus, PushTarget } from '@shared/git'

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
 * Picks the upstream's remote, else `origin`, else the only remote, from the entries of
 * `remote.<name>.url` and `branch.<name>.remote`.
 */
export function pickRemote(
  entries: readonly [string, string][],
  branch: string | null,
): RemoteInfo | null {
  const urls = remoteUrls(entries)
  const branchRemote = branch === null ? undefined : lastValue(entries, `branch.${branch}.remote`)
  const only = urls.size === 1 ? [...urls.keys()][0] : undefined
  for (const name of [branchRemote, 'origin', only]) {
    const url = name === undefined ? undefined : urls.get(name)
    if (name !== undefined && url !== undefined) return { name, url }
  }
  return null
}

function remoteUrls(entries: readonly [string, string][]): Map<string, string> {
  const urls = new Map<string, string>()
  for (const [key, value] of entries) {
    const remote = /^remote\.(.+)\.url$/.exec(key)
    if (remote && !urls.has(remote[1]!)) urls.set(remote[1]!, value)
  }
  return urls
}

// A single-valued setting: the last entry wins, as in git.
function lastValue(entries: readonly [string, string][], key: string): string | undefined {
  let value: string | undefined
  for (const [k, v] of entries) if (k === key) value = v
  return value
}

/**
 * Where Push sends `branch`, from the entries of `remote.<name>.url`, `branch.<name>.remote`,
 * `.merge` and `.pushremote`, `remote.pushdefault` and `push.default`, as `git push` would.
 * The one difference: with no upstream and no `origin`, an only remote is used.
 */
export function resolvePushTarget(
  entries: readonly [string, string][],
  branch: string,
): PushTarget {
  const urls = remoteUrls(entries)
  const upstreamRemote = lastValue(entries, `branch.${branch}.remote`)
  const merge = lastValue(entries, `branch.${branch}.merge`)
  const remote =
    lastValue(entries, `branch.${branch}.pushremote`) ??
    lastValue(entries, 'remote.pushdefault') ??
    upstreamRemote ??
    (urls.has('origin') ? 'origin' : urls.size === 1 ? [...urls.keys()][0] : undefined)
  if (remote === '.') return { kind: 'localUpstream' }
  if (urls.size === 0) return { kind: 'noRemote' }
  const url = remote === undefined ? undefined : urls.get(remote)
  if (remote === undefined || url === undefined) return { kind: 'unknownRemote' }
  const to = (name: string, setUpstream: boolean): PushTarget => ({
    kind: 'remote',
    remote,
    github: parseGithubRemote(url),
    branch: name,
    setUpstream,
  })
  const upstreamBranch = merge?.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : null
  if (upstreamRemote !== remote || upstreamBranch === null) {
    // A first push, or a push to another remote than the upstream's, goes to the same name.
    return to(branch, upstreamRemote === undefined)
  }
  const mode = lastValue(entries, 'push.default') ?? 'simple'
  if (mode === 'upstream' || mode === 'tracking') return to(upstreamBranch, false)
  if (upstreamBranch === branch || mode === 'current') return to(branch, false)
  return { kind: 'otherName', upstream: `${remote}/${upstreamBranch}` }
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

function statusOfLetter(letter: string): ChangeStatus {
  switch (letter) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

/** Parses `--name-status -z`: a status record (`M`, `R100`, ...), then one path, or two for a rename or copy. */
export function parseNameStatus(output: string): ChangedFile[] {
  const records = output.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < records.length; i++) {
    const code = records[i]!.trim()
    if (!/^[A-Z]\d*$/.test(code)) continue
    const status = statusOfLetter(code[0]!)
    if (status === 'renamed' || status === 'copied') {
      const oldPath = records[++i]
      const path = records[++i]
      if (oldPath && path) files.push({ path, oldPath, status, insertions: null, deletions: null })
    } else {
      const path = records[++i]
      if (path) files.push({ path, oldPath: null, status, insertions: null, deletions: null })
    }
  }
  return files
}

export interface NumstatEntry {
  path: string
  /** Null for a binary file. */
  insertions: number | null
  deletions: number | null
}

/** Parses `--numstat -z`; a rename's record has an empty path followed by the old and new paths. */
export function parseNumstat(output: string): NumstatEntry[] {
  const records = output.split('\0')
  const entries: NumstatEntry[] = []
  for (let i = 0; i < records.length; i++) {
    const match = /^\n?(-|\d+)\t(-|\d+)\t(.*)$/s.exec(records[i]!)
    if (!match) continue
    let path = match[3]!
    if (path === '') {
      i += 2
      path = records[i] ?? ''
    }
    if (!path) continue
    const binary = match[1] === '-'
    entries.push({
      path,
      insertions: binary ? null : Number(match[1]),
      deletions: binary ? null : Number(match[2]),
    })
  }
  return entries
}

/** Adds the line counts of `numstat` to the files they name. */
export function withLineCounts(files: ChangedFile[], numstat: NumstatEntry[]): ChangedFile[] {
  const counts = new Map(numstat.map((entry) => [entry.path, entry]))
  return files.map((file) => {
    const count = counts.get(file.path)
    return count ? { ...file, insertions: count.insertions, deletions: count.deletions } : file
  })
}

/** Lists the changed files of `git status --porcelain=v2 -z`, in git's order. */
export function parsePorcelainFiles(output: string): ChangedFile[] {
  const records = output.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    switch (record[0]) {
      case '1': {
        // 1 XY sub mH mI mW hH hI path
        const path = fieldsAfter(record, 8)
        const xy = record.slice(2, 4)
        const status = xy.includes('A')
          ? 'added'
          : xy.includes('D')
            ? 'deleted'
            : xy.includes('T')
              ? 'typechange'
              : 'modified'
        if (path) files.push({ path, oldPath: null, status, insertions: null, deletions: null })
        break
      }
      case '2': {
        // 2 XY sub mH mI mW hH hI Xscore path, then the original path as its own record
        const path = fieldsAfter(record, 9)
        const oldPath = records[++i] ?? null
        const status = record[2] === 'C' || record[3] === 'C' ? 'copied' : 'renamed'
        if (path) files.push({ path, oldPath, status, insertions: null, deletions: null })
        break
      }
      case 'u': {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path
        const path = fieldsAfter(record, 10)
        if (path) {
          files.push({
            path,
            oldPath: null,
            status: 'conflicted',
            insertions: null,
            deletions: null,
          })
        }
        break
      }
      case '?':
        if (record.length > 2) {
          files.push({
            path: record.slice(2),
            oldPath: null,
            status: 'untracked',
            insertions: null,
            deletions: null,
          })
        }
        break
    }
  }
  return files
}

// The rest of a record after `count` space-separated fields; a path may hold spaces.
function fieldsAfter(record: string, count: number): string | null {
  let at = 0
  for (let n = 0; n < count; n++) {
    at = record.indexOf(' ', at)
    if (at < 0) return null
    at++
  }
  return record.slice(at) || null
}

export interface CommitHeader {
  oid: string
  authorName: string
  authorEmail: string
  /** Seconds since the epoch. */
  time: number
  subject: string
  body: string
}

/** Parses `git show -s --format=%H%x00%an%x00%ae%x00%at%x00%B`. */
export function parseCommitHeader(output: string): CommitHeader | null {
  const [oid, authorName, authorEmail, time, ...rest] = output.split('\0')
  if (!oid || !/^[0-9a-f]{40,64}$/.test(oid.trim())) return null
  const message = rest.join('\0').replace(/\r\n/g, '\n').trim()
  const newline = message.indexOf('\n')
  return {
    oid: oid.trim(),
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    time: Number(time) || 0,
    subject: newline < 0 ? message : message.slice(0, newline).trim(),
    body: newline < 0 ? '' : message.slice(newline + 1).trim(),
  }
}

export interface AuthoredLogLine extends LogLine {
  author: string
}

/** Parses `git log --format=%H%x00%s%x00%at%x00%an`, one commit per line. */
export function parseAuthoredLog(output: string): AuthoredLogLine[] {
  const lines: AuthoredLogLine[] = []
  for (const line of output.split('\n')) {
    const [oid, subject, time, author] = line.split('\0')
    if (!oid || subject === undefined || time === undefined) continue
    lines.push({
      oid,
      subject: subject.replace(/\r$/, ''),
      time: Number(time) || 0,
      author: (author ?? '').replace(/\r$/, ''),
    })
  }
  return lines
}
