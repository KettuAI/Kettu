import { create } from 'zustand'
import type { ArtifactImportResult, ArtifactSummary } from '@shared/artifacts'
import { errorMessage, host } from '@renderer/lib/host'

interface ArtifactsStore {
  /** Every artifact outside Recently deleted, newest first; null until the first read. */
  list: ArtifactSummary[] | null
  /** Recently deleted, the latest deletion first; null until the first read. */
  deleted: ArtifactSummary[] | null
  /** Why the last read failed, until a read succeeds. */
  error: string | null
  /** The page's filter, kept while the viewer shows so Back returns to the same list. */
  filter: string
  /** The card the viewer was opened from, which takes the focus back. */
  opened: string | null
  /** Why the last import failed, until it is dismissed or another import starts. */
  importFailed: ImportFailure | null
  /** The rename or permanent delete waiting for the user's answer. */
  dialog: ArtifactDialog | null
}

export type ArtifactDialog =
  | { kind: 'rename'; id: string; title: string }
  | { kind: 'delete'; id: string; title: string }
  | { kind: 'erase'; id: string; title: string; versions: number; published: boolean }

export type ImportFailure = Extract<ArtifactImportResult, { failed: string }>['failed'] | 'failed'

export const useArtifactsStore = create<ArtifactsStore>()(() => ({
  list: null,
  deleted: null,
  error: null,
  filter: '',
  opened: null,
  importFailed: null,
  dialog: null,
}))

let shown = 0
let stale = true
let reading = false
let readAgain = false

function read(): void {
  if (reading) {
    readAgain = true
    return
  }
  reading = true
  stale = false
  Promise.all([host('artifacts.list', {}), host('artifacts.list', { deleted: true })])
    .then(
      ([list, deleted]) => useArtifactsStore.setState({ list, deleted, error: null }),
      (error: unknown) => {
        stale = true
        useArtifactsStore.setState({ error: errorMessage(error) })
      },
    )
    .finally(() => {
      reading = false
      if (!readAgain) return
      readAgain = false
      read()
    })
}

/**
 * A page, viewer or pane that shows artifacts came into view or left it; while one shows, the lists
 * follow the host's changes.
 */
export function artifactListShown(on: boolean): void {
  shown += on ? 1 : -1
  if (on && stale) read()
}

/** The host's list changed, or the host came back: read now if the page shows, else on its return. */
export function artifactsChanged(): void {
  if (shown > 0) read()
  else stale = true
}

export function retryArtifacts(): void {
  read()
}

export function setArtifactsFilter(filter: string): void {
  useArtifactsStore.setState({ filter })
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

/** Asks main for a file through its open dialog; `project` null is No project. */
export async function importArtifact(project: string | null): Promise<string | null> {
  useArtifactsStore.setState({ importFailed: null })
  let result: ArtifactImportResult
  try {
    result = await window.overbench.artifacts.import(project)
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
