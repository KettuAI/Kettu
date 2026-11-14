// The devices of this host: what the tools list, which session holds each, who is operating it,
// and the stream of each device someone watches.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Env } from '../agent-host/find-command'
import type {
  DeviceEnvironment,
  DeviceEvent,
  DeviceFrame,
  DeviceId,
  DeviceInfo,
  DeviceInput,
  DeviceOperator,
  DeviceOrientation,
  DeviceProblem,
  DeviceScreen,
} from '@shared/device-host'
import type { Platform } from '@shared/platform'
import { AndroidDriver, bootEmulator } from './android'
import {
  findTools,
  listAndroid,
  listPhysicalIos,
  listSimulators,
  run,
  type FoundDevice,
  type Tools,
} from './discovery'
import { DriverError, type DeviceDriver } from './driver'
import { IosDeviceDriver } from './ios-device'
import { bootSimulator, IosSimulatorDriver, shutdownSimulator } from './ios-simulator'
import { FrameFanout } from './stream'

/** A device nobody watches keeps capturing this long, for a pane that comes straight back. */
const IDLE_CAPTURE_MS = 30_000
const LIST_EVERY_MS = 5_000

export class DeviceError extends Error {
  constructor(
    readonly code: 'not_found' | 'busy' | 'unavailable' | 'forbidden' | 'internal',
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

interface Live {
  driver: DeviceDriver
  fanout: FrameFanout
  screen: DeviceScreen | null
  input: boolean
  idle: ReturnType<typeof setTimeout> | null
  wanted: ReturnType<typeof setTimeout> | null
  starting: Promise<void>
}

export interface DeviceManagerDeps {
  platform: Platform
  /** Kettu's data folder, where the sessions' devices are kept across restarts of the host. */
  dataDir: string | null
  env: () => Promise<Env>
  resourcesPath: string | null
  /** Sends an event to one port, or to every window and allowed device when `port` is null. */
  emit(port: string | null, event: DeviceEvent): void
  log(message: string): void
}

export class DeviceManager {
  private tools: Tools | null = null
  private found = new Map<DeviceId, FoundDevice>()
  private readonly leases = new Map<DeviceId, string>()
  /** Simulators this host booted, which shut down once no session holds them. */
  private readonly booted = new Set<DeviceId>()
  /** Simulators this host is booting, which a listing from before the boot must not forget. */
  private readonly booting = new Set<DeviceId>()
  private readonly operators = new Map<DeviceId, DeviceOperator>()
  private readonly live = new Map<DeviceId, Live>()
  /** The devices each port watches. */
  private readonly watching = new Map<string, Set<DeviceId>>()
  private listing: Promise<DeviceInfo[]> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private lastList = ''
  private saving: Promise<void> = Promise.resolve()

  private readonly restored: Promise<void>

  constructor(private readonly deps: DeviceManagerDeps) {
    this.restored = this.restoreLeases()
  }

  private leasesFile(): string | null {
    return this.deps.dataDir ? path.join(this.deps.dataDir, 'state', 'device-leases.json') : null
  }

  private async restoreLeases(): Promise<void> {
    const file = this.leasesFile()
    if (!file) return
    const text = await readFile(file, 'utf8').catch(() => null)
    if (!text) return
    try {
      const parsed = JSON.parse(text) as { leases?: Record<string, unknown>; booted?: unknown }
      for (const [id, sessionId] of Object.entries(parsed.leases ?? {})) {
        if (typeof sessionId === 'string' && sessionId.length <= 256) this.leases.set(id, sessionId)
      }
      for (const id of Array.isArray(parsed.booted) ? parsed.booted : []) {
        if (typeof id === 'string' && id.length <= 256) this.booted.add(id)
      }
    } catch {
      this.deps.log('Ignored an unreadable device-leases.json')
    }
  }

  /**
   * Which session holds which device, so a pane shows its devices again after a restart, and
   * which simulators this host booted.
   */
  private saveLeases(): void {
    const file = this.leasesFile()
    if (!file) return
    const body = JSON.stringify({
      leases: Object.fromEntries(this.leases),
      booted: [...this.booted],
    })
    // One write at a time, so an older one never lands last; dispose waits for the last.
    this.saving = this.saving
      .then(() => mkdir(path.dirname(file), { recursive: true }))
      .then(() => writeFile(`${file}.tmp`, body))
      .then(() => rename(`${file}.tmp`, file))
      .catch((error: unknown) => this.deps.log(`Cannot save device-leases.json: ${String(error)}`))
  }

  async environment(): Promise<DeviceEnvironment> {
    const tools = await this.loadTools()
    const problems: DeviceProblem[] = []
    const mac = this.deps.platform === 'darwin'
    if (mac && !tools.xcrun) problems.push('xcode-missing')
    if (mac && tools.xcrun && process.arch !== 'arm64') problems.push('apple-silicon-required')
    if (!tools.adb) problems.push('android-sdk-missing')
    return {
      platform: this.deps.platform,
      ios: !!tools.xcrun,
      iosStream: !!tools.xcrun && process.arch === 'arm64',
      android: !!tools.adb,
      problems,
    }
  }

  /** Lists again, at most once at a time, and tells every client when anything changed. */
  list(): Promise<DeviceInfo[]> {
    if (!this.listing) {
      this.listing = this.restored
        .then(() => this.refresh())
        .finally(() => {
          this.listing = null
        })
    }
    return this.listing
  }

  /** Keeps listing while some client is connected, so plugged-in phones show up. */
  setPolling(on: boolean): void {
    if (on && !this.poll) {
      this.poll = setInterval(() => void this.list().catch(() => undefined), LIST_EVERY_MS)
    } else if (!on && this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
  }

  info(id: DeviceId): DeviceInfo | null {
    const found = this.found.get(id)
    return found ? this.toInfo(found) : null
  }

  /** The device as the tools address it, for the agent's actions. */
  target(id: DeviceId): FoundDevice | null {
    return this.found.get(id) ?? null
  }

  async open(id: DeviceId, sessionId: string): Promise<DeviceInfo> {
    let found = this.found.get(id)
    if (!found) {
      await this.list()
      found = this.found.get(id)
    }
    if (!found) throw new DeviceError('not_found', 'No such device on this host')
    const holder = this.leases.get(id)
    if (holder && holder !== sessionId) {
      throw new DeviceError('busy', 'Another session is using this device', { sessionId: holder })
    }
    this.leases.set(id, sessionId)
    this.saveLeases()
    const tools = await this.loadTools()
    const env = await this.deps.env()
    if (found.kind === 'simulator' && found.state !== 'booted' && tools.xcrun) {
      this.setState(id, 'booting')
      this.booting.add(id)
      try {
        if (await bootSimulator(tools.xcrun, found.target, env)) {
          this.booted.add(id)
          this.saveLeases()
        }
        // Waits for a listing that began before the boot, too, while it cannot forget the boot.
        await this.list()
      } catch (error) {
        this.setState(id, 'shutdown')
        throw new DeviceError('unavailable', `The simulator did not boot: ${String(error)}`)
      } finally {
        this.booting.delete(id)
      }
    } else if (found.kind === 'emulator' && found.state === 'shutdown') {
      if (!tools.emulator || !tools.adb)
        throw new DeviceError('unavailable', 'The Android emulator is missing')
      this.setState(id, 'booting')
      const serial = await bootEmulator(tools.emulator, tools.adb, found.target, env).catch(
        (error: unknown) => {
          this.setState(id, 'shutdown')
          throw new DeviceError('unavailable', `The emulator did not start: ${String(error)}`)
        },
      )
      // The running emulator is listed by its serial; the lease moves with it.
      this.leases.delete(id)
      id = `android:${serial}`
      this.leases.set(id, sessionId)
      this.saveLeases()
      await this.list()
    } else {
      await this.list()
    }
    const info = this.info(id)
    if (!info) throw new DeviceError('not_found', 'The device went away')
    return info
  }

  /** Takes the device from the session; a simulator this host booted shuts down with it. */
  async close(id: DeviceId, sessionId: string, shutdown: boolean): Promise<void> {
    await this.restored
    if (this.leases.get(id) !== sessionId) return
    this.leases.delete(id)
    const booted = this.booted.delete(id)
    this.saveLeases()
    this.operators.delete(id)
    this.dropWatchers(id)
    await this.stopLive(id)
    if (shutdown || booted) await this.shutDown(id)
    await this.list()
  }

  /**
   * Lets go of the devices of sessions that were archived or deleted. Only the simulators this
   * host booted shut down; others stay on, since the user may still be using them.
   */
  async endSessions(sessionIds: string[]): Promise<void> {
    await this.restored
    const ended = new Set(sessionIds)
    const booted: DeviceId[] = []
    for (const [id, sessionId] of [...this.leases]) {
      if (!ended.has(sessionId)) continue
      this.leases.delete(id)
      this.operators.delete(id)
      this.dropWatchers(id)
      if (this.booted.delete(id)) booted.push(id)
    }
    this.saveLeases()
    this.broadcastList()
    if (booted.length === 0) return
    await Promise.all(
      booted.map(async (id) => {
        await this.stopLive(id)
        await this.shutDown(id)
      }),
    )
    await this.list()
  }

  private async shutDown(id: DeviceId): Promise<void> {
    // A host that just started has not listed yet.
    if (!this.found.has(id)) await this.list()
    const found = this.found.get(id)
    if (!found) return
    const tools = await this.loadTools()
    const env = await this.deps.env()
    if (found.kind === 'simulator' && tools.xcrun) {
      await shutdownSimulator(tools.xcrun, found.target, env)
    }
    if (found.kind === 'emulator' && tools.adb) {
      await run(tools.adb, ['-s', found.target, 'emu', 'kill'], env).catch(() => undefined)
    }
  }

  holder(id: DeviceId): string | null {
    return this.leases.get(id) ?? null
  }

  async watch(
    port: string,
    id: DeviceId,
    sessionId: string,
  ): Promise<{ screen: DeviceScreen | null }> {
    await this.restored
    this.checkHolder(id, sessionId)
    // A host that just started has not listed yet.
    if (!this.found.has(id)) await this.list()
    const found = this.found.get(id)
    if (!found) throw new DeviceError('not_found', 'No such device on this host')
    const live = await this.ensureLive(found)
    // The session may have let go of the device while its stream started.
    this.checkHolder(id, sessionId)
    let set = this.watching.get(port)
    if (!set) this.watching.set(port, (set = new Set()))
    set.add(id)
    if (live.idle) clearTimeout(live.idle)
    live.idle = null
    live.fanout.add(port)
    this.deps.emit(port, {
      type: 'device.stream',
      deviceId: id,
      state: live.screen ? 'live' : 'starting',
    })
    return { screen: live.screen }
  }

  unwatch(port: string, id: DeviceId, sessionId: string): void {
    this.checkHolder(id, sessionId)
    this.stopWatching(port, id)
  }

  private stopWatching(port: string, id: DeviceId): void {
    this.watching.get(port)?.delete(id)
    const live = this.live.get(id)
    if (!live) return
    live.fanout.remove(port)
    if (live.fanout.watching === 0 && !live.idle) {
      live.idle = setTimeout(() => void this.stopLive(id), IDLE_CAPTURE_MS)
    }
  }

  portClosed(port: string): void {
    for (const id of this.watching.get(port) ?? []) this.stopWatching(port, id)
    this.watching.delete(port)
  }

  ack(port: string, id: DeviceId, seq: number, sessionId: string): void {
    this.checkHolder(id, sessionId)
    this.live.get(id)?.fanout.ack(port, seq)
  }

  input(id: DeviceId, input: DeviceInput, sessionId: string): void {
    this.checkHolder(id, sessionId)
    const live = this.live.get(id)
    if (!live) throw new DeviceError('unavailable', 'The device is not streaming')
    const operator = this.operators.get(id)
    if (operator && operator.sessionId && !operator.user) {
      this.setOperator(id, { ...operator, user: true })
    }
    live.driver.send(input)
  }

  async screenshot(id: DeviceId, sessionId: string): Promise<Uint8Array> {
    await this.restored
    this.checkHolder(id, sessionId)
    const found = this.found.get(id)
    if (!found) throw new DeviceError('not_found', 'No such device on this host')
    const live = await this.ensureLive(found)
    try {
      return await live.driver.screenshot()
    } finally {
      if (live.fanout.watching === 0 && !live.idle) {
        live.idle = setTimeout(() => void this.stopLive(found.id), IDLE_CAPTURE_MS)
      }
    }
  }

  /**
   * Turns a streaming device through its own driver, so the stream and the panes see the turn;
   * false when the device is not streaming or its driver cannot.
   */
  async orient(id: DeviceId, orientation: DeviceOrientation): Promise<boolean> {
    const live = this.live.get(id)
    if (!live?.driver.orient) return false
    await live.starting
    return live.driver.orient(orientation)
  }

  /** The frame of a device that is streaming, or null when it is not or has none of its own. */
  async frame(id: DeviceId, sessionId: string): Promise<DeviceFrame | null> {
    await this.restored
    this.checkHolder(id, sessionId)
    const live = this.live.get(id)
    if (!live) return null
    await live.starting
    return (await live.driver.frame?.()) ?? null
  }

  operator(id: DeviceId): DeviceOperator | null {
    return this.operators.get(id) ?? null
  }

  setOperator(id: DeviceId, operator: DeviceOperator | null): void {
    if (operator) this.operators.set(id, operator)
    else this.operators.delete(id)
    this.broadcastList()
  }

  /** The user takes the device from the agent; the caller stops the agent's running call. */
  takeOver(id: DeviceId, sessionId: string): void {
    this.checkHolder(id, sessionId)
    this.setOperator(id, { sessionId: null, agentName: null, user: true })
  }

  handBack(id: DeviceId, sessionId: string): void {
    this.checkHolder(id, sessionId)
    const operator = this.operators.get(id)
    if (!operator) return
    if (operator.sessionId) this.setOperator(id, { ...operator, user: false })
    else this.setOperator(id, null)
  }

  async dispose(): Promise<void> {
    this.setPolling(false)
    await Promise.all([...this.live.keys()].map((id) => this.stopLive(id)))
    await this.saving
  }

  /** Where the tools are, which agent-device needs on its PATH as well. */
  toolPaths(): Promise<Tools> {
    return this.loadTools()
  }

  private async loadTools(): Promise<Tools> {
    if (!this.tools) this.tools = await findTools(await this.deps.env(), this.deps.platform)
    return this.tools
  }

  private async refresh(): Promise<DeviceInfo[]> {
    const tools = await this.loadTools()
    const env = await this.deps.env()
    const warn = (what: string) => (error: unknown) => {
      this.deps.log(`Cannot list ${what}: ${String(error)}`)
      return [] as FoundDevice[]
    }
    const lists = await Promise.all([
      tools.xcrun ? listSimulators(tools.xcrun, env).catch(warn('simulators')) : [],
      tools.xcrun ? listPhysicalIos(tools.xcrun, env).catch(warn('iOS devices')) : [],
      tools.adb || tools.emulator ? listAndroid(tools, env).catch(warn('Android devices')) : [],
    ])
    const next = new Map<DeviceId, FoundDevice>()
    for (const device of lists.flat()) next.set(device.id, device)
    this.found = next
    // One that went down is no longer ours: booted again by the user, it stays on.
    let forgot = false
    for (const id of this.booted) {
      if (next.get(id)?.state === 'shutdown' && !this.booting.has(id)) {
        this.booted.delete(id)
        forgot = true
      }
    }
    if (forgot) this.saveLeases()
    for (const id of [...this.live.keys()]) if (!next.has(id)) void this.stopLive(id)
    return this.broadcastList()
  }

  private setState(id: DeviceId, state: FoundDevice['state']): void {
    const found = this.found.get(id)
    if (!found) return
    this.found.set(id, { ...found, state })
    this.broadcastList()
  }

  private broadcastList(): DeviceInfo[] {
    const devices = [...this.found.values()].map((found) => this.toInfo(found))
    devices.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    const signature = JSON.stringify(devices)
    if (signature !== this.lastList) {
      this.lastList = signature
      this.deps.emit(null, { type: 'devices.changed', devices })
    }
    return devices
  }

  private toInfo(found: FoundDevice): DeviceInfo {
    const live = this.live.get(found.id)
    return {
      id: found.id,
      platform: found.platform,
      kind: found.kind,
      name: found.name,
      osVersion: found.osVersion,
      model: found.model,
      state: found.state,
      connection: found.connection,
      sessionId: this.leases.get(found.id) ?? null,
      operator: this.operators.get(found.id) ?? null,
      problems: found.problems,
      input: live?.input ?? false,
    }
  }

  private createDriver(found: FoundDevice, tools: Tools, env: Env): DeviceDriver {
    const log = (message: string): void => this.deps.log(`[${found.name}] ${message}`)
    if (found.platform === 'ios' && found.kind === 'simulator') {
      if (!tools.xcrun) throw new DeviceError('unavailable', 'Xcode is not installed')
      if (process.arch !== 'arm64') {
        throw new DeviceError('unavailable', 'Simulator video needs a Mac with Apple silicon')
      }
      return new IosSimulatorDriver(found.target, env, log)
    }
    if (found.platform === 'ios') {
      return new IosDeviceDriver(found.target, found.osVersion, this.deps.resourcesPath, env, log)
    }
    if (!tools.adb) throw new DeviceError('unavailable', 'adb is not installed')
    return new AndroidDriver(found.target, tools.adb, this.deps.resourcesPath, env, log)
  }

  private async ensureLive(found: FoundDevice): Promise<Live> {
    const existing = this.live.get(found.id)
    if (existing) {
      await existing.starting
      return existing
    }
    if (found.state === 'shutdown' || found.state === 'booting') {
      throw new DeviceError('unavailable', 'The device is not running')
    }
    const tools = await this.loadTools()
    const env = await this.deps.env()
    const driver = this.createDriver(found, tools, env)
    const id = found.id
    const live: Live = {
      driver,
      fanout: new FrameFanout(
        (port, frame) =>
          this.deps.emit(port, {
            type: 'device.frame',
            deviceId: id,
            seq: frame.seq,
            kind: frame.kind,
            // Ports carry ArrayBuffers as they are; a view would be serialized as JSON.
            data: frame.data.buffer.slice(
              frame.data.byteOffset,
              frame.data.byteOffset + frame.data.byteLength,
            ) as ArrayBuffer,
          }),
        () => this.wantKeyframe(id),
      ),
      screen: null,
      input: false,
      idle: null,
      wanted: null,
      starting: Promise.resolve(),
    }
    this.live.set(id, live)
    live.starting = driver
      .start({
        frame: (kind, data) => live.fanout.push(kind, data),
        screen: (screen) => {
          live.screen = screen
          for (const port of this.portsOf(id))
            this.deps.emit(port, { type: 'device.screen', deviceId: id, screen })
          for (const port of this.portsOf(id))
            this.deps.emit(port, { type: 'device.stream', deviceId: id, state: 'live' })
        },
        input: (available) => {
          live.input = available
          this.broadcastList()
        },
        ended: (error) => {
          for (const port of this.portsOf(id)) {
            this.deps.emit(port, {
              type: 'device.stream',
              deviceId: id,
              state: error ? 'error' : 'stopped',
              ...(error ? { error } : {}),
            })
          }
          if (this.live.get(id) === live) this.live.delete(id)
        },
      })
      .catch((error: unknown) => {
        if (this.live.get(id) === live) this.live.delete(id)
        const message = error instanceof Error ? error.message : String(error)
        for (const port of this.portsOf(id)) {
          this.deps.emit(port, {
            type: 'device.stream',
            deviceId: id,
            state: 'error',
            error: message,
          })
        }
        throw error instanceof DriverError
          ? new DeviceError('unavailable', message, { reason: error.code })
          : error
      })
    await live.starting
    return live
  }

  private wantKeyframe(id: DeviceId): void {
    const live = this.live.get(id)
    if (!live || live.wanted) return
    // Many ports falling behind at once ask the encoder once. A port that asked in the meantime
    // and still waits is asked for again, or a still screen would leave it frozen.
    live.wanted = setTimeout(() => {
      live.wanted = null
      if (this.live.get(id) === live && live.fanout.starved) this.wantKeyframe(id)
    }, 1_000)
    live.driver.requestKeyframe()
  }

  /** A client sees and operates a device only for the session that holds it. */
  private checkHolder(id: DeviceId, sessionId: string): void {
    if (this.leases.get(id) !== sessionId) {
      throw new DeviceError('forbidden', 'This device is not open in this session')
    }
  }

  /** Stops sending a device to the ports that watched it for the session that let it go. */
  private dropWatchers(id: DeviceId): void {
    for (const port of this.portsOf(id)) {
      this.stopWatching(port, id)
      this.deps.emit(port, { type: 'device.stream', deviceId: id, state: 'stopped' })
    }
  }

  private portsOf(id: DeviceId): string[] {
    return [...this.watching].filter(([, ids]) => ids.has(id)).map(([port]) => port)
  }

  private async stopLive(id: DeviceId): Promise<void> {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    if (live.idle) clearTimeout(live.idle)
    await live.driver
      .stop()
      .catch((error: unknown) => this.deps.log(`Cannot stop a stream: ${String(error)}`))
    for (const port of this.portsOf(id)) {
      this.deps.emit(port, { type: 'device.stream', deviceId: id, state: 'stopped' })
    }
  }
}

function order(device: DeviceInfo): number {
  const platform = device.platform === 'ios' ? 0 : 2
  return platform + (device.kind === 'physical' ? 0 : 1)
}
