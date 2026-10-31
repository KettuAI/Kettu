// `remote/activity.json`: what each device did, by device id, for its page in Settings. A device's
// events outlive it for their 30 days, so one paired again shows that it was removed.

import path from 'node:path'
import {
  ACTIVITY_DAYS,
  ACTIVITY_TITLE_CHARS,
  MAX_ACTIVITY,
  type DeviceActivity,
  type NewActivity,
} from '@shared/remote/activity'
import { DEVICE_ID, isDeviceName } from '@shared/remote/device'
import { JsonFile, type LogFn, type Migration } from '../agent-host/storage'

const ACTIVITY_VERSION = 1
const ACTIVITY_MIGRATIONS: Readonly<Record<number, Migration>> = {}
const KEEP_MS = ACTIVITY_DAYS * 24 * 60 * 60 * 1000
// Removed devices keep their logs too; past this many, the least recent ones go.
const MAX_LOGS = 2000
const MAX_SESSION_ID = 128
/** A device back this soon after its last session ended is on the same connection. */
const RECONNECT_MS = 10 * 60 * 1000

interface ActivityFile {
  version: 1
  /** Each device's events, oldest first. */
  devices: Record<string, DeviceActivity[]>
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID

const cutTitle = (title: string): string => [...title].slice(0, ACTIVITY_TITLE_CHARS).join('')

function parseEvent(value: unknown): DeviceActivity | null {
  if (typeof value !== 'object' || value === null) return null
  const event = value as Record<string, unknown>
  const { at, kind } = event
  if (!isTime(at)) return null
  switch (kind) {
    case 'paired':
    case 'connected':
      return { at, kind }
    case 'renamed': {
      const { from, to, by } = event
      if (!isDeviceName(from) || !isDeviceName(to) || (by !== 'owner' && by !== 'device')) {
        return null
      }
      return { at, kind, from, to, by }
    }
    case 'removed': {
      const { by } = event
      return by === 'owner' || by === 'unseen' || by === 'reset' ? { at, kind, by } : null
    }
    case 'session-created':
    case 'session-archived':
    case 'session-deleted': {
      const { sessionId, title = null } = event
      if (!isSessionId(sessionId)) return null
      // Events kept before titles were have none.
      if (title !== null && (typeof title !== 'string' || cutTitle(title) !== title)) return null
      return { at, kind, sessionId, title }
    }
    default:
      return null
  }
}

// An event this version cannot read is dropped rather than the file, which holds no state that
// matters beyond what it shows.
function parseActivityFile(data: Record<string, unknown>): ActivityFile | string {
  const devices = data.devices
  if (typeof devices !== 'object' || devices === null || Array.isArray(devices)) {
    return 'devices is not an object'
  }
  const kept: Record<string, DeviceActivity[]> = {}
  for (const [id, events] of Object.entries(devices)) {
    if (!DEVICE_ID.test(id) || !Array.isArray(events)) continue
    const parsed = events.map(parseEvent).filter((event) => event !== null)
    if (parsed.length > 0) kept[id] = parsed.slice(-MAX_ACTIVITY)
  }
  return { version: 1, devices: kept }
}

export class ActivityLog {
  private readonly logs: Map<string, DeviceActivity[]>
  /** Each device's sessions open now, and when its last one ended; for this run only. */
  private readonly open = new Map<string, number>()
  private readonly ended = new Map<string, number>()

  private constructor(
    private readonly file: JsonFile<ActivityFile>,
    devices: Record<string, DeviceActivity[]>,
    private readonly now: () => number,
  ) {
    this.logs = new Map(Object.entries(devices))
    this.prune()
  }

  static async load(userDataPath: string, log: LogFn, now = Date.now): Promise<ActivityLog> {
    const file = new JsonFile<ActivityFile>({
      file: path.join(userDataPath, 'remote', 'activity.json'),
      version: ACTIVITY_VERSION,
      migrations: ACTIVITY_MIGRATIONS,
      parse: parseActivityFile,
      empty: () => ({ version: 1, devices: {} }),
      log,
    })
    const { devices } = await file.load()
    return new ActivityLog(file, devices, now)
  }

  /** Notes an event now; the write waits a moment, as events come in bursts. */
  record(deviceId: string, event: NewActivity): void {
    const events = this.logs.get(deviceId) ?? []
    const kept = 'title' in event && event.title !== null ? { title: cutTitle(event.title) } : {}
    events.push({ ...event, ...kept, at: this.now() } as DeviceActivity)
    if (events.length > MAX_ACTIVITY) events.splice(0, events.length - MAX_ACTIVITY)
    // Most recent last, so the least recent log is the first to go past the cap.
    this.logs.delete(deviceId)
    this.logs.set(deviceId, events)
    while (this.logs.size > MAX_LOGS) this.logs.delete(this.logs.keys().next().value!)
    this.save()
  }

  /**
   * Notes a session of the device opening: a connection, unless another of its sessions is open
   * or the last one ended within 10 minutes, as a flaky network's do again and again.
   */
  opened(deviceId: string): void {
    const open = this.open.get(deviceId) ?? 0
    this.open.set(deviceId, open + 1)
    const ended = this.ended.get(deviceId)
    if (open > 0 || (ended !== undefined && this.now() - ended < RECONNECT_MS)) return
    this.record(deviceId, { kind: 'connected' })
  }

  /** Notes a session of the device ending. */
  closed(deviceId: string): void {
    const open = (this.open.get(deviceId) ?? 0) - 1
    if (open > 0) return void this.open.set(deviceId, open)
    this.open.delete(deviceId)
    this.ended.set(deviceId, this.now())
  }

  /** A device's events of the last 30 days, newest first. */
  list(deviceId: string): DeviceActivity[] {
    this.prune()
    return [...(this.logs.get(deviceId) ?? [])].reverse()
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private prune(): void {
    const since = this.now() - KEEP_MS
    let changed = false
    for (const [id, events] of this.logs) {
      const first = events.findIndex((event) => event.at >= since)
      if (first === 0) continue
      changed = true
      if (first < 0) this.logs.delete(id)
      else events.splice(0, first)
    }
    if (changed) this.save()
  }

  private save(): void {
    this.file.save({ version: 1, devices: Object.fromEntries(this.logs) })
  }
}
