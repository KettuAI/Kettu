// `remote/devices.json`: the devices paired with this computer, which the remote host owns. Main
// adds and removes them; the remote host reads them for each handshake and notes each connection.

import path from 'node:path'
import {
  deviceId,
  isDeviceField,
  isDeviceName,
  type NewDevice,
  type PairedDevice,
} from '@shared/remote/device'
import { JsonFile, type LogFn, type Migration } from '../agent-host/storage'

const DEVICES_VERSION = 1
const DEVICES_MIGRATIONS: Readonly<Record<number, Migration>> = {}
const MAX_DEVICES = 1000

interface DevicesFile {
  version: 1
  devices: PairedDevice[]
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
  const { id, publicKey, name, kind, platform, addedAt, lastConnectedAt } = value as Record<
    string,
    unknown
  >
  if (typeof id !== 'string' || publicKeyBytes(publicKey) === null) return null
  if (!isDeviceName(name) || !isDeviceField(kind) || !isDeviceField(platform)) return null
  if (!isTime(addedAt) || !(lastConnectedAt === null || isTime(lastConnectedAt))) return null
  return {
    id,
    publicKey: publicKey as string,
    name,
    kind,
    platform,
    addedAt,
    lastConnectedAt,
  }
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
  return { version: 1, devices }
}

export class DeviceStore {
  private readonly byId = new Map<string, PairedDevice>()
  private readonly byKey = new Map<string, PairedDevice>()

  private constructor(
    private readonly file: JsonFile<DevicesFile>,
    devices: PairedDevice[],
    private readonly now: () => number,
  ) {
    for (const device of devices) this.put(device)
  }

  static async load(userDataPath: string, log: LogFn, now = Date.now): Promise<DeviceStore> {
    const file = new JsonFile<DevicesFile>({
      file: path.join(userDataPath, 'remote', 'devices.json'),
      version: DEVICES_VERSION,
      migrations: DEVICES_MIGRATIONS,
      parse: parseDevicesFile,
      empty: () => ({ version: 1, devices: [] }),
      log,
    })
    const { devices } = await file.load()
    // An id is derived from the key; an entry whose id is not is dropped rather than trusted.
    const checked = await Promise.all(
      devices.map(async (device) =>
        (await deviceId(publicKeyBytes(device.publicKey)!)) === device.id ? device : null,
      ),
    )
    const kept = checked.filter((device): device is PairedDevice => device !== null)
    if (kept.length !== devices.length) log('warn', 'Dropped devices whose id is not their key')
    const store = new DeviceStore(file, kept, now)
    if (kept.length !== devices.length) store.save()
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

  /** Pairs a device, replacing the entry of the same key; null when the device is not valid. */
  async add(device: NewDevice): Promise<PairedDevice | null> {
    const key = publicKeyBytes(device.publicKey)
    if (!key || !isDeviceName(device.name)) return null
    if (!isDeviceField(device.kind) || !isDeviceField(device.platform)) return null
    const id = await deviceId(key)
    if (!this.byId.has(id) && this.byId.size >= MAX_DEVICES) return null
    const added: PairedDevice = {
      id,
      publicKey: device.publicKey,
      name: device.name,
      kind: device.kind,
      platform: device.platform,
      addedAt: this.now(),
      lastConnectedAt: null,
    }
    this.put(added)
    this.save()
    await this.file.flush()
    return added
  }

  async remove(id: string): Promise<boolean> {
    const device = this.byId.get(id)
    if (!device) return false
    this.byId.delete(id)
    this.byKey.delete(device.publicKey)
    this.save()
    await this.file.flush()
    return true
  }

  /** Notes a session opening now; the write waits a moment, as connections come in bursts. */
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
    this.file.save({ version: 1, devices: this.list() })
  }
}
