// What a stage session did during a round, read from its recorded tool calls: the commands it ran
// and the files its edits changed. Never from what the agent says it did.

import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { priceFor, type UsageRow } from '../usage/model'
import type { StageEvidence } from './api'

/** Sub-sessions read below a stage session, so a loop of references cannot run on. */
const MAX_SUB_SESSIONS = 200

function isTurn(entry: ThreadEntry): boolean {
  return entry.kind === 'user' && entry.steered !== true
}

/** The turns a thread holds: its user messages, but those sent into a running turn. */
export function turnCount(entries: readonly ThreadEntry[]): number {
  return entries.reduce((count, entry) => (isTurn(entry) ? count + 1 : count), 0)
}

/** The entries from the turn after the first `fromTurn` turns on. */
export function entriesSince(entries: readonly ThreadEntry[], fromTurn: number): ThreadEntry[] {
  if (fromTurn <= 0) return [...entries]
  let seen = 0
  for (let i = 0; i < entries.length; i++) {
    if (!isTurn(entries[i]!)) continue
    if (seen === fromTurn) return entries.slice(i)
    seen++
  }
  return []
}

const EDIT_KINDS: ReadonlySet<ToolEntry['toolKind']> = new Set(['edit', 'delete', 'move'])

/** The command a call ran, as the agent sent it; its title when it sent no input. */
function commandOf(entry: ToolEntry): string | null {
  const text = (entry.rawInput ?? entry.title).trim()
  return text === '' ? null : text
}

/** A path relative to the root when it lies inside it, with `/` between its parts. */
function relativeTo(root: string, location: string, platform: Platform): string {
  const api = platform === 'win32' ? path.win32 : path.posix
  const absolute = api.isAbsolute(location) ? location : api.resolve(root, location)
  const relative = api.relative(root, absolute)
  if (relative === '' || relative.startsWith('..') || api.isAbsolute(relative)) return absolute
  return platform === 'win32' ? relative.replaceAll('\\', '/') : relative
}

/**
 * The commands and changed files of `entries`: executed calls that completed or failed, since a
 * command that exited with an error still ran, and edits that completed, by their locations and
 * diffs. Both keep their first order without repeats.
 */
export function evidenceOf(
  entries: readonly ThreadEntry[],
  root: string,
  platform: Platform,
): Omit<StageEvidence, 'turns'> {
  const commands = new Set<string>()
  const changed = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue
    if (entry.toolKind === 'execute') {
      if (entry.status !== 'completed' && entry.status !== 'failed') continue
      const command = commandOf(entry)
      if (command !== null) commands.add(command)
      continue
    }
    if (!EDIT_KINDS.has(entry.toolKind) || entry.status !== 'completed') continue
    for (const location of entry.locations) changed.add(relativeTo(root, location.path, platform))
    for (const content of entry.content) {
      if (content.type === 'diff') changed.add(relativeTo(root, content.path, platform))
    }
  }
  return { commands: [...commands], changedFiles: [...changed] }
}

/** Reads a session's thread entries in order; null for one Kettu holds no thread for. */
export type ReadEntries = (sessionId: string) => Promise<readonly ThreadEntry[] | null>

/**
 * The evidence of a round of the stage session: its own calls since `fromTurn`, and every call of
 * the sub-sessions it started in that time, which work in the same folder.
 */
export async function collectEvidence(
  sessionId: string,
  fromTurn: number,
  read: ReadEntries,
  root: string,
  platform: Platform,
): Promise<StageEvidence> {
  const own = (await read(sessionId)) ?? []
  const entries: ThreadEntry[] = entriesSince(own, fromTurn)
  const seen = new Set<string>([sessionId])
  const pending = subSessions(entries, seen)
  while (pending.length > 0 && seen.size <= MAX_SUB_SESSIONS) {
    const sub = pending.shift()!
    const subEntries = (await read(sub)) ?? []
    entries.push(...subEntries)
    pending.push(...subSessions(subEntries, seen))
  }
  return { ...evidenceOf(entries, root, platform), turns: turnCount(own) }
}

function subSessions(entries: readonly ThreadEntry[], seen: Set<string>): string[] {
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'subagent' || seen.has(entry.sessionId)) continue
    seen.add(entry.sessionId)
    ids.push(entry.sessionId)
  }
  return ids
}

/**
 * A turn's estimated cost in dollars from its usage rows, priced as the usage page prices them;
 * null when no row's model has a price.
 */
export function turnCostUsd(rows: readonly UsageRow[]): number | null {
  let total: number | null = null
  for (const row of rows) {
    const price = priceFor(row.model)
    if (!price) continue
    const hour = price.cacheWrite1h ?? price.cacheWrite
    total =
      (total ?? 0) +
      row.input * price.input +
      (row.output + (row.reasoning ?? 0)) * price.output +
      row.cacheRead * price.cacheRead +
      (row.cacheWrite - row.cacheWrite1h) * price.cacheWrite +
      row.cacheWrite1h * hour
  }
  return total
}

/** The cost of the turns after the first `fromTurn`, from a session's [turn, dollars] pairs. */
export function costSince(costs: readonly (readonly [number, number])[], fromTurn: number): number {
  return costs.reduce((sum, [turn, usd]) => (turn > fromTurn ? sum + usd : sum), 0)
}
