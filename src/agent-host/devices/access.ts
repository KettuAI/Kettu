// The mobile devices the user always lets agents use, kept on the host in `state/device-access.json`.

import path from 'node:path'
import { JsonFile, type LogFn } from '../storage'

export interface DeviceAccessFile {
  version: 1
  /** Device ids: `ios-sim:<udid>`, `ios:<udid>`, `android:<serial>` or `avd:<name>`. */
  allowed: string[]
}

const DEVICE_ID = /^(ios-sim|ios|android|avd):[\w.:\-@]+$/
const MAX_DEVICES = 500

export function parseDeviceAccessFile(data: Record<string, unknown>): DeviceAccessFile | string {
  if (!Array.isArray(data.allowed)) return '"allowed" must be a list'
  const allowed = data.allowed.filter(
    (id): id is string => typeof id === 'string' && id.length <= 256 && DEVICE_ID.test(id),
  )
  return { version: 1, allowed: [...new Set(allowed)].slice(0, MAX_DEVICES) }
}

export class DeviceAccessStore {
  private readonly file: JsonFile<DeviceAccessFile>
  private allowed = new Set<string>()
  readonly ready: Promise<void>

  constructor(userDataPath: string, log: LogFn) {
    this.file = new JsonFile<DeviceAccessFile>({
      file: path.join(userDataPath, 'state', 'device-access.json'),
      version: 1,
      migrations: {},
      parse: parseDeviceAccessFile,
      empty: () => ({ version: 1, allowed: [] }),
      log,
    })
    this.ready = this.file.load().then(
      (data) => {
        this.allowed = new Set(data.allowed)
      },
      () => undefined,
    )
  }

  has(deviceId: string): boolean {
    return this.allowed.has(deviceId)
  }

  add(deviceId: string): void {
    if (!DEVICE_ID.test(deviceId) || this.allowed.has(deviceId)) return
    this.allowed.add(deviceId)
    this.save()
  }

  remove(deviceId: string): void {
    if (this.allowed.delete(deviceId)) this.save()
  }

  list(): string[] {
    return [...this.allowed]
  }

  private save(): void {
    this.file.save({ version: 1, allowed: [...this.allowed] })
  }
}
