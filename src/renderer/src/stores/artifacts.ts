import { create } from 'zustand'
import type { CommentAnchor } from '@shared/artifact-comments'
import type { ArtifactImportKind, ArtifactImportResult, ArtifactSummary } from '@shared/artifacts'
import type { HostEvent } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import {
  parseOpened,
  withOpened,
  type ArtifactKind,
  type OpenedTimes,
} from '@renderer/features/artifacts/model'
import { artifactHost, errorMessage, host, hostAt, learnArtifactHost } from '@renderer/lib/host'
import { readJson, writeJson } from '@renderer/lib/storage'

const OPENED_KEY = 'artifacts.opened'

interface ArtifactsStore {
  /** Every artifact outside Recently deleted, newest first; null until the first read. */
  list: ArtifactSummary[] | null
  /** Recently deleted, the latest deletion first; null until the first read. */
  deleted: ArtifactSummary[] | null
  /**
   * The other hosts whose artifacts are in the lists. Until a host's are, nothing says an artifact
   * of its sessions is gone.
   */
  hostsRead: readonly string[]
  /** Why the last read failed, until a read succeeds. */
  error: string | null
  /** The page's filters, kept while the viewer shows so Back returns to the same list. */
  filter: string
  kindFilter: ArtifactKind | null
  /** Projects' folders, or NO_PROJECT; none keeps every project. */
  projectFilter: readonly string[]
  /** The agents of the sessions the artifacts show under; none keeps every agent. */
  agentFilter: readonly AgentId[]
  /** When this device last showed each artifact. */
  openedAt: OpenedTimes
  /** The card the viewer was opened from, which takes the focus back. */
  opened: string | null
  /** Why the last import failed, until it is dismissed or another import starts. */
  importFailed: ImportFailure | null
  /** The rename or permanent delete waiting for the user's answer. */
  dialog: ArtifactDialog | null
  /** The element picked in an artifact beside a project's thread, which its composer offers. */
  paneSelection: PaneSelection | null
}

/** An element, or a page, picked in the artifact pane, as context for the session beside it. */
export interface PaneSelection {
  projectPath: string
  artifactId: string
  title: string
  anchor: CommentAnchor
}

export type ArtifactDialog =
  | { kind: 'rename'; id: string; title: string }
  | { kind: 'delete'; id: string; title: string; onDeleted?: () => void }
  | { kind: 'erase'; id: string; title: string; versions: number; published: boolean }

export type ImportFailure = Extract<ArtifactImportResult, { failed: string }>['failed'] | 'failed'

export const useArtifactsStore = create<ArtifactsStore>()(() => ({
  list: null,
  deleted: null,
  hostsRead: [],
  error: null,
  filter: '',
  kindFilter: null,
  projectFilter: [],
  agentFilter: [],
  openedAt: parseOpened(readJson<unknown>(OPENED_KEY, {})),
  opened: null,
  importFailed: null,
  dialog: null,
  paneSelection: null,
}))

/** Where an artifact stands in the lists read so far: shown, deleted, or gone for good. */
export type ArtifactStanding = 'live' | 'deleted' | 'erased'

export function artifactStanding(
  s: Pick<ArtifactsStore, 'list' | 'deleted' | 'hostsRead'>,
  id: string,
): ArtifactStanding {
  if (s.list?.some((a) => a.id === id)) return 'live'
  if (s.deleted?.some((a) => a.id === id)) return 'deleted'
  // Until both lists of its host arrive, nothing says it is gone.
  const hostId = artifactHost(id)
  if (hostId !== null && !s.hostsRead.includes(hostId)) return 'live'
  return s.list && s.deleted ? 'erased' : 'live'
}

/** A host's two lists as last read; this computer's under null. */
interface HostLists {
  list: ArtifactSummary[]
  deleted: ArtifactSummary[]
}

let shown = 0
const lists = new Map<string | null, HostLists>()
/** This computer, and the other hosts whose session is open. */
const hosts = new Set<string | null>([null])
const stale = new Set<string | null>([null])
const reading = new Set<string | null>()
const readAgain = new Set<string | null>()

/** Every host's artifacts in one list each, ordered as a host orders its own. */
function publish(): void {
  const own = lists.get(null)
  if (!own) return
  const others = [...lists].filter(([hostId]) => hostId !== null).map(([, value]) => value)
  useArtifactsStore.setState({
    list:
      others.length === 0
        ? own.list
        : [own, ...others].flatMap((l) => l.list).sort((a, b) => b.updatedAt - a.updatedAt),
    deleted:
      others.length === 0
        ? own.deleted
        : [own, ...others]
            .flatMap((l) => l.deleted)
            .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
    hostsRead: [...lists.keys()].filter((hostId) => hostId !== null),
  })
}

function read(hostId: string | null): void {
  if (!hosts.has(hostId)) return
  if (reading.has(hostId)) {
    readAgain.add(hostId)
    return
  }
  reading.add(hostId)
  stale.delete(hostId)
  Promise.all([
    hostAt(hostId, 'artifacts.list', {}),
    hostAt(hostId, 'artifacts.list', { deleted: true }),
  ])
    .then(
      ([list, deleted]) => {
        if (!hosts.has(hostId)) return
        if (hostId === null) for (const a of [...list, ...deleted]) learnArtifactHost(a.id, null)
        lists.set(hostId, { list, deleted })
        if (hostId === null) useArtifactsStore.setState({ error: null })
        publish()
      },
      (error: unknown) => {
        stale.add(hostId)
        // Another host that cannot be read shows nothing; only this computer's failure is told.
        if (hostId === null) useArtifactsStore.setState({ error: errorMessage(error) })
        else console.warn(`Could not read the artifacts of host ${hostId}`, error)
      },
    )
    .finally(() => {
      reading.delete(hostId)
      if (readAgain.delete(hostId)) read(hostId)
    })
}

/**
 * A page, viewer or pane that shows artifacts came into view or left it; while one shows, the lists
 * follow the hosts' changes.
 */
export function artifactListShown(on: boolean): void {
  shown += on ? 1 : -1
  if (on) for (const hostId of [...stale]) read(hostId)
}

/**
 * A host's list changed, or the host came back: read now if a page shows, else on its return.
 * `hostId` is null for this computer.
 */
export function artifactsChanged(hostId: string | null = null): void {
  if (!hosts.has(hostId)) return
  if (shown > 0) read(hostId)
  else stale.add(hostId)
}

/** A session with another host opened: its artifacts join the lists. */
export function artifactsHostOpened(hostId: string): void {
  hosts.add(hostId)
  artifactsChanged(hostId)
}

/** The session ended, or the host is forgotten: its artifacts leave the lists. */
export function artifactsHostClosed(hostId: string): void {
  hosts.delete(hostId)
  stale.delete(hostId)
  readAgain.delete(hostId)
  if (lists.delete(hostId)) publish()
}

type ArtifactEvent = Extract<HostEvent, { type: `artifacts.${string}` }>
type ArtifactEventListener = (event: ArtifactEvent, hostId: string | null) => void

const eventListeners = new Set<ArtifactEventListener>()

/** Each host's events about its artifacts, with the host, null for this computer. */
export function onArtifactEvent(listener: ArtifactEventListener): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function receiveArtifactEvent(event: HostEvent, hostId: string | null): void {
  if (!event.type.startsWith('artifacts.')) return
  for (const listener of [...eventListeners]) listener(event as ArtifactEvent, hostId)
}

export function retryArtifacts(): void {
  read(null)
}

export function setArtifactsFilter(filter: string): void {
  useArtifactsStore.setState({ filter })
}

export function setArtifactsKindFilter(kindFilter: ArtifactKind | null): void {
  useArtifactsStore.setState({ kindFilter })
}

export function setArtifactsProjectFilter(projectFilter: readonly string[]): void {
  useArtifactsStore.setState({ projectFilter })
}

export function setArtifactsAgentFilter(agentFilter: readonly AgentId[]): void {
  useArtifactsStore.setState({ agentFilter })
}

/** A viewer or pane shows the artifact: the page lists it as just opened. */
export function markArtifactOpened(id: string): void {
  const { openedAt, list, deleted } = useArtifactsStore.getState()
  const known = list && deleted ? new Set([...list, ...deleted].map((a) => a.id)) : null
  const next = withOpened(openedAt, id, Date.now(), known)
  useArtifactsStore.setState({ openedAt: next })
  writeJson(OPENED_KEY, next)
}

// The host announces each change with `artifacts.changed`, which reads the lists again.

export function renameArtifact(id: string, title: string): Promise<void> {
  return host('artifacts.rename', { id, title })
}

/** To Recently deleted, which needs no confirmation since it can be undone. */
export function deleteArtifact(id: string): Promise<void> {
  return host('artifacts.delete', { id })
}

export function restoreArtifact(id: string): Promise<void> {
  return host('artifacts.undelete', { id })
}

/** From Recently deleted, for good. */
export function eraseArtifact(id: string): Promise<void> {
  return host('artifacts.delete', { id, permanently: true })
}

/** Asks main for a file or folder through its open dialog; `project` null is No project. */
export async function importArtifact(
  project: string | null,
  kind: ArtifactImportKind,
): Promise<string | null> {
  useArtifactsStore.setState({ importFailed: null })
  let result: ArtifactImportResult
  try {
    result = await window.kettu.artifacts.import(project, kind)
  } catch (error) {
    console.error('Could not import an artifact', error)
    useArtifactsStore.setState({ importFailed: 'failed' })
    return null
  }
  if (result === null) return null
  if ('failed' in result) {
    useArtifactsStore.setState({ importFailed: result.failed })
    return null
  }
  return result.id
}

export function dismissImportFailure(): void {
  useArtifactsStore.setState({ importFailed: null })
}

export function askArtifactDialog(dialog: ArtifactDialog | null): void {
  useArtifactsStore.setState({ dialog })
}

/** An earlier version written again as the newest, by the user; `baseVersion` is the latest. */
export async function restoreVersion(
  id: string,
  version: number,
  baseVersion: number,
): Promise<void> {
  await host('artifacts.restoreVersion', { id, version, baseVersion })
}

/** What the pane offers its session's composer; null takes it away. */
export function setPaneSelection(selection: PaneSelection | null): void {
  useArtifactsStore.setState({ paneSelection: selection })
}
