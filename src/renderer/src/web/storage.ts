// What the web client keeps in this browser, in IndexedDB: its device key and the host it paired
// with, and in the hosted build its Kettu sign-in and each account's hosts. The key is stored as
// the channel's primitives made it, a non-extractable WebCrypto key where the page has WebCrypto,
// which IndexedDB keeps without ever exposing its bytes.

import type { KeyPair } from '@shared/remote/noise'

export interface PairedHost {
  /** The host's X25519 public key, which every handshake is encrypted to. */
  hostKey: Uint8Array
  /** The host's name and this browser's name there, as the last welcome said. */
  name: string
  deviceName: string
}

export interface WebDevice {
  key: KeyPair
  host: PairedHost | null
}

const DATABASE = 'kettu'
const STORE = 'device'
/** The hosted build's: its sign-in, and the hosts of each account. */
export const HOSTED_STORE = 'hosted'
const STORES = [STORE, HOSTED_STORE]
const RECORD = 'this'

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2)
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
  name = STORE,
): Promise<T> {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(name, mode)
      const request = work(transaction.objectStore(name))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

function isWebDevice(value: unknown): value is WebDevice {
  if (typeof value !== 'object' || value === null) return false
  const { key, host } = value as Record<string, unknown>
  const pair = key as Partial<KeyPair> | null
  if (!pair?.privateKey || !(pair.publicKey instanceof Uint8Array)) return false
  if (host === null) return true
  const paired = host as Partial<PairedHost> | undefined
  return (
    paired?.hostKey instanceof Uint8Array &&
    typeof paired.name === 'string' &&
    typeof paired.deviceName === 'string'
  )
}

/** The device as this browser keeps it, or null before it ever paired or once it was cleared. */
export async function loadDevice(): Promise<WebDevice | null> {
  const value = await run('readonly', (store) => store.get(RECORD))
  return isWebDevice(value) ? value : null
}

export async function saveDevice(device: WebDevice): Promise<void> {
  await run('readwrite', (store) => store.put(device, RECORD))
}

/** Deletes everything the web client keeps in this browser's IndexedDB. */
export function clearAll(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    // Another tab holds the database open; it closes it after each use, so the delete goes on.
    request.onblocked = () => {}
  })
}

/**
 * Asks the browser not to clear this site's storage on its own, as Safari does for a site not
 * opened in seven days; a browser may say no, and the client then just pairs again.
 */
export async function keepStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
