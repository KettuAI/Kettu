import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { KettuApi } from '@shared/ipc'
import type {
  PublishedArtifact,
  SharingConnectResult,
  SharingResult,
  SharingStatus,
} from '@shared/sharing'
import { errorMessage } from '@renderer/lib/host'

export interface SharingStore {
  /** What main has: the account and every published page; null until the first read. */
  status: SharingStatus | null
}

/** A host's sharing: what it has, and the calls that change it. */
export interface Sharing {
  useSharingStore: UseBoundStore<StoreApi<SharingStore>>
  connect(token: string, accountId: string | null): Promise<SharingConnectResult>
  remove(): Promise<SharingResult>
  publish(id: string, version: number): Promise<SharingResult>
  update(id: string, version: number): Promise<SharingResult>
  unpublish(id: string): Promise<SharingResult>
}

function failure(error: unknown): SharingResult {
  console.error('A sharing request failed', error)
  return { failed: 'failed', message: errorMessage(error) }
}

/** The sharing of the host `api` reaches: this computer's main, or another host's parent. */
export function createSharing(api: () => KettuApi['sharing']): Sharing {
  const useSharingStore = create<SharingStore>()(() => ({ status: null }))
  const take = (result: SharingResult): SharingResult => {
    if ('status' in result) useSharingStore.setState({ status: result.status })
    return result
  }
  const call = async (run: () => Promise<SharingResult>): Promise<SharingResult> => {
    try {
      return take(await run())
    } catch (error) {
      return failure(error)
    }
  }
  return {
    useSharingStore,
    connect: async (token, accountId) => {
      try {
        const result = await api().connect(token, accountId)
        return 'status' in result ? take(result) : result
      } catch (error) {
        return failure(error)
      }
    },
    remove: () => call(async () => ({ status: await api().remove() })),
    publish: (id, version) => call(() => api().publish(id, version)),
    update: (id, version) => call(() => api().update(id, version)),
    unpublish: (id) => call(() => api().unpublish(id)),
  }
}

/** This computer's sharing, or the web client's host's. */
export const localSharing = createSharing(() => window.kettu.sharing)

export const useSharingStore = localSharing.useSharingStore

/** Reads the status and follows main's changes; called once at bootstrap. */
export async function initSharing(): Promise<void> {
  window.kettu.sharing.onChanged((status) => useSharingStore.setState({ status }))
  try {
    useSharingStore.setState({ status: await window.kettu.sharing.status() })
  } catch (error) {
    console.error('Could not read the sharing status', error)
  }
}

export const connectSharing = localSharing.connect
export const removeSharing = localSharing.remove
export const publishArtifact = localSharing.publish
export const updateSharedArtifact = localSharing.update
export const unpublishArtifact = localSharing.unpublish

/** The page an artifact is published at, from any component that may change. */
export function publishedPage(id: string): PublishedArtifact | null {
  return useSharingStore.getState().status?.published.find((page) => page.id === id) ?? null
}

/** Whether a published page exists for the artifact right now, for the menus. */
export function isPublished(id: string): boolean {
  return publishedPage(id) !== null
}
