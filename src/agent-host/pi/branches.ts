// Native Pi session tree parsing and branch projection: reads Pi's append-only JSONL entry tree
// (either from a live RPC `get_entries` response or straight from disk) and compresses linear runs
// into navigable branch segments while preserving fork points, multi-root trees, labels and active
// leaf tracking.

import { readFile } from 'node:fs/promises'
import type { SessionBranchesResult, SessionBranchNode } from '@shared/agent-host'
import { withoutAhead } from '../session-updates'
import { blockText, typedText } from './mapper'
import type { PiEntry } from './protocol'

const PREVIEW_CHARS = 120

const CONVERSATION_TYPES: ReadonlySet<string> = new Set([
  'message',
  'compaction',
  'branch_summary',
  'custom_message',
])

export interface PiEntriesSnapshot {
  entries: PiEntry[]
  leafId: string | null
}

/**
 * Parses a Pi session JSONL file into its append-order entries and default leaf id (the latest
 * entry appended to the file). Skips the session header line and any malformed trailing line.
 */
export function parsePiSessionJsonl(text: string): PiEntriesSnapshot {
  const entries: PiEntry[] = []
  let leafId: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    if (record.type === 'session') continue
    if (typeof record.type !== 'string' || typeof record.id !== 'string' || record.id === '') {
      continue
    }
    const parentId =
      typeof record.parentId === 'string' && record.parentId !== '' ? record.parentId : null
    entries.push({ ...(record as unknown as PiEntry), id: record.id, parentId })
    leafId = record.id
  }
  return { entries, leafId }
}

/** Reads and parses a Pi session JSONL file on disk. */
export async function readPiSessionEntries(file: string): Promise<PiEntriesSnapshot> {
  const text = await readFile(file, 'utf8')
  return parsePiSessionJsonl(text)
}

/** Resolves the latest non-empty native bookmark label for each entry id. */
export function extractLabels(entries: readonly PiEntry[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type !== 'label' || typeof entry.targetId !== 'string' || entry.targetId === '') {
      continue
    }
    const value = typeof entry.label === 'string' ? entry.label.trim() : ''
    if (value) labels.set(entry.targetId, value)
    else labels.delete(entry.targetId)
  }
  return labels
}

/**
 * Picks the authoritative active leaf id: prefers an explicitly remembered leaf when it still
 * exists in `entries`, else falls back to Pi's reported leaf id (or the latest entry if missing).
 */
export function resolveEffectiveLeaf(
  entries: readonly PiEntry[],
  reportedLeafId: string | null,
  preferredLeafId?: string | null,
): string | null {
  if (entries.length === 0) return null
  const ids = new Set(entries.map((entry) => entry.id))
  if (preferredLeafId !== undefined) {
    if (preferredLeafId === null) return null
    if (ids.has(preferredLeafId)) return preferredLeafId
  }
  if (reportedLeafId !== null && ids.has(reportedLeafId)) return reportedLeafId
  return entries[entries.length - 1]!.id
}

function entryTime(entry: PiEntry): number | null {
  if (typeof entry.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  const msgTime = entry.message?.timestamp
  if (typeof msgTime === 'number' && Number.isFinite(msgTime) && msgTime > 0) return msgTime
  return null
}

function compactPreview(raw: string): string {
  const first = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!first) return ''
  const chars = [...first]
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 1).join('')}…` : first
}

function previewOf(entry: PiEntry): {
  text: string
  role: SessionBranchNode['previewRole']
} | null {
  if (entry.type === 'message' && entry.message) {
    const role = entry.message.role
    if (role === 'user') {
      const text = compactPreview(typedText(withoutAhead(blockText(entry.message.content))))
      return { text, role: 'user' }
    }
    if (role === 'assistant') {
      const text = compactPreview(blockText(entry.message.content))
      if (text) return { text, role: 'assistant' }
      return null
    }
    if (role === 'branchSummary' || role === 'compactionSummary') {
      const text = compactPreview(entry.message.summary ?? blockText(entry.message.content))
      return { text, role: 'summary' }
    }
    if (role === 'bashExecution') {
      const text = compactPreview(entry.message.command ?? '')
      if (text) return { text, role: 'user' }
    }
    return null
  }
  if (entry.type === 'branch_summary' || entry.type === 'compaction') {
    return { text: compactPreview(entry.summary ?? ''), role: 'summary' }
  }
  if (entry.type === 'custom_message' && entry.display !== false) {
    const text = compactPreview(blockText(entry.content))
    if (text) return { text, role: 'assistant' }
  }
  return null
}

function isConversationEntry(entry: PiEntry): boolean {
  if (!CONVERSATION_TYPES.has(entry.type)) return false
  if (entry.type === 'message') {
    const role = entry.message?.role
    return role !== undefined && role !== 'system'
  }
  return true
}

interface RawTreeNode {
  entry: PiEntry
  order: number
  children: RawTreeNode[]
}

interface Segment {
  id: string
  entries: PiEntry[]
  children: Segment[]
  hasConversation: boolean
  isCurrent: boolean
}

/**
 * Builds the compressed branch tree from Pi's native entries and active leaf id.
 * Iterative throughout so deep linear transcripts never overflow the call stack.
 */
export function buildPiBranches(
  entries: readonly PiEntry[],
  leafId: string | null,
): SessionBranchesResult {
  if (entries.length === 0) {
    return { activeLeafId: leafId, branchCount: 0, hasBranches: false, nodes: [] }
  }

  const byId = new Map<string, RawTreeNode>()
  const roots: RawTreeNode[] = []
  let hasAnyConversation = false

  entries.forEach((entry, order) => {
    if (isConversationEntry(entry)) hasAnyConversation = true
    byId.set(entry.id, { entry, order, children: [] })
  })

  if (!hasAnyConversation) {
    const activeLeafId = leafId !== null && byId.has(leafId) ? leafId : null
    return { activeLeafId, branchCount: 0, hasBranches: false, nodes: [] }
  }

  for (const entry of entries) {
    const node = byId.get(entry.id)!
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node)
      continue
    }
    const parent = byId.get(entry.parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  // Sort siblings chronologically (oldest first, append order as deterministic tiebreaker).
  const sortOrder = (a: RawTreeNode, b: RawTreeNode): number => {
    const ta = entryTime(a.entry)
    const tb = entryTime(b.entry)
    if (ta !== null && tb !== null && ta !== tb) return ta - tb
    return a.order - b.order
  }
  roots.sort(sortOrder)
  const sortStack: RawTreeNode[] = [...roots]
  while (sortStack.length > 0) {
    const node = sortStack.pop()!
    if (node.children.length > 1) node.children.sort(sortOrder)
    for (const child of node.children) sortStack.push(child)
  }

  const effectiveLeafId = leafId !== null && byId.has(leafId) ? leafId : null
  const activePathIds = new Set<string>()
  for (let id = effectiveLeafId; id !== null && !activePathIds.has(id);) {
    const node = byId.get(id)
    if (!node) break
    activePathIds.add(id)
    id = node.entry.parentId
  }

  // Compress linear chains iteratively, splitting whenever a node branches or holds the active leaf
  // so an active mid-chain node stays directly selectable alongside its downstream continuation.
  const compressFrom = (start: RawTreeNode): Segment => {
    const chain: PiEntry[] = [start.entry]
    let current = start
    let hasConversation = isConversationEntry(current.entry)
    while (current.children.length === 1 && current.entry.id !== effectiveLeafId) {
      current = current.children[0]!
      chain.push(current.entry)
      if (isConversationEntry(current.entry)) hasConversation = true
    }
    return {
      id: current.entry.id,
      entries: chain,
      children: [],
      hasConversation,
      isCurrent: current.entry.id === effectiveLeafId,
    }
  }

  const topSegments: Segment[] = []
  const buildStack: { raw: RawTreeNode; parent: Segment | null }[] = []
  for (let i = roots.length - 1; i >= 0; i--) {
    buildStack.push({ raw: roots[i]!, parent: null })
  }
  while (buildStack.length > 0) {
    const { raw, parent } = buildStack.pop()!
    const segment = compressFrom(raw)
    if (parent) parent.children.push(segment)
    else topSegments.push(segment)
    const tip = byId.get(segment.id)!
    for (let i = tip.children.length - 1; i >= 0; i--) {
      buildStack.push({ raw: tip.children[i]!, parent: segment })
    }
  }

  // Unwrap a single leading metadata-only root (e.g. model_change -> thinking_level_change before
  // the first prompt forks) so top-level rows represent real conversation branches.
  let displayRoots = topSegments
  while (
    displayRoots.length === 1 &&
    !displayRoots[0]!.hasConversation &&
    !displayRoots[0]!.isCurrent &&
    displayRoots[0]!.children.length > 0
  ) {
    displayRoots = displayRoots[0]!.children
  }

  const labels = extractLabels(entries)
  const nodes: SessionBranchNode[] = []
  let branchCount = 0

  const emitStack: { segment: Segment; parentId: string | null; depth: number }[] = []
  for (let i = displayRoots.length - 1; i >= 0; i--) {
    emitStack.push({ segment: displayRoots[i]!, parentId: null, depth: 0 })
  }

  while (emitStack.length > 0) {
    const { segment, parentId, depth } = emitStack.pop()!
    const isLeaf = segment.children.length === 0
    if (isLeaf) branchCount++

    let turnCount = 0
    let firstUser: { text: string; role: SessionBranchNode['previewRole'] } | null = null
    let fallbackPreview: { text: string; role: SessionBranchNode['previewRole'] } | null = null
    let label: string | null = null
    let timestamp: number | null = null
    let onActivePath = false

    for (const entry of segment.entries) {
      if (activePathIds.has(entry.id)) onActivePath = true
      if (entry.type === 'message' && entry.message?.role === 'user') turnCount++
      const entryLabel = labels.get(entry.id)
      if (entryLabel) label = entryLabel
      const time = entryTime(entry)
      if (time !== null) timestamp = time
      const candidate = previewOf(entry)
      if (candidate) {
        if (!firstUser && candidate.role === 'user' && candidate.text) firstUser = candidate
        if (!fallbackPreview || (!fallbackPreview.text && candidate.text)) {
          fallbackPreview = candidate
        }
      }
    }

    const chosen = firstUser ?? fallbackPreview
    nodes.push({
      id: segment.id,
      parentId,
      label,
      preview: chosen?.text ?? '',
      previewRole: chosen?.role ?? 'system',
      timestamp,
      turnCount,
      depth,
      isLeaf,
      isCurrent: segment.isCurrent,
      onActivePath,
    })

    for (let i = segment.children.length - 1; i >= 0; i--) {
      emitStack.push({
        segment: segment.children[i]!,
        parentId: segment.id,
        depth: depth + 1,
      })
    }
  }

  return {
    activeLeafId: effectiveLeafId,
    branchCount,
    hasBranches: branchCount > 1,
    nodes,
  }
}
