// Turns the difference between two statuses into the git entries of a session's thread.

import type { GitStatus } from '@shared/git'
import type { ToolEntry, ToolKind } from '@shared/thread'
import type { GitEventDraft } from './api'
import { expectOk, GIT_TIMEOUT_MS, type Exec } from './exec'
import { parseLog } from './parse'

/** Tool kinds that can change a repository; others never refresh or produce events. */
const REPOSITORY_TOOL_KINDS: ReadonlySet<ToolKind> = new Set([
  'edit',
  'delete',
  'move',
  'execute',
  'other',
])

export function canChangeRepository(kind: ToolKind): boolean {
  return REPOSITORY_TOOL_KINDS.has(kind)
}

const MAX_LISTED_COMMITS = 3
const NEW_COMMIT_LIMIT = 200
const SCANNED_OUTPUT_LIMIT = 1024 * 1024
const MAX_PARSE_DEPTH = 4
const PULL_REQUEST_IN_TEXT = /(?<![\w/])https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
const EXACT_PULL_REQUEST_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=.*$/
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:\\/
const LEADING_SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  '!',
  'if',
  'then',
  'elif',
  'else',
  'do',
  'while',
  'until',
  '&',
])
const POSIX_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const POWERSHELLS: ReadonlySet<string> = new Set(['pwsh', 'powershell'])

const GH_PR_CREATE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--assignee',
  '--attach',
  '--base',
  '--body',
  '--body-file',
  '--head',
  '--label',
  '--milestone',
  '--project',
  '--recover',
  '--repo',
  '--reviewer',
  '--template',
  '--title',
])
const GH_PR_CREATE_SHORT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  'a',
  'B',
  'b',
  'F',
  'H',
  'l',
  'm',
  'p',
  'r',
  'R',
  'T',
  't',
])

const DIRECT_PR_TOOL_NAME = /^(?:create_pull_request|createPullRequest)$/i
const NAMESPACED_PR_TOOL_NAME =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:(?:\s*[:：]\s*|\/|\.|__)[A-Za-z0-9][A-Za-z0-9_-]*)*?(?:\s*[:：]\s*|\/|\.|__)(?:create_pull_request|createPullRequest)$/i
const UNDERSCORE_PR_TOOL_NAME = /^(?:mcp_)?[A-Za-z0-9][A-Za-z0-9_-]*_create_pull_request$/i

export interface NewCommit {
  oid: string
  subject: string
}

export interface ToolCallContext {
  toolKind: ToolKind
  status: ToolEntry['status']
  title?: string
  rawInput?: string
}

/**
 * Commits that are on `to` but not on `from` and were committed at or after `sinceSeconds`.
 * The time filter keeps commits that arrived from elsewhere, by a pull or a checkout, out of
 * the list; only commits made during the tool call count.
 */
export async function listNewCommits(
  exec: Exec,
  cwd: string,
  from: string | null,
  to: string,
  sinceSeconds: number,
): Promise<NewCommit[]> {
  const result = await exec(
    'git',
    [
      'log',
      '-n',
      String(NEW_COMMIT_LIMIT),
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%H%x00%s%x00%ct',
      from === null ? to : `${from}..${to}`,
      '--',
    ],
    { cwd, timeoutMs: GIT_TIMEOUT_MS },
  )
  return parseLog(expectOk('git log', result).stdout)
    .filter((line) => line.time >= sinceSeconds)
    .map(({ oid, subject }) => ({ oid, subject }))
}

function normalizeExactPullRequestUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = EXACT_PULL_REQUEST_URL.exec(value.trim())
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : null
}

/** Extracts the created PR URL from a JSON object payload when an MCP tool returns one. */
function extractStructuredPullRequestUrl(text: string): string | null {
  let body = text.trim()
  const fenced = /^`{3,}[^\n]*\n([\s\S]*?)\n`{3,}$/.exec(body)
  if (fenced) body = fenced[1]!.trim()
  if (!body.startsWith('{') || !body.endsWith('}')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const direct =
    normalizeExactPullRequestUrl(record.html_url) ?? normalizeExactPullRequestUrl(record.url)
  if (direct) return direct
  const nested = record.pull_request
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    const pr = nested as Record<string, unknown>
    return normalizeExactPullRequestUrl(pr.html_url) ?? normalizeExactPullRequestUrl(pr.url)
  }
  return null
}

/**
 * The pull request URL printed by a PR creation tool. For structured MCP tool responses, top-level
 * JSON `html_url` / `url` fields take precedence over URLs mentioned in a PR body.
 */
export function extractPullRequestUrl(output: string, preferStructured = false): string | null {
  const text = output.length > SCANNED_OUTPUT_LIMIT ? output.slice(-SCANNED_OUTPUT_LIMIT) : output
  if (preferStructured) {
    const structured = extractStructuredPullRequestUrl(text)
    if (structured) return structured
  }
  let last: string | null = null
  for (const match of text.matchAll(PULL_REQUEST_IN_TEXT)) {
    last = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`
  }
  return last
}

interface HeredocSpec {
  delimiter: string
  stripTabs: boolean
}

/** Consumes queued heredoc bodies starting at `start` (right after a newline). */
function consumeHeredocs(text: string, start: number, queue: HeredocSpec[]): number {
  let i = start
  while (queue.length > 0 && i < text.length) {
    const spec = queue.shift()!
    while (i < text.length) {
      const nl = text.indexOf('\n', i)
      const rawLine = nl === -1 ? text.slice(i) : text.slice(i, nl)
      i = nl === -1 ? text.length : nl + 1
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      const candidate = spec.stripTabs ? line.replace(/^\t+/, '') : line
      if (candidate === spec.delimiter) break
    }
  }
  return i
}

/** Reads a heredoc delimiter word after `<<` or `<<-`, returning the delimiter and next index. */
function readHeredocDelimiter(
  text: string,
  start: number,
): { delimiter: string; nextIndex: number } | null {
  let i = start
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  let delimiter = ''
  while (i < text.length) {
    const c = text[i]!
    if (
      c === ' ' ||
      c === '\t' ||
      c === '\n' ||
      c === '\r' ||
      c === ';' ||
      c === '&' ||
      c === '|'
    ) {
      break
    }
    if (c === ')' || c === '(') break
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      if (close === -1) return null
      delimiter += text.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (c === '"') {
      const close = text.indexOf('"', i + 1)
      if (close === -1) return null
      delimiter += text.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (c === '\\' && i + 1 < text.length) {
      delimiter += text[i + 1]!
      i += 2
      continue
    }
    delimiter += c
    i++
  }
  return delimiter === '' ? null : { delimiter, nextIndex: i }
}

/**
 * Finds the matching `)` for a `$(...)` command substitution starting right after `$(`,
 * respecting quotes, escapes, nested parentheses, comments, and heredoc bodies.
 */
function findDollarParenEnd(text: string, start: number): number {
  let depth = 1
  let i = start
  let atWordStart = true
  const heredocs: HeredocSpec[] = []

  while (i < text.length && depth > 0) {
    const c = text[i]!
    const next = text[i + 1]

    if (c === '\n') {
      i++
      if (heredocs.length > 0) i = consumeHeredocs(text, i, heredocs)
      atWordStart = true
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      atWordStart = true
      i++
      continue
    }
    if (c === '#' && atWordStart) {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      if (close === -1) return -1
      i = close + 1
      atWordStart = false
      continue
    }
    if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          i += 2
        } else if (text[i] === '$' && text[i + 1] === '(') {
          if (text[i + 2] === '(') {
            const endArith = text.indexOf('))', i + 3)
            if (endArith === -1) return -1
            i = endArith + 2
          } else {
            const nested = findDollarParenEnd(text, i + 2)
            if (nested === -1) return -1
            i = nested + 1
          }
        } else {
          i++
        }
      }
      if (i >= text.length) return -1
      i++
      atWordStart = false
      continue
    }
    if (c === '\\') {
      i += i + 1 < text.length ? 2 : 1
      atWordStart = false
      continue
    }
    if (c === '<' && next === '<' && text[i + 2] !== '<') {
      const stripTabs = text[i + 2] === '-'
      const parsed = readHeredocDelimiter(text, i + (stripTabs ? 3 : 2))
      if (parsed) {
        heredocs.push({ delimiter: parsed.delimiter, stripTabs })
        i = parsed.nextIndex
        atWordStart = true
        continue
      }
    }
    if (c === '(') {
      depth++
      atWordStart = true
      i++
      continue
    }
    if (c === ')') {
      depth--
      if (depth === 0) return i
      atWordStart = true
      i++
      continue
    }
    atWordStart = c === ';' || c === '&' || c === '|'
    i++
  }
  return -1
}

/** Splits a shell command line into executed simple-command word lists and command substitutions. */
function parseShellClauses(command: string): { clauses: string[][]; substitutions: string[] } {
  const clauses: string[][] = []
  const substitutions: string[] = []
  const heredocs: HeredocSpec[] = []
  let words: string[] = []
  let word: string | null = null
  let pendingRedirect: 'target' | null = null

  const pushWord = (text: string): void => {
    if (pendingRedirect === 'target') {
      pendingRedirect = null
      return
    }
    words.push(text)
  }

  const endWord = (): void => {
    if (word !== null) {
      pushWord(word)
      word = null
    }
  }

  const endClause = (): void => {
    endWord()
    pendingRedirect = null
    if (words.length > 0) {
      clauses.push(words)
      words = []
    }
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]!
    const next = command[i + 1]

    if (c === '\r') {
      i++
      continue
    }

    if (c === '\n') {
      endClause()
      i++
      if (heredocs.length > 0) i = consumeHeredocs(command, i, heredocs)
      continue
    }

    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }

    if (c === '#' && word === null) {
      const nl = command.indexOf('\n', i)
      i = nl === -1 ? command.length : nl
      continue
    }

    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) {
        word = (word ?? '') + command.slice(i + 1)
        break
      }
      word = (word ?? '') + command.slice(i + 1, close)
      i = close + 1
      continue
    }

    if (c === '"') {
      let text = ''
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        const d = command[j]!
        const dn = command[j + 1]
        if (d === '\\' && dn !== undefined) {
          if (dn === '\n') {
            j += 2
          } else if ('$`"\\'.includes(dn)) {
            text += dn
            j += 2
          } else {
            text += d + dn
            j += 2
          }
        } else if (d === '$' && dn === '(') {
          if (command[j + 2] === '(') {
            const endArith = command.indexOf('))', j + 3)
            if (endArith === -1) {
              text += command.slice(j)
              j = command.length
              break
            }
            text += command.slice(j, endArith + 2)
            j = endArith + 2
          } else {
            const close = findDollarParenEnd(command, j + 2)
            if (close === -1) {
              text += command.slice(j)
              j = command.length
              break
            }
            substitutions.push(command.slice(j + 2, close))
            text += command.slice(j, close + 1)
            j = close + 1
          }
        } else if (d === '`') {
          let k = j + 1
          let sub = ''
          while (k < command.length && command[k] !== '`') {
            if (command[k] === '\\' && k + 1 < command.length) {
              sub += command[k + 1]!
              k += 2
            } else {
              sub += command[k]!
              k++
            }
          }
          if (k < command.length) {
            substitutions.push(sub)
            text += command.slice(j, k + 1)
            j = k + 1
          } else {
            text += command.slice(j)
            j = command.length
          }
        } else {
          text += d
          j++
        }
      }
      word = (word ?? '') + text
      i = j < command.length ? j + 1 : command.length
      continue
    }

    if (c === '\\') {
      if (next === '\n') {
        i += 2
        continue
      }
      if (word !== null && WINDOWS_DRIVE_PREFIX.test(word + c)) {
        word += c
        i++
        continue
      }
      if (next === undefined) break
      word = (word ?? '') + next
      i += 2
      continue
    }

    if (c === '$' && next === '(') {
      if (command[i + 2] === '(') {
        const endArith = command.indexOf('))', i + 3)
        if (endArith === -1) break
        word = (word ?? '') + command.slice(i, endArith + 2)
        i = endArith + 2
        continue
      }
      const close = findDollarParenEnd(command, i + 2)
      if (close === -1) break
      substitutions.push(command.slice(i + 2, close))
      word = (word ?? '') + command.slice(i, close + 1)
      i = close + 1
      continue
    }

    if (c === '`') {
      let k = i + 1
      let sub = ''
      while (k < command.length && command[k] !== '`') {
        if (command[k] === '\\' && k + 1 < command.length) {
          sub += command[k + 1]!
          k += 2
        } else {
          sub += command[k]!
          k++
        }
      }
      if (k < command.length) {
        substitutions.push(sub)
        word = (word ?? '') + command.slice(i, k + 1)
        i = k + 1
      } else {
        break
      }
      continue
    }

    // Redirections (including numeric fd prefixes like `2>&1` or `2>/dev/null`).
    if ((word === null || /^\d+$/.test(word)) && (c === '>' || c === '<')) {
      word = null
      if (c === '>' && next === '&') {
        if (/^\d$/.test(command[i + 2] ?? '')) {
          i += 3
          continue
        }
        pendingRedirect = 'target'
        i += 2
        continue
      }
      if (c === '>') {
        i += next === '>' || next === '|' ? 2 : 1
        pendingRedirect = 'target'
        continue
      }
      if (c === '<' && next === '<') {
        if (command[i + 2] === '<') {
          i += 3
          pendingRedirect = 'target'
          continue
        }
        const stripTabs = command[i + 2] === '-'
        const parsed = readHeredocDelimiter(command, i + (stripTabs ? 3 : 2))
        if (parsed) {
          heredocs.push({ delimiter: parsed.delimiter, stripTabs })
          i = parsed.nextIndex
          continue
        }
      }
      i += 1
      pendingRedirect = 'target'
      continue
    }

    if (c === '&' && next === '>') {
      endWord()
      i += command[i + 2] === '>' ? 3 : 2
      pendingRedirect = 'target'
      continue
    }

    if (c === '&' || c === '|' || c === ';') {
      if (c === '&' && next === '&') {
        endClause()
        i += 2
        continue
      }
      if (c === '&') {
        // Standalone `&` at the start of a clause is PowerShell's call operator (`& gh pr create`).
        if (word === null && words.length === 0) {
          i += 1
          continue
        }
        endClause()
        i += 1
        continue
      }
      if (c === '|' && (next === '|' || next === '&')) {
        endClause()
        i += 2
        continue
      }
      endClause()
      i += 1
      continue
    }

    if ((c === '(' || c === ')' || c === '{' || c === '}') && word === null) {
      endClause()
      i++
      continue
    }

    word = (word ?? '') + c
    i++
  }

  endClause()
  return { clauses, substitutions }
}

function commandBaseName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '')
}

/** Unwraps common command prefix wrappers (`env`, `command`, `timeout`, `nice`, `nohup`, etc.). */
function unwrapCommandWrapper(
  head: string,
  args: readonly string[],
): readonly string[] | null | undefined {
  let i = 0
  switch (head) {
    case 'env':
      while (i < args.length) {
        const arg = args[i]!
        if (
          arg === '-i' ||
          arg === '-' ||
          arg === '--ignore-environment' ||
          arg === '-0' ||
          arg === '--null' ||
          arg === '-v' ||
          arg === '--debug'
        ) {
          i++
        } else if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') {
          i += 2
        } else if (/^(?:-[uC]|--(?:unset|chdir)=)./.test(arg) || ENV_ASSIGNMENT.test(arg)) {
          i++
        } else {
          break
        }
      }
      break
    case 'command':
      while (i < args.length) {
        const arg = args[i]!
        if (arg === '-v' || arg === '-V') return null
        if (arg === '-p') i++
        else break
      }
      break
    case 'time':
      while (args[i] === '-p' || args[i] === '-l' || args[i] === '-v') i++
      break
    case 'nohup':
      break
    case 'nice':
      while (i < args.length) {
        const arg = args[i]!
        if (arg === '-n' || arg === '--adjustment') i += 2
        else if (/^(?:-n-?\d+|--adjustment=-?\d+|-\d+)$/.test(arg)) i++
        else break
      }
      break
    case 'timeout':
      while (i < args.length) {
        const arg = args[i]!
        if (['--preserve-status', '--foreground', '-v', '--verbose'].includes(arg)) i++
        else if (['-s', '--signal', '-k', '--kill-after'].includes(arg)) i += 2
        else if (/^(?:-[sk].|--(?:signal|kill-after)=)/.test(arg)) i++
        else break
      }
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(args[i] ?? '')) return null
      i++
      break
    case 'stdbuf':
      while (i < args.length) {
        const arg = args[i]!
        if (['-i', '-o', '-e', '--input', '--output', '--error'].includes(arg)) i += 2
        else if (/^(?:-[ioe].|--(?:input|output|error)=)/.test(arg)) i++
        else break
      }
      break
    case 'caffeinate':
      while (i < args.length) {
        const arg = args[i]!
        if (arg === '-t' || arg === '-w') i += 2
        else if (/^-[dimsu]+$/.test(arg)) i++
        else break
      }
      break
    case 'exec':
      while (i < args.length) {
        const arg = args[i]!
        if (arg === '-a') i += 2
        else if (arg === '-c' || arg === '-l') i++
        else break
      }
      break
    default:
      return undefined
  }
  if (args[i] === '--') i++
  return args.slice(i)
}

/** Extracts an inline script passed to `sh -c`, `bash -lc`, `pwsh -Command`, etc. */
function shellInlineScript(head: string, args: readonly string[]): string | null {
  if (POSIX_SHELLS.has(head)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === '--') return null
      if (arg === '-o' || arg === '+o') {
        i++
        continue
      }
      if (arg === '-c' || /^-[A-Za-z]*c$/.test(arg)) return args[i + 1] ?? null
      if (!arg.startsWith('-') && !arg.startsWith('+')) return null
    }
    return null
  }
  if (POWERSHELLS.has(head)) {
    for (let i = 0; i < args.length; i++) {
      const lower = args[i]!.toLowerCase()
      if (lower === '-c' || lower === '-command') {
        const rest = args.slice(i + 1)
        return rest.length > 0 ? rest.join(' ') : null
      }
    }
  }
  return null
}

function isDisablingLongFlag(arg: string, name: string): boolean {
  if (arg === name) return true
  if (!arg.startsWith(`${name}=`)) return false
  const value = arg.slice(name.length + 1).toLowerCase()
  return value !== 'false' && value !== '0'
}

/** Whether a `gh` invocation creates a pull request (`gh pr create` / `gh pr new`). */
function isGhPrCreate(args: readonly string[]): boolean {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    const arg = args[i]!
    if (arg === '-h' || arg === '--help' || arg === '--version') return false
    if (arg === '-R' || arg === '--repo') {
      i += 2
      continue
    }
    if (arg.startsWith('-R') || arg.startsWith('--repo=')) {
      i++
      continue
    }
    return false
  }
  if (args[i] !== 'pr') return false
  i++

  // Flags like `-R owner/repo` may appear between `pr` and `create`.
  while (i < args.length && args[i]!.startsWith('-')) {
    const arg = args[i]!
    if (arg === '-h' || arg === '--help') return false
    if (arg === '-R' || arg === '--repo') {
      i += 2
      continue
    }
    if (arg.startsWith('-R') || arg.startsWith('--repo=')) {
      i++
      continue
    }
    return false
  }
  const sub = args[i]
  if (sub !== 'create' && sub !== 'new') return false
  i++

  for (; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') break
    if (arg.startsWith('--')) {
      if (
        isDisablingLongFlag(arg, '--help') ||
        isDisablingLongFlag(arg, '--web') ||
        isDisablingLongFlag(arg, '--dry-run')
      ) {
        return false
      }
      if (!arg.includes('=') && GH_PR_CREATE_VALUE_FLAGS.has(arg)) i++
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!
        if (flag === 'h' || flag === 'w') return false
        if (GH_PR_CREATE_SHORT_VALUE_FLAGS.has(flag)) {
          if (j === arg.length - 1) i++
          break
        }
      }
    }
  }
  return true
}

function clauseCreatesPullRequest(rawWords: readonly string[], depth: number): boolean {
  let words = rawWords
  for (;;) {
    while (
      words.length > 0 &&
      (LEADING_SHELL_KEYWORDS.has(words[0]!) || ENV_ASSIGNMENT.test(words[0]!))
    ) {
      words = words.slice(1)
    }
    if (words.length === 0) return false
    const head = commandBaseName(words[0]!)
    const rest = words.slice(1)
    const unwrapped = unwrapCommandWrapper(head, rest)
    if (unwrapped === null) return false
    if (unwrapped !== undefined) {
      words = unwrapped
      continue
    }
    if (depth < MAX_PARSE_DEPTH) {
      const inline = shellInlineScript(head, rest)
      if (inline !== null) return commandCreatesPullRequest(inline, depth + 1)
    }
    return head === 'gh' && isGhPrCreate(rest)
  }
}

/** Whether a shell command invokes `gh pr create` (or its alias `gh pr new`) to open a PR. */
export function commandCreatesPullRequest(command: string, depth = 0): boolean {
  if (depth > MAX_PARSE_DEPTH || command.trim() === '') return false
  const { clauses, substitutions } = parseShellClauses(command)
  if (clauses.some((words) => clauseCreatesPullRequest(words, depth))) return true
  if (depth < MAX_PARSE_DEPTH) {
    return substitutions.some((sub) => commandCreatesPullRequest(sub, depth + 1))
  }
  return false
}

/** Whether an MCP/non-shell tool title identifies a PR creation tool (e.g. `create_pull_request`). */
export function isPullRequestCreationToolTitle(title: string): boolean {
  const trimmed = title.trim()
  if (trimmed === '') return false
  for (const rawSegment of trimmed.split(/\s*,\s*/)) {
    const segment = rawSegment.replace(/^Run\s+/i, '').trim()
    if (
      DIRECT_PR_TOOL_NAME.test(segment) ||
      NAMESPACED_PR_TOOL_NAME.test(segment) ||
      UNDERSCORE_PR_TOOL_NAME.test(segment)
    ) {
      return true
    }
  }
  return false
}

/** Whether a finished tool call actually created a pull request rather than merely mentioning one. */
export function canOpenPullRequest(tool: ToolCallContext): boolean {
  if (tool.status !== 'completed') return false
  if (tool.toolKind === 'execute') {
    const command = tool.rawInput?.trim() || tool.title?.trim() || ''
    return command !== '' && commandCreatesPullRequest(command)
  }
  if (tool.toolKind === 'other') {
    return typeof tool.title === 'string' && isPullRequestCreationToolTitle(tool.title)
  }
  return false
}

export interface EventInput {
  before: GitStatus
  after: GitStatus
  /** From `listNewCommits` between the two statuses, newest first. */
  newCommits: readonly NewCommit[]
  /** The tool's output, or an empty string for a tool that cannot open a pull request. */
  output: string
  /** Finished tool call metadata; required to emit an opened pull request event. */
  tool?: ToolCallContext
}

/** Branch, commit, push and pull request events, in the order they happen in a workflow. */
export function computeGitEvents({
  before,
  after,
  newCommits,
  output,
  tool,
}: EventInput): GitEventDraft[] {
  const events: GitEventDraft[] = []
  if (before.repo === null || after.repo === null || after.stale) return events

  // A switch from a detached head is not reported: a finished rebase looks the same.
  if (
    before.head.branch !== null &&
    after.head.branch !== null &&
    before.head.branch !== after.head.branch
  ) {
    events.push({ kind: 'git', event: 'branch', branch: after.head.branch })
  }

  if (newCommits.length > 0) {
    events.push({
      kind: 'git',
      event: 'commit',
      commits: newCommits.slice(0, MAX_LISTED_COMMITS),
      more: Math.max(0, newCommits.length - MAX_LISTED_COMMITS),
    })
  }

  const push = detectPush(before, after, newCommits)
  if (push) events.push({ kind: 'git', event: 'push', ...push })

  if (tool && canOpenPullRequest(tool)) {
    const url = extractPullRequestUrl(output, tool.toolKind === 'other')
    if (url) events.push({ kind: 'git', event: 'pull_request', url })
  }
  return events
}

function detectPush(
  before: GitStatus,
  after: GitStatus,
  newCommits: readonly NewCommit[],
): { upstream: string; count: number } | null {
  const upstream = after.upstream
  if (!upstream) return null

  if (before.head.branch !== after.head.branch) {
    // After a switch, the new branch's own upstream says nothing; only commits made
    // during the call that are already on the upstream were pushed by it.
    const made = new Set(newCommits.map((commit) => commit.oid))
    const count = after.commits.filter((commit) => commit.pushed && made.has(commit.oid)).length
    return count > 0 ? { upstream: upstream.name, count } : null
  }

  if (before.upstream?.name === upstream.name) {
    // Commits that were unpushed or made now, minus the ones still unpushed. This also
    // sees a commit that was pushed in the same call.
    const count = before.upstream.ahead + newCommits.length - upstream.ahead
    return count > 0 ? { upstream: upstream.name, count } : null
  }

  // The branch gained an upstream, which is a push even when no commit is listed.
  const published = after.commits.filter((commit) => commit.pushed).length
  return { upstream: upstream.name, count: published > 0 ? published : newCommits.length }
}
