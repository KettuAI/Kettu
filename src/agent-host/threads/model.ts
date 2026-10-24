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

export function storedSession(view: SessionView): StoredSession {
  const { title, config, commands, usage, subagent } = view
  return { title, config, commands, usage, subagent }
}

/** Whether a `session.update` changes what is stored of the session. */
export function changesStored(changes: Partial<SessionView>): boolean {
  return (
    'title' in changes ||
    'config' in changes ||
    'commands' in changes ||
    'usage' in changes ||
    'subagent' in changes
  )
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
  /** The bytes of attachments the entries name by hash: a sent image or pasted text. */
  blobs?: StoredBlob[]
}

export interface StoredBlob {
  hash: string
  mime: string
  data: Uint8Array
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

/**
 * An entry as it stands with no agent attached to finish it: nothing streams, an unfinished tool
 * call or compaction was cut off, and a permission request has no one to answer it.
 */
export function settled(entry: ThreadEntry): ThreadEntry {
  switch (entry.kind) {
    case 'agent':
    case 'thought':
      return entry.streaming ? { ...entry, streaming: false } : entry
    case 'compaction':
      return entry.status === 'in_progress' ? { ...entry, status: 'cancelled' } : entry
    case 'tool': {
      const open = entry.status === 'pending' || entry.status === 'in_progress'
      if (!open && entry.permission === null) return entry
      return {
        ...entry,
        ...(open ? { status: 'cancelled' as const } : {}),
        ...(entry.permission ? { permission: null, permissionResult: 'withdrawn' as const } : {}),
      }
    }
    default:
      return entry
  }
}

/**
 * Tool entries stored with the artifact link of #156 become the tool entry without it and, for a
 * write, an artifact entry right after it; null when there is none.
 */
export function splitLinks(entries: readonly ThreadEntry[]): ThreadEntry[] | null {
  let out: ThreadEntry[] | null = null
  entries.forEach((entry, i) => {
    const link = entry.kind === 'tool' ? (entry as { artifact?: unknown }).artifact : undefined
    if (link === undefined) {
      out?.push(entry)
      return
    }
    out ??= entries.slice(0, i)
    const tool = { ...entry }
    delete (tool as { artifact?: unknown }).artifact
    out.push(tool)
    if (isRecord(link) && typeof link.id === 'string' && typeof link.title === 'string') {
      const { action, version } = link
      if (
        action === 'create' ||
        action === 'update' ||
        action === 'restore' ||
        action === 'delete'
      ) {
        out.push({
          kind: 'artifact',
          id: `a:${entry.id}`,
          artifactId: link.id,
          title: link.title,
          action,
          version: typeof version === 'number' && action !== 'delete' ? version : null,
          writes: 1,
          after: entry.id,
        })
      }
    }
  })
  return out
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

/**
 * The index the page ending before index `end` of a thread in memory starts at, by the rules the
 * database pages by: back at least PAGE_ENTRIES entries to the start of their turn, at most
 * PAGE_LIMIT entries in all.
 */
export function pageStart(
  order: readonly string[],
  byId: Readonly<Record<string, ThreadEntry>>,
  end: number,
): number {
  let start = Math.max(0, end - PAGE_ENTRIES)
  while (start > 0 && !opensTurn(byId[order[start]!]!, byId[order[start - 1]!]!)) start--
  return Math.max(start, end - PAGE_LIMIT)
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

/** The hashes of the bytes the entries' attachments keep in the thread store. */
export function attachmentBlobs(entries: readonly ThreadEntry[]): Set<string> {
  const hashes = new Set<string>()
  for (const entry of entries) {
    const content =
      entry.kind === 'user' || entry.kind === 'session_message' ? entry.content : undefined
    for (const item of content ?? []) {
      if (item.type === 'ref' && item.ref.kind === 'attachment' && item.ref.attachment.blob) {
        hashes.add(item.ref.attachment.blob)
      }
    }
  }
  return hashes
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
