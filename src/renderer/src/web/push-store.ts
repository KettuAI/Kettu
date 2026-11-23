// What this browser keeps for Web Push, which the page writes and the service worker reads: the
// VAPID pair it subscribes with, each host's key its pushes must be signed with, the sound switch,
// and the notification a click asked to open while no page was. A database of its own, so the
// worker never opens the page's at another version.

import type { AppCommand } from '@shared/ipc'

export interface PushRecord {
  /** The raw public key and the private key's 32 bytes, in base64url, which every host gets. */
  vapid: { publicKey: string; privateKey: string }
  /** The Ed25519 public key of each host by its id, learned over the channel to it. */
  hosts: Record<string, Uint8Array>
  /** Whether notifications sound, as Settings > Notifications says. */
  sound: boolean
}

/** A click on a notification, for the page connected to its host. */
export interface PushClick {
  type: 'kettu-notification-click'
  host: string
  command: AppCommand
}

const DATABASE = 'kettu-push'
const STORE = 'push'
const RECORD = 'this'
const PENDING = 'pending'

/** How long a click waits for a page to open and take it. */
const PENDING_MS = 60_000

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = work(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

function isRecord(value: unknown): value is PushRecord {
  const record = value as Partial<PushRecord> | null
  return (
    typeof record?.vapid?.publicKey === 'string' &&
    typeof record.vapid.privateKey === 'string' &&
    typeof record.hosts === 'object' &&
    record.hosts !== null &&
    typeof record.sound === 'boolean'
  )
}

export async function loadPushRecord(): Promise<PushRecord | null> {
  const value = await run('readonly', (store) => store.get(RECORD))
  return isRecord(value) ? value : null
}

export async function savePushRecord(record: PushRecord): Promise<void> {
  await run('readwrite', (store) => store.put(record, RECORD))
}

/** Keeps a click for the page a moment, as the worker opens one. */
export async function keepClick(click: PushClick): Promise<void> {
  await run('readwrite', (store) => store.put({ click, at: Date.now() }, PENDING))
}

/** The click a page opened for, once and only while it is recent. */
export async function takeClick(): Promise<PushClick | null> {
  const value = (await run('readonly', (store) => store.get(PENDING))) as
    { click?: PushClick; at?: number } | undefined
  if (!value) return null
  await run('readwrite', (store) => store.delete(PENDING))
  const fresh = typeof value.at === 'number' && Date.now() - value.at < PENDING_MS
  return fresh && value.click?.type === 'kettu-notification-click' ? value.click : null
}

/** Deletes what this browser keeps for Web Push. */
export function clearPushStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => {}
  })
}
