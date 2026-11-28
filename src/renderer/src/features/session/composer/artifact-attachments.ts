// Project artifacts attached to a composer draft as lightweight references (ID, title, kind),
// kept with the draft in memory and localStorage and serialized into a concise prompt block
// so the agent can inspect them on demand with `read_artifact`.

import { create } from 'zustand'
import { artifactLink, parseArtifactLink } from '@shared/artifact-links'
import { ARTIFACT_ID, type ArtifactSummary } from '@shared/artifacts'
import { artifactKind, foldForMatch } from '@renderer/features/artifacts/model'
import { artifactHost } from '@renderer/lib/host'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import {
  readDraftArtifacts,
  writeDraftArtifacts,
  type AttachedArtifact,
  type AttachedArtifactKind,
} from './drafts'

export type { AttachedArtifact, AttachedArtifactKind }

interface AttachedArtifactsStore {
  /** By draft: a session's id, or New session's draft key. */
  byDraft: Record<string, readonly AttachedArtifact[]>
}

const useAttachedArtifactsStore = create<AttachedArtifactsStore>()(() => ({ byDraft: {} }))

const NONE: readonly AttachedArtifact[] = []

const ATTACHED_SINGLE_HEADER = 'Attached artifact (use `read_artifact` to inspect):'
const ATTACHED_PLURAL_HEADER = 'Attached artifacts (use `read_artifact` to inspect):'
const ATTACHED_LINE =
  /^- \[(.+)\]\((kettu:\/\/artifact\/art_[0-9A-HJKMNP-TV-Z]{26})\) \(`(art_[0-9A-HJKMNP-TV-Z]{26})`, (document|slides|web|canvas)\)$/

/** Deduplicates attached artifacts by id while keeping their first occurrence order. */
export function dedupeAttachedArtifacts(items: readonly AttachedArtifact[]): AttachedArtifact[] {
  const seen = new Set<string>()
  const out: AttachedArtifact[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/** Converts an artifact summary into the lightweight reference stored in a draft. */
export function toAttachedArtifact(
  summary: Pick<ArtifactSummary, 'id' | 'title' | 'type' | 'pages' | 'canvas'>,
  hostId: string | null = artifactHost(summary.id),
): AttachedArtifact {
  return {
    id: summary.id,
    title: summary.title,
    kind: artifactKind(summary),
    ...(hostId ? { hostId } : {}),
  }
}

export function draftArtifactAttachments(draft: string): readonly AttachedArtifact[] {
  const items = useAttachedArtifactsStore.getState().byDraft[draft] ?? NONE
  if (items.length === 0) return items
  const { hidden } = useArtifactsStore.getState()
  if (hidden.size === 0) return items
  return items.filter((item) => !hidden.has(item.id))
}

/** A composer's attached artifacts, for a component; the same empty list when it has none. */
export function useDraftArtifactAttachments(draft: string): readonly AttachedArtifact[] {
  return useAttachedArtifactsStore((s) => s.byDraft[draft] ?? NONE)
}

export function setDraftArtifactAttachments(
  draft: string,
  items: readonly AttachedArtifact[],
): void {
  const unique = dedupeAttachedArtifacts(items)
  useAttachedArtifactsStore.setState((s) => {
    const byDraft = { ...s.byDraft }
    if (unique.length > 0) byDraft[draft] = unique
    else delete byDraft[draft]
    return { byDraft }
  })
  writeDraftArtifacts(draft, unique)
}

/** Takes up the attached artifacts a draft was saved with, once, as its composer opens. */
export function hydrateDraftArtifactAttachments(draft: string): void {
  if (draft in useAttachedArtifactsStore.getState().byDraft) return
  const saved = readDraftArtifacts(draft)
  if (saved.length > 0) {
    useAttachedArtifactsStore.setState((s) => ({
      byDraft: { ...s.byDraft, [draft]: dedupeAttachedArtifacts(saved) },
    }))
  }
}

/**
 * Attaches an artifact to `draft`. Returns false without changing state if the same artifact id
 * is already attached.
 */
export function attachArtifactToDraft(draft: string, artifact: AttachedArtifact): boolean {
  const current = draftArtifactAttachments(draft)
  if (current.some((item) => item.id === artifact.id)) return false
  setDraftArtifactAttachments(draft, [...current, artifact])
  return true
}

/** Removes an attached artifact from `draft` by id. */
export function removeAttachedArtifact(draft: string, artifactId: string): void {
  const current = draftArtifactAttachments(draft)
  const next = current.filter((item) => item.id !== artifactId)
  if (next.length === current.length) return
  setDraftArtifactAttachments(draft, next)
}

/**
 * Restores attached artifacts after a failed send: restored items go before anything attached
 * since, deduplicated by id.
 */
export function restoreDraftArtifactAttachments(
  draft: string,
  items: readonly AttachedArtifact[],
): void {
  if (items.length === 0) return
  const current = draftArtifactAttachments(draft)
  const existing = new Set(current.map((item) => item.id))
  const restored = dedupeAttachedArtifacts(items).filter((item) => !existing.has(item.id))
  if (restored.length === 0) return
  setDraftArtifactAttachments(draft, [...restored, ...current])
}

/** Filters out attached artifacts that do not belong to `hostId` (e.g. after switching hosts). */
export function keepHostArtifactAttachments(draft: string, hostId: string | null): void {
  const current = draftArtifactAttachments(draft)
  const next = current.filter((item) => (item.hostId ?? null) === hostId)
  if (next.length !== current.length) setDraftArtifactAttachments(draft, next)
}

export interface SelectableArtifactsOptions {
  /** Selected project's path, or null when no project is chosen yet. */
  projectPath: string | null
  /** True when working in No project (scratch) mode. */
  noProject?: boolean
  /** Target host id, or null for this computer. */
  hostId: string | null
  /** Artifact ids already attached in the composer, excluded from the picker list. */
  attachedIds?: ReadonlySet<string>
  /** Free-text search query matching title, kind, or artifact id. */
  query?: string
  /** Resolves which remote host owns an artifact; defaults to `artifactHost`. */
  hostOfArtifact?: (id: string) => string | null
}

export interface SelectableArtifactsResult {
  /** Selectable non-deleted artifacts matching scope and query, newest first. */
  items: ArtifactSummary[]
  /** Total non-deleted artifacts in the current host/project scope. */
  scopeCount: number
  /** Non-deleted artifacts in scope that are not yet attached. */
  availableCount: number
}

/**
 * Selects the non-deleted artifacts offered by the composer's Attach artifact picker:
 * - scoped to the target host;
 * - for a selected project, that project's artifacts;
 * - for No project (scratch), scratch artifacts;
 * - when no project is selected yet, recent artifacts across the host;
 * - excludes already-attached ids, deduplicates by id, filters by query, and sorts newest first.
 */
export function selectableArtifacts(
  list: readonly ArtifactSummary[],
  {
    projectPath,
    noProject = false,
    hostId,
    attachedIds,
    query = '',
    hostOfArtifact = artifactHost,
  }: SelectableArtifactsOptions,
): SelectableArtifactsResult {
  const seen = new Set<string>()
  const inScope: ArtifactSummary[] = []
  for (const artifact of list) {
    if (artifact.deletedAt !== null) continue
    if (seen.has(artifact.id)) continue
    seen.add(artifact.id)
    if (hostOfArtifact(artifact.id) !== hostId) continue
    if (noProject) {
      if (!artifact.scratch) continue
    } else if (projectPath !== null) {
      if (artifact.scratch || artifact.project !== projectPath) continue
    }
    inScope.push(artifact)
  }

  const available = attachedIds?.size
    ? inScope.filter((artifact) => !attachedIds.has(artifact.id))
    : inScope

  const wanted = foldForMatch(query.trim())
  const matched = wanted
    ? available.filter(
        (artifact) =>
          foldForMatch(artifact.title).includes(wanted) ||
          foldForMatch(artifact.id).includes(wanted) ||
          foldForMatch(artifactKind(artifact)).includes(wanted),
      )
    : available

  const items = [...matched].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

  return {
    items,
    scopeCount: inScope.length,
    availableCount: available.length,
  }
}

/** Sanitizes an artifact title for safe inclusion inside a Markdown link label. */
function escapeLinkLabel(title: string): string {
  const singleLine = title.replace(/\s+/g, ' ').trim() || 'Untitled artifact'
  return singleLine.replace(/([[\]\\])/g, '\\$1')
}

function unescapeLinkLabel(label: string): string {
  return label.replace(/\\([[\]\\])/g, '$1')
}

/**
 * Formats the lightweight artifact reference block appended to a user prompt, telling the agent
 * each artifact's title, ID, and kind so it can inspect them on demand with `read_artifact`.
 */
export function formatAttachedArtifactsPrompt(
  text: string,
  artifacts: readonly AttachedArtifact[],
): string {
  const unique = dedupeAttachedArtifacts(artifacts)
  if (unique.length === 0) return text
  const header = unique.length === 1 ? ATTACHED_SINGLE_HEADER : ATTACHED_PLURAL_HEADER
  const lines = unique.map(
    (artifact) =>
      `- [${escapeLinkLabel(artifact.title)}](${artifactLink(artifact.id)}) (\`${artifact.id}\`, ${artifact.kind})`,
  )
  const block = [header, ...lines].join('\n')
  const trimmed = text.trimEnd()
  return trimmed.trim().length > 0 ? `${trimmed}\n\n${block}` : block
}

export interface ParsedAttachedArtifactsPrompt {
  text: string
  artifacts: AttachedArtifact[]
}

/**
 * Splits a prompt produced by `formatAttachedArtifactsPrompt` back into the user's text and the
 * lightweight artifact references, for clean thread rendering and edit/retry round-trips.
 * Returns null when the text does not end with an attached-artifact reference block.
 */
export function splitAttachedArtifactsPrompt(text: string): ParsedAttachedArtifactsPrompt | null {
  const normalized = text.replace(/\r\n/g, '\n')
  const trimmedEnd = normalized.trimEnd()
  const lines = trimmedEnd.split('\n')

  let headerIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line === ATTACHED_SINGLE_HEADER || line === ATTACHED_PLURAL_HEADER) {
      headerIndex = i
      break
    }
  }
  if (headerIndex < 0) return null
  // The header must either start the prompt or be separated from user text by a blank line.
  if (headerIndex > 0 && lines[headerIndex - 1] !== '') return null

  const itemLines = lines.slice(headerIndex + 1)
  if (itemLines.length === 0) return null

  const artifacts: AttachedArtifact[] = []
  for (const line of itemLines) {
    const match = ATTACHED_LINE.exec(line)
    if (!match) return null
    const [, rawTitle, href, id, kind] = match
    const parsedLink = parseArtifactLink(href!)
    if (!parsedLink || parsedLink.place !== null || parsedLink.artifactId !== id) return null
    if (!ARTIFACT_ID.test(id!)) return null
    artifacts.push({
      id: id!,
      title: unescapeLinkLabel(rawTitle!),
      kind: kind as AttachedArtifactKind,
    })
  }

  const body = headerIndex === 0 ? '' : lines.slice(0, headerIndex).join('\n').trimEnd()
  return { text: body, artifacts: dedupeAttachedArtifacts(artifacts) }
}
