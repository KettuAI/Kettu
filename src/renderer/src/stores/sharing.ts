import { create } from 'zustand'
import type { PublishedArtifact, SharingResult, SharingStatus } from '@shared/sharing'
import { errorMessage } from '@renderer/lib/host'

interface SharingStore {
  /** What main has: the account and every published page; null until the first read. */
  status: SharingStatus | null
}

export const useSharingStore = create<SharingStore>()(() => ({ status: null }))

function take(result: SharingResult): SharingResult {
  if ('status' in result) useSharingStore.setState({ status: result.status })
  return result
}

function failure(error: unknown): SharingResult {
  console.error('A sharing request failed', error)
  return { failed: 'failed', message: errorMessage(error) }
}

/** Reads the status and follows main's changes; called once at bootstrap. */
export async function initSharing(): Promise<void> {
  window.overbench.sharing.onChanged((status) => useSharingStore.setState({ status }))
  try {
    useSharingStore.setState({ status: await window.overbench.sharing.status() })
  } catch (error) {
    console.error('Could not read the sharing status', error)
  }
}

export async function connectSharing(accountId: string, token: string): Promise<SharingResult> {
  try {
    return take(await window.overbench.sharing.connect(accountId, token))
  } catch (error) {
    return failure(error)
  }
}

export async function removeSharing(): Promise<SharingResult> {
  try {
    const status = await window.overbench.sharing.remove()
    useSharingStore.setState({ status })
    return { status }
  } catch (error) {
    return failure(error)
  }
}

export async function publishArtifact(id: string, version: number): Promise<SharingResult> {
  try {
    return take(await window.overbench.sharing.publish(id, version))
  } catch (error) {
    return failure(error)
  }
}

export async function updateSharedArtifact(id: string, version: number): Promise<SharingResult> {
  try {
    return take(await window.overbench.sharing.update(id, version))
  } catch (error) {
    return failure(error)
  }
}

export async function unpublishArtifact(id: string): Promise<SharingResult> {
  try {
    return take(await window.overbench.sharing.unpublish(id))
  } catch (error) {
    return failure(error)
  }
}

/** The page an artifact is published at, from any component that may change. */
export function publishedPage(id: string): PublishedArtifact | null {
  return useSharingStore.getState().status?.published.find((page) => page.id === id) ?? null
}

/** Whether a published page exists for the artifact right now, for the menus. */
export function isPublished(id: string): boolean {
  return publishedPage(id) !== null
}
