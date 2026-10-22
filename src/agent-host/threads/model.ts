// The stored form of a session's thread: what is kept beside the entries, where turns start,
// and the content refs that large images are moved out of.

import type {
  AgentId,
  ConfigOption,
  SessionUsage,
  SessionView,
  SlashCommand,
  SubagentInfo,
  ThreadEntry,
} from '@shared/thread'

/** A page reaches back at least this many entries, then on to the start of their turn... */
export const PAGE_ENTRIES = 60
/** ...unless that turn is longer than this, which is then cut. */
export const PAGE_LIMIT = 500
/** Base64 image data longer than this is stored once per session as bytes of its own. */
export const INLINE_IMAGE_LIMIT = 32 * 1024

export interface ThreadHead {
  agentId: AgentId
  acpSessionId: string
}

/** The parts of a session's view that are shown before its agent connects. */
export type StoredSession = Pick<
  SessionView,
  'title' | 'config' | 'commands' | 'usage' | 'subagent'
>

export const EMPTY_SESSION: StoredSession = {
  title: null,
  config: [],
  commands: [],
  usage: null,
  subagent: null,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOption = (value: unknown): value is ConfigOption =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  (value.type === 'select' || value.type === 'boolean') &&
  (typeof value.value === 'string' || typeof value.value === 'boolean')

const isCommand = (value: unknown): value is SlashCommand =>
  isRecord(value) && typeof value.name === 'string' && typeof value.description === 'string'

export function parseStoredSession(value: unknown): StoredSession | null {
  if (
    !isRecord(value) ||
    !(value.title === null || typeof value.title === 'string') ||
    !Array.isArray(value.config) ||
    !value.config.every(isOption) ||
    !Array.isArray(value.commands) ||
    !value.commands.every(isCommand) ||
    !(value.usage === null || isRecord(value.usage)) ||
    !(value.subagent === null || isRecord(value.subagent))
  ) {
    return null
  }
  return {
    title: value.title,
    config: value.config,
    commands: value.commands,
    usage: value.usage as SessionUsage | null,
    subagent: value.subagent as SubagentInfo | null,
  }
}

export interface PositionedEntry {
  /** Arrival order in the thread, from 0; the cursor pages are read by. */
  pos: number
  entry: ThreadEntry
}

export interface ThreadWrite {
  head: ThreadHead
  /** Kept as it was when absent. */
  session?: StoredSession
  /** New and changed entries. A changed one must keep its position; a new one takes `pos`. */
  entries: PositionedEntry[]
  /** Drops everything stored for the session first, as after a replay from the agent. */
  replace?: boolean
}

export interface ThreadPage {
  head: ThreadHead
  session: StoredSession
  entries: ThreadEntry[]
  /** The position of the first entry, or the bound the page was read below when it is empty. */
  from: number
  /** The cursor for the page before this one, or null when the page starts the thread. */
  older: number | null
  /** The latest plan when it lies before the page, for the plan pinned above the composer. */
  plan: Extract<ThreadEntry, { kind: 'plan' }> | null
}

export interface StoredThread {
  head: ThreadHead
  session: StoredSession
  entries: PositionedEntry[]
}

/** Whether `entry` starts a turn: a prompt of its own, or whatever follows the end of one. */
export function opensTurn(entry: ThreadEntry, previous: { kind: string } | null): boolean {
  if (entry.kind === 'user') return entry.steered !== true
  return previous?.kind === 'turn_end'
}

/**
 * The turn of an entry at `pos`, named by the position of the entry that opened it, so a page
 * that starts at a turn is one range of positions. `previous` is the entry stored just before.
 */
export function turnOf(
  entry: ThreadEntry,
  pos: number,
  previous: { kind: string; turn: number } | null,
): number {
  return previous === null || opensTurn(entry, previous) ? pos : previous.turn
}

type Json = Record<string, unknown>

function mapList(list: unknown, map: (item: Json) => Json): unknown {
  if (!Array.isArray(list)) return list
  let changed = false
  const out = list.map((item: unknown) => {
    if (!isRecord(item)) return item
    const next = map(item)
    if (next !== item) changed = true
    return next
  })
  return changed ? out : list
}

const mapContent = (map: (ref: Json) => Json) => (item: Json) => {
  if (item.type !== 'ref' || !isRecord(item.ref)) return item
  const ref = map(item.ref)
  return ref === item.ref ? item : { ...item, ref }
}

/**
 * Passes every content ref of an entry through `map`: the content of prompts, session messages
 * and tool calls, and an agent message's attachments. Parts `map` leaves alone are shared.
 */
export function mapRefs(entry: Json, map: (ref: Json) => Json): Json {
  const key =
    entry.kind === 'agent'
      ? 'attachments'
      : entry.kind === 'user' || entry.kind === 'session_message' || entry.kind === 'tool'
        ? 'content'
        : null
  if (key === null) return entry
  const list =
    key === 'attachments' ? mapList(entry[key], map) : mapList(entry[key], mapContent(map))
  return list === entry[key] ? entry : { ...entry, [key]: list }
}
