import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { KettuApi } from '@shared/ipc'
import type {
  PublishedArtifact,
  ShareAccess,
  SharingConnectResult,
  SharingOpenResult,
  SharingResult,
  SharingStatus,
  SharingTarget,
} from '@shared/sharing'
import { errorMessage } from '@renderer/lib/host'

export interface SharingStore {
  /** What main has: the accounts and every published page; null until the first read. */
  status: SharingStatus | null
}

/** A host's sharing: what it has, and the calls that change it. */
export interface Sharing {
  useSharingStore: UseBoundStore<StoreApi<SharingStore>>
  connect(token: string, accountId: string | null): Promise<SharingConnectResult>
  remove(): Promise<SharingResult>
  /** Reads the Kettu account's pages and storage again, as a view that shows them opens. */
  refresh(): Promise<SharingResult>
  publish(
    id: string,
    version: number,
    target: SharingTarget,
    access: ShareAccess,
  ): Promise<SharingResult>
  update(id: string, version: number): Promise<SharingResult>
  setAccess(id: string, access: ShareAccess): Promise<SharingResult>
  newCode(id: string): Promise<SharingResult>
  openLink(id: string): Promise<SharingOpenResult>
  unpublish(id: string): Promise<SharingResult>
  setAuto(enabled: boolean): Promise<SharingResult>
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
    refresh: () => call(async () => ({ status: await api().refresh() })),
    publish: (id, version, target, access) =>
      call(() => api().publish(id, version, target, access)),
    update: (id, version) => call(() => api().update(id, version)),
    setAccess: (id, access) => call(() => api().setAccess(id, access)),
    newCode: (id) => call(() => api().newCode(id)),
    openLink: async (id) => {
      try {
        return await api().openLink(id)
      } catch (error) {
        console.error('A sharing request failed', error)
        return { failed: 'failed', message: errorMessage(error) }
      }
    },
    unpublish: (id) => call(() => api().unpublish(id)),
    setAuto: (enabled) => call(() => api().setAuto(enabled)),
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
export const refreshSharing = localSharing.refresh
export const publishArtifact = localSharing.publish
export const updateSharedArtifact = localSharing.update
export const setSharedAccess = localSharing.setAccess
export const newSharedCode = localSharing.newCode
export const sharedPageLink = localSharing.openLink
export const unpublishArtifact = localSharing.unpublish
export const setAutoPublish = localSharing.setAuto

/** The page an artifact is published at, from any component that may change. */
export function publishedPage(id: string): PublishedArtifact | null {
  return useSharingStore.getState().status?.published.find((page) => page.id === id) ?? null
}

/** Whether a published page exists for the artifact right now, for the menus. */
export function isPublished(id: string): boolean {
  return publishedPage(id) !== null
}

/** Whether the host's account for the page's target is the one it was published with. */
export function canChange(page: PublishedArtifact, status: SharingStatus): boolean {
  const owner = page.target === 'kettu' ? status.kettu.account : status.cloudflare
  return owner !== null && !page.otherAccount
}
