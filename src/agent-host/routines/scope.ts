// Whether a permission request is inside a scope, by the platform's path rules: a routine's,
// relative to its project, or a task node's, relative to the worktree it works in.

import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { PermissionScope } from '@shared/routines'
import type { PermissionKind, ToolKind } from '@shared/thread'
import { commandSteps } from '../command-safety'
import { isAbsolutePath, pathKey } from '../paths'

export interface ScopeRequest {
  toolKind: ToolKind
  /** Every path the request names, as the agent sent it. */
  locations: readonly string[]
  options: readonly { id: string; kind: PermissionKind }[]
}

// Fetch is in every level, gated by the web switch below.
const BASE_KINDS: readonly ToolKind[] = ['read', 'search', 'think', 'fetch']
const EDIT_KINDS: readonly ToolKind[] = [...BASE_KINDS, 'edit', 'delete', 'move']
const COMMAND_KINDS: readonly ToolKind[] = [...EDIT_KINDS, 'execute']

function allowedKinds(level: PermissionScope['level']): readonly ToolKind[] {
  return level === 'read' ? BASE_KINDS : level === 'edit' ? EDIT_KINDS : COMMAND_KINDS
}

/**
 * Whether the request is inside the scope: its kind at the level, every location it names under
 * `root` and outside `.git`, and no location only for the kinds that name none.
 */
export function withinScope(
  scope: PermissionScope,
  root: string,
  request: Pick<ScopeRequest, 'toolKind' | 'locations'>,
  platform: Platform,
): boolean {
  const { toolKind, locations } = request
  if (!allowedKinds(scope.level).includes(toolKind)) return false
  if (toolKind === 'fetch' && !scope.web) return false
  if (locations.length === 0) {
    return toolKind === 'think' || toolKind === 'fetch' || toolKind === 'execute'
  }
  const top = pathKey(root, platform)
  const git = pathKey(`${root}${separator(platform)}.git`, platform)
  const edit = toolKind === 'edit' || toolKind === 'delete' || toolKind === 'move'
  return locations.every((location) => {
    const key = locationKey(root, location, platform)
    if (!inside(key, top, platform)) return false
    return !edit || !inside(key, git, platform)
  })
}

/**
 * The `allow_once` option to answer with, or null to let the request wait. An `allow_always`
 * option is never picked: it would outlive the run in the agent's own settings.
 */
export function scopeAnswer(
  scope: PermissionScope,
  root: string,
  request: ScopeRequest,
  platform: Platform,
): string | null {
  if (!withinScope(scope, root, request, platform)) return null
  return request.options.find((option) => option.kind === 'allow_once')?.id ?? null
}

function separator(platform: Platform): string {
  return platform === 'win32' ? '\\' : '/'
}

/** A location as a key; a relative one resolves against the root, the agent's folder. */
function locationKey(root: string, location: string, platform: Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const absolute = isAbsolutePath(location, platform)
    ? p.normalize(location)
    : p.resolve(root, location)
  return pathKey(absolute, platform)
}

function inside(key: string, root: string, platform: Platform): boolean {
  if (key === root) return true
  const sep = separator(platform)
  return key.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

// Commands that hand work out of the worktree, which only the person may allow in a task.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
// Programs that run the rest of their words as a command.
const WRAPPERS = new Set(['env', 'sudo', 'command', 'nohup', 'time', 'nice', 'exec', 'xargs'])
// git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
])
const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname'])
const GIT_PUSHES = new Set(['push', 'send-pack'])
// git commands whose every use writes refs directly.
const GIT_REF_WRITERS = new Set(['update-ref', 'symbolic-ref', 'replace'])
// Options of `git branch` that move, delete, copy or force a branch, which may be another's.
const BRANCH_REWRITES = new Set([
  '-f',
  '--force',
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
])
// Options of `git tag` that only read.
const TAG_READS = new Set(['-l', '--list', '-n', '-v', '--verify', '--contains', '--points-at'])
const GH_PR_ACTIONS = new Set(['create', 'merge', 'ready'])

/**
 * Whether a command could push the task's branch, open, merge or ready a pull request, or make a
 * release: work that leaves the worktree, which only the person lets a task do. Also whether it
 * could move refs every worktree shares, such as the default branch the task started from. A
 * command whose text cannot be read word by word counts when it names git with one of these, or
 * gh with pr or release, anywhere.
 */
export function leavesWorktree(command: string): boolean {
  return leavesWith(command, 0)
}

function leavesWith(command: string, depth: number): boolean {
  const steps = commandSteps(command)
  if (steps === null || depth > 3) return looselyLeaves(command)
  return steps.some((words) => stepLeaves(words, depth))
}

function looselyLeaves(command: string): boolean {
  return (
    /\bgit\b[\s\S]*\b(push|send-pack|update-ref|symbolic-ref|replace|tag|branch|fetch|checkout|switch)\b/.test(
      command,
    ) || /\bgh\b[\s\S]*\b(pr|release)\b/.test(command)
  )
}

function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
}

function stepLeaves(words: readonly string[], depth: number): boolean {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[i]!)) i++
  if (i >= words.length) return false
  const program = programName(words[i]!)
  const rest = words.slice(i + 1)
  if (WRAPPERS.has(program)) {
    // Their options may take values, so every word after them is tried as the command's start.
    return rest.some((word, at) => !word.startsWith('-') && stepLeaves(rest.slice(at), depth))
  }
  if (program === 'eval') return leavesWith(rest.join(' '), depth + 1)
  if (SHELLS.has(program)) {
    const at = rest.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word))
    return at !== -1 && at + 1 < rest.length && leavesWith(rest[at + 1]!, depth + 1)
  }
  if (program === 'git') {
    const sub = subcommand(rest, GIT_VALUE_OPTIONS)
    return sub !== null && gitLeaves(rest[sub]!, rest.slice(sub + 1))
  }
  if (program === 'gh') {
    const sub = subcommand(rest, GH_VALUE_OPTIONS)
    if (sub === null) return false
    if (rest[sub] === 'release') return true
    if (rest[sub] !== 'pr') return false
    const action = subcommand(rest.slice(sub + 1), GH_VALUE_OPTIONS)
    return action !== null && GH_PR_ACTIONS.has(rest[sub + 1 + action]!)
  }
  return false
}

function gitLeaves(command: string, args: readonly string[]): boolean {
  if (GIT_PUSHES.has(command) || GIT_REF_WRITERS.has(command)) return true
  switch (command) {
    case 'branch':
      return args.some((word) => BRANCH_REWRITES.has(word) || /^-[a-zA-Z]*[fdDmMcC]/.test(word))
    // A plain `git tag` lists; anything else may make or move one.
    case 'tag':
      return args.length > 0 && !args.some((word) => TAG_READS.has(word) || word.startsWith('-n'))
    // `-B` and `-C` reset a branch that may exist already.
    case 'checkout':
    case 'switch':
      return args.some((word) => word === '-B' || word === '-C' || word === '--force-create')
    // A refspec with a destination writes that local ref.
    case 'fetch':
      return args.some((word) => !word.startsWith('-') && word.includes(':'))
    default:
      return false
  }
}

/** The index of the first word that is not an option or an option's value. */
function subcommand(words: readonly string[], valueOptions: ReadonlySet<string>): number | null {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (!word.startsWith('-')) return i
    if (valueOptions.has(word)) i++
  }
  return null
}
