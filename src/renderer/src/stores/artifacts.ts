import { create } from 'zustand'
import type { ArtifactSummary } from '@shared/artifacts'
import { errorMessage, host } from '@renderer/lib/host'

interface ArtifactsStore {
  /** Every artifact outside Recently deleted, newest first; null until the first read. */
  list: ArtifactSummary[] | null
  /** Why the last read failed, until a read succeeds. */
  error: string | null
  /** The page's filter, kept while the viewer shows so Back returns to the same list. */
  filter: string
  /** The card the viewer was opened from, which takes the focus back. */
  opened: string | null
}

export const useArtifactsStore = create<ArtifactsStore>()(() => ({
  list: null,
  error: null,
  filter: '',
  opened: null,
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
  host('artifacts.list', {})
    .then(
      (list) => useArtifactsStore.setState({ list, error: null }),
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

/** The page came into view or left it; while it shows, the list follows the host's changes. */
export function artifactsPageShown(on: boolean): void {
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
