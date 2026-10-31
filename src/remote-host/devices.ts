// `remote/devices.json`: the devices paired with this computer, which the remote host owns, and
// the keys of the devices removed, so one that comes back hears why it can no longer connect. Main
// adds and removes them; the remote host reads them for each handshake and notes each connection.

import path from 'node:path'
import {
  deviceId,
  isDeviceField,
  isDeviceModel,
  isDeviceName,
  type NewDevice,
  type PairedDevice,
} from '@shared/remote/device'
import { JsonFile, type LogFn, type Migration } from '../agent-host/storage'

const DEVICES_VERSION = 1
const DEVICES_MIGRATIONS: Readonly<Record<number, Migration>> = {}
const MAX_DEVICES = 1000
const MAX_REMOVED = 1000

/** A device removed by the owner or for not being seen, whose key the host still recognizes. */
export interface RemovedDevice {
  id: string
  /** Its X25519 public key, in base64. */
  publicKey: string
  removedAt: number
}

interface DevicesFile {
  version: 1
  devices: PairedDevice[]
  /** Oldest first; absent in files written before removed devices were kept. */
  removed?: RemovedDevice[]
}

const KEY_BYTES = 32

/** The 32 bytes of an X25519 public key in base64, or null when the text is not one. */
export function publicKeyBytes(text: unknown): Uint8Array | null {
  if (typeof text !== 'string') return null
  const bytes = Buffer.from(text, 'base64')
  // Only the canonical text of 32 bytes, so one key always has one entry.
  if (bytes.length !== KEY_BYTES || bytes.toString('base64') !== text) return null
  return new Uint8Array(bytes)
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function parseDevice(value: unknown): PairedDevice | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, publicKey, name, kind, platform, model, addedAt, lastConnectedAt } = value as Record<
    string,
    unknown
  >
  if (typeof id !== 'string' || publicKeyBytes(publicKey) === null) return null
  if (!isDeviceName(name) || !isDeviceField(kind) || !isDeviceField(platform)) return null
  // Devices paired before models were kept have none.
  const kept = model ?? ''
  if (!isDeviceModel(kept)) return null
  if (!isTime(addedAt) || !(lastConnectedAt === null || isTime(lastConnectedAt))) return null
  return {
    id,
    publicKey: publicKey as string,
    name,
    kind,
    platform,
    model: kept,
    addedAt,
    lastConnectedAt,
  }
}

function parseRemoved(value: unknown): RemovedDevice | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, publicKey, removedAt } = value as Record<string, unknown>
  if (typeof id !== 'string' || publicKeyBytes(publicKey) === null || !isTime(removedAt)) {
    return null
  }
  return { id, publicKey: publicKey as string, removedAt }
}

function parseDevicesFile(data: Record<string, unknown>): DevicesFile | string {
  if (!Array.isArray(data.devices) || data.devices.length > MAX_DEVICES) {
    return 'devices is not a list'
  }
  const devices: PairedDevice[] = []
  for (const [index, item] of data.devices.entries()) {
    const device = parseDevice(item)
    if (!device) return `device ${index} is malformed`
    devices.push(device)
  }
  const listed = data.removed ?? []
  if (!Array.isArray(listed) || listed.length > MAX_REMOVED) return 'removed is not a list'
  const removed: RemovedDevice[] = []
  for (const [index, item] of listed.entries()) {
    const entry = parseRemoved(item)
    if (!entry) return `removed device ${index} is malformed`
    removed.push(entry)
  }
  return { version: 1, devices, removed }
}

/** The entries whose id is the one their key gives. */
async function withTrueIds<T extends { id: string; publicKey: string }>(
  entries: T[],
): Promise<T[]> {
  const ids = await Promise.all(entries.map((entry) => deviceId(publicKeyBytes(entry.publicKey)!)))
  return entries.filter((entry, index) => ids[index] === entry.id)
}

export class DeviceStore {
  private readonly byId = new Map<string, PairedDevice>()
  private readonly byKey = new Map<string, PairedDevice>()
  /** In the order they were removed, so the first is the oldest. */
  private readonly removedByKey = new Map<string, RemovedDevice>()

  private constructor(
    private readonly file: JsonFile<DevicesFile>,
    devices: PairedDevice[],
    removed: RemovedDevice[],
    private readonly now: () => number,
  ) {
    for (const device of devices) this.put(device)
    for (const entry of removed) this.removedByKey.set(entry.publicKey, entry)
  }

  static async load(userDataPath: string, log: LogFn, now = Date.now): Promise<DeviceStore> {
    const file = new JsonFile<DevicesFile>({
      file: path.join(userDataPath, 'remote', 'devices.json'),
      version: DEVICES_VERSION,
      migrations: DEVICES_MIGRATIONS,
      parse: parseDevicesFile,
      empty: () => ({ version: 1, devices: [], removed: [] }),
      log,
    })
    const { devices, removed = [] } = await file.load()
    // An id is derived from the key; an entry whose id is not is dropped rather than trusted.
    const [kept, keptRemoved] = await Promise.all([withTrueIds(devices), withTrueIds(removed)])
    const dropped = kept.length !== devices.length || keptRemoved.length !== removed.length
    if (dropped) log('warn', 'Dropped devices whose id is not their key')
    const store = new DeviceStore(file, kept, keptRemoved, now)
    if (dropped) store.save()
    return store
  }

  list(): PairedDevice[] {
    return [...this.byId.values()]
  }

  get(id: string): PairedDevice | null {
    return this.byId.get(id) ?? null
  }

  /** The paired device with this public key, or null for a key the host does not know. */
  withKey(publicKey: Uint8Array): PairedDevice | null {
    return this.byKey.get(Buffer.from(publicKey).toString('base64')) ?? null
  }

  /** The removed device with this public key, or null for a key not on the removed list. */
  removedWithKey(publicKey: Uint8Array): RemovedDevice | null {
    return this.removedByKey.get(Buffer.from(publicKey).toString('base64')) ?? null
  }

  /**
   * Pairs a device, replacing the entry of the same key and taking the key off the removed list;
   * null when the device is not valid.
   */
  async add(device: NewDevice): Promise<PairedDevice | null> {
    const key = publicKeyBytes(device.publicKey)
    if (!key || !isDeviceName(device.name)) return null
    if (!isDeviceField(device.kind) || !isDeviceField(device.platform)) return null
    if (!isDeviceModel(device.model)) return null
    const id = await deviceId(key)
    if (!this.byId.has(id) && this.byId.size >= MAX_DEVICES) return null
    const added: PairedDevice = {
      id,
      publicKey: device.publicKey,
      name: device.name,
      kind: device.kind,
      platform: device.platform,
      model: device.model,
      addedAt: this.now(),
      lastConnectedAt: null,
    }
    this.put(added)
    this.removedByKey.delete(added.publicKey)
    this.save()
    await this.file.flush()
    return added
  }

  /** Forgets a device and puts its key on the removed list, dropping the oldest past the cap. */
  async remove(id: string): Promise<boolean> {
    const device = this.byId.get(id)
    if (!device) return false
    this.byId.delete(id)
    this.byKey.delete(device.publicKey)
    const { publicKey } = device
    this.removedByKey.set(publicKey, { id, publicKey, removedAt: this.now() })
    for (const key of this.removedByKey.keys()) {
      if (this.removedByKey.size <= MAX_REMOVED) break
      this.removedByKey.delete(key)
    }
    this.save()
    await this.file.flush()
    return true
  }

  /** Empties the removed list, as a reset does: a new identity is a new host to every device. */
  async clearRemoved(): Promise<void> {
    this.removedByKey.clear()
    this.save()
    await this.file.flush()
  }

  /** The device under its new name, or null when there is no such device or the name is not one. */
  async rename(id: string, name: string): Promise<PairedDevice | null> {
    const device = this.byId.get(id)
    if (!device || !isDeviceName(name)) return null
    const renamed = { ...device, name }
    this.put(renamed)
    this.save()
    await this.file.flush()
    return renamed
  }

  /**
   * Notes a session opening or ending now; the write waits a moment, as connections come in
   * bursts.
   */
  connected(id: string): void {
    const device = this.byId.get(id)
    if (!device) return
    this.put({ ...device, lastConnectedAt: this.now() })
    this.save()
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private put(device: PairedDevice): void {
    this.byId.set(device.id, device)
    this.byKey.set(device.publicKey, device)
  }

  private save(): void {
    this.file.save({ version: 1, devices: this.list(), removed: [...this.removedByKey.values()] })
  }
}
