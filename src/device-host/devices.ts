// The devices of this host: what the tools list, which session holds each, who uses it in a turn,
// and the stream of each device someone watches.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Env } from '../agent-host/find-command'
import { t } from '@shared/hosts-text'
import {
  SurfaceControls,
  type ControlPoint,
  type ControlWaitOptions,
  type SurfaceControl,
} from '@shared/control'
import {
  SESSION_DEVICE_LIMIT,
  type DeviceAppearance,
  type DeviceEnvironment,
  type DeviceEvent,
  type DeviceFrame,
  type DeviceId,
  type DeviceInfo,
  type DeviceInput,
  type DeviceOperator,
  type DeviceOrientation,
  type DeviceProblem,
  type DeviceScreen,
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
import {
  bootSimulator,
  IosSimulatorDriver,
  shutdownSimulator,
  waitUntilBooted,
} from './ios-simulator'
import { FrameFanout } from './stream'

/** A device nobody watches keeps capturing this long, for a pane that comes straight back. */
const IDLE_CAPTURE_MS = 30_000
const LIST_EVERY_MS = 5_000

/** Why a command failed, without the `Error: ` an error object's string starts with. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
  /** The user handed a device back to the turn of `sessionId` after holding it for `durationMs`. */
  handedBack?(sessionId: string, durationMs: number): void
  log(message: string): void
}

/** The turn that uses a device: its session and its agent's name. */
interface DeviceTurn {
  sessionId: string
  agentName: string
}

export class DeviceManager {
  private tools: Tools | null = null
  private found = new Map<DeviceId, FoundDevice>()
  private readonly leases = new Map<DeviceId, string>()
  /**
   * Simulators and emulators this host booted, which shut down once no session holds them, each
   * with the id it is listed under while shut down: a simulator's own, an emulator's AVD.
   */
  private readonly booted = new Map<DeviceId, DeviceId>()
  /** Devices this host is booting, which a listing from before the boot must not forget. */
  private readonly booting = new Set<DeviceId>()
  /**
   * The boots under way, by the id a device is listed under while shut down, which a second open
   * of the same device waits on; each gives the id the device is listed under once up.
   */
  private readonly boots = new Map<DeviceId, Promise<DeviceId>>()
  /** Simulators listed as booting until their boot is up, which simctl calls Booted before. */
  private readonly unbooted = new Set<DeviceId>()
  /** Who uses each device a turn uses, by its id. */
  private readonly controls: SurfaceControls
  private readonly turns = new Map<DeviceId, DeviceTurn>()
  private readonly live = new Map<DeviceId, Live>()
  private readonly ensuring = new Map<DeviceId, Promise<Live>>()
  /** The devices each port watches. */
  private readonly watching = new Map<string, Set<DeviceId>>()
  private listing: Promise<DeviceInfo[]> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private lastList = ''
  private saving: Promise<void> = Promise.resolve()

  private readonly restored: Promise<void>

  constructor(private readonly deps: DeviceManagerDeps) {
    this.restored = this.restoreLeases()
    this.controls = new SurfaceControls({
      changed: (id, state) => {
        if (state.kind === 'idle') this.turns.delete(id)
        this.broadcastList()
      },
      handedBack: (id, durationMs) => {
        const turn = this.turns.get(id)
        if (turn) deps.handedBack?.(turn.sessionId, durationMs)
      },
    })
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
      const parsed = JSON.parse(text) as {
        leases?: Record<string, unknown>
        booted?: Record<string, unknown>
      }
      for (const [id, sessionId] of Object.entries(parsed.leases ?? {})) {
        if (typeof sessionId === 'string' && sessionId.length <= 256) this.leases.set(id, sessionId)
      }
      for (const [id, down] of Object.entries(parsed.booted ?? {})) {
        if (id.length <= 256 && typeof down === 'string' && down.length <= 256) {
          this.booted.set(id, down)
        }
      }
    } catch {
      this.deps.log('Ignored an unreadable device-leases.json')
    }
  }

  /**
   * Which session holds which device, so a pane shows its devices again after a restart, and
   * which devices this host booted.
   */
  private saveLeases(): void {
    const file = this.leasesFile()
    if (!file) return
    const body = JSON.stringify({
      leases: Object.fromEntries(this.leases),
      booted: Object.fromEntries(this.booted),
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
    if (!found) throw new DeviceError('not_found', t('devices.noSuchDevice'))
    const holder = this.leases.get(id)
    if (holder && holder !== sessionId) {
      throw new DeviceError('busy', t('devices.busyOther'), { sessionId: holder })
    }
    this.checkRoom(id, sessionId)
    this.leases.set(id, sessionId)
    this.saveLeases()
    const tools = await this.loadTools()
    const env = await this.deps.env()
    if (found.kind === 'simulator' && found.state !== 'booted' && tools.xcrun) {
      this.setState(id, 'booting')
      try {
        await this.bootSimulatorOnce(id, tools.xcrun, found.target, env)
      } catch (error) {
        this.setState(id, 'shutdown')
        throw new DeviceError(
          'unavailable',
          t('devices.simulatorBoot', { reason: reasonOf(error) }),
        )
      }
      if (this.leases.get(id) !== sessionId) {
        throw new DeviceError('unavailable', t('devices.closedWhileStarting'), {
          reason: 'closed',
        })
      }
    } else if (found.kind === 'emulator' && (found.state === 'shutdown' || this.boots.has(id))) {
      if (!tools.emulator || !tools.adb)
        throw new DeviceError('unavailable', t('devices.emulatorMissing'))
      this.setState(id, 'booting')
      const avd = id
      id = await this.bootEmulatorOnce(avd, tools.emulator, tools.adb, found.target, env).catch(
        (error: unknown) => {
          this.setState(avd, 'shutdown')
          throw new DeviceError(
            'unavailable',
            t('devices.emulatorStart', { reason: reasonOf(error) }),
          )
        },
      )
      if (this.leases.get(id) !== sessionId) {
        throw new DeviceError('unavailable', t('devices.closedWhileStarting'), {
          reason: 'closed',
        })
      }
    } else {
      await this.list()
    }
    const info = this.info(id)
    if (!info) throw new DeviceError('not_found', t('devices.wentAway'))
    return info
  }

  /** Runs a device's boot once however many open it meanwhile. */
  private bootOnce(id: DeviceId, boot: () => Promise<DeviceId>): Promise<DeviceId> {
    let running = this.boots.get(id)
    if (!running) {
      this.booting.add(id)
      running = boot().finally(() => {
        this.booting.delete(id)
        this.boots.delete(id)
      })
      this.boots.set(id, running)
    }
    return running
  }

  /**
   * Boots a simulator. It is this host's once `simctl boot` started it, even if the wait for it
   * fails; if no session holds it when the boot ends, its tab closed or its session ended
   * meanwhile, it shuts down again.
   */
  private bootSimulatorOnce(
    id: DeviceId,
    xcrun: string,
    udid: string,
    env: Env,
  ): Promise<DeviceId> {
    return this.bootOnce(id, async () => {
      let ours = false
      this.unbooted.add(id)
      try {
        ours = await bootSimulator(xcrun, udid, env)
        await waitUntilBooted(xcrun, udid, env)
      } finally {
        this.unbooted.delete(id)
        if (ours && this.leases.has(id)) {
          this.booted.set(id, id)
          this.saveLeases()
        } else if (ours) {
          await shutdownSimulator(xcrun, udid, env)
        }
      }
      // Waits for a listing that began before the boot, too, while it cannot forget the boot.
      await this.list()
      return id
    })
  }

  /**
   * Starts an emulator from its AVD; it is listed by its serial once up, so the AVD's lease moves
   * there. If no session holds the AVD when the boot ends, its tab closed or its session ended
   * meanwhile, the emulator is shut down again.
   */
  private bootEmulatorOnce(
    avd: DeviceId,
    emulator: string,
    adb: string,
    name: string,
    env: Env,
  ): Promise<DeviceId> {
    return this.bootOnce(avd, async () => {
      const serial = await bootEmulator(emulator, adb, name, env)
      const id: DeviceId = `android:${serial}`
      const holder = this.leases.get(avd)
      if (holder) {
        this.leases.delete(avd)
        this.leases.set(id, holder)
        this.booted.set(id, avd)
        this.saveLeases()
      } else {
        await run(adb, ['-s', serial, 'emu', 'kill'], env).catch(() => undefined)
      }
      this.booting.add(id)
      try {
        await this.list()
      } finally {
        this.booting.delete(id)
      }
      return id
    })
  }

  /**
   * Gives a device another session holds to this one. It stays as it is: its stream runs on, and
   * one this host booted shuts down only when its new session lets it go.
   */
  async move(id: DeviceId, sessionId: string): Promise<DeviceInfo> {
    await this.restored
    const holder = this.leases.get(id)
    if (!holder) return this.open(id, sessionId)
    if (holder !== sessionId) {
      this.checkRoom(id, sessionId)
      this.controls.forget(id)
      this.dropWatchers(id)
      this.leases.set(id, sessionId)
      this.saveLeases()
      this.broadcastList()
    }
    const info = this.info(id)
    if (!info) throw new DeviceError('not_found', t('devices.wentAway'))
    return info
  }

  /** A session holds only so many devices at a time. */
  private checkRoom(id: DeviceId, sessionId: string): void {
    if (this.leases.get(id) === sessionId) return
    let held = 0
    for (const holder of this.leases.values()) if (holder === sessionId) held += 1
    if (held >= SESSION_DEVICE_LIMIT) {
      throw new DeviceError('busy', t('devices.roomLimit', { limit: SESSION_DEVICE_LIMIT }), {
        limit: SESSION_DEVICE_LIMIT,
      })
    }
  }

  /** Takes the device from the session; one this host booted shuts down with it. */
  async close(id: DeviceId, sessionId: string, shutdown: boolean): Promise<void> {
    await this.restored
    if (this.leases.get(id) !== sessionId) return
    this.leases.delete(id)
    const booted = this.booted.delete(id)
    this.saveLeases()
    this.controls.forget(id)
    this.dropWatchers(id)
    await this.stopLive(id)
    if (shutdown || booted) await this.shutDown(id)
    await this.list()
  }

  /**
   * Shuts a simulator or emulator down for the session that holds it, which keeps it. An emulator
   * is then listed by its AVD, so the lease moves there; one whose AVD is unknown is let go.
   */
  async shutdown(id: DeviceId, sessionId: string): Promise<void> {
    await this.restored
    this.checkHolder(id, sessionId)
    const found = this.found.get(id)
    if (found && found.kind === 'physical') {
      throw new DeviceError('unavailable', t('devices.shutdownPhysical'))
    }
    const down = found?.kind === 'emulator' ? (this.booted.get(id) ?? null) : id
    this.booted.delete(id)
    this.controls.forget(id)
    this.dropWatchers(id)
    if (down !== id) {
      this.leases.delete(id)
      if (down) this.leases.set(down, sessionId)
    }
    this.saveLeases()
    await this.stopLive(id)
    await this.shutDown(id)
    await this.list()
  }

  /**
   * Lets go of the devices of sessions that were archived or deleted. Only the simulators and
   * emulators this host booted shut down; others stay on, since the user may still be using them.
   */
  async endSessions(sessionIds: string[]): Promise<void> {
    await this.restored
    const ended = new Set(sessionIds)
    const booted: DeviceId[] = []
    for (const [id, sessionId] of [...this.leases]) {
      if (!ended.has(sessionId)) continue
      this.leases.delete(id)
      this.controls.forget(id)
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
    if (!found) throw new DeviceError('not_found', t('devices.noSuchDevice'))
    // Watching from here, so an unwatch or a closed port while the stream starts is not undone.
    let set = this.watching.get(port)
    if (!set) this.watching.set(port, (set = new Set()))
    set.add(id)
    let live: Live
    try {
      live = await this.ensureLive(found)
    } catch (error) {
      this.watching.get(port)?.delete(id)
      throw error
    }
    // The session may have let go of the device while its stream started.
    this.checkHolder(id, sessionId)
    if (!this.watching.get(port)?.has(id)) {
      this.idleIfUnwatched(id, live)
      return { screen: live.screen }
    }
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
    this.idleIfUnwatched(id, live)
  }

  private idleIfUnwatched(id: DeviceId, live: Live): void {
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

  /**
   * The user's input to the device, held back while a turn uses it unless it is scrolling; only
   * Take over gives the user the device then. False when it was held back.
   */
  input(id: DeviceId, input: DeviceInput, sessionId: string): boolean {
    this.checkHolder(id, sessionId)
    const live = this.live.get(id)
    if (!live) throw new DeviceError('unavailable', t('devices.notStreaming'))
    if (this.controls.holdsInput(id) && input.type !== 'scroll') return false
    live.driver.send(input)
    return true
  }

  async screenshot(id: DeviceId, sessionId: string): Promise<Uint8Array> {
    await this.restored
    this.checkHolder(id, sessionId)
    const found = this.found.get(id)
    if (!found) throw new DeviceError('not_found', t('devices.noSuchDevice'))
    const live = await this.ensureLive(found)
    try {
      return await live.driver.screenshot()
    } finally {
      this.idleIfUnwatched(found.id, live)
    }
  }

  /** Light or dark as the device is set now; null where the host has no way to tell. */
  async appearance(id: DeviceId, sessionId: string): Promise<DeviceAppearance | null> {
    await this.restored
    this.checkHolder(id, sessionId)
    const found = this.found.get(id)
    if (!found || (found.state !== 'booted' && found.state !== 'connected')) return null
    const tools = await this.loadTools()
    const env = await this.deps.env()
    if (found.kind === 'simulator' && tools.xcrun) {
      const out = await run(tools.xcrun, ['simctl', 'ui', found.target, 'appearance'], env)
      const mode = out.trim()
      return mode === 'light' || mode === 'dark' ? mode : null
    }
    if (found.platform === 'android' && tools.adb) {
      const out = await run(tools.adb, ['-s', found.target, 'shell', 'cmd', 'uimode', 'night'], env)
      const mode = /Night mode: (yes|no)/.exec(out)?.[1]
      return mode === 'yes' ? 'dark' : mode === 'no' ? 'light' : null
    }
    return null
  }

  async setAppearance(
    id: DeviceId,
    sessionId: string,
    appearance: DeviceAppearance,
  ): Promise<void> {
    await this.restored
    this.checkHolder(id, sessionId)
    const found = this.found.get(id)
    if (!found) throw new DeviceError('not_found', t('devices.noSuchDevice'))
    const tools = await this.loadTools()
    const env = await this.deps.env()
    if (found.kind === 'simulator' && tools.xcrun) {
      await run(tools.xcrun, ['simctl', 'ui', found.target, 'appearance', appearance], env)
    } else if (found.platform === 'android' && tools.adb) {
      await run(
        tools.adb,
        [
          '-s',
          found.target,
          'shell',
          'cmd',
          'uimode',
          'night',
          appearance === 'dark' ? 'yes' : 'no',
        ],
        env,
      )
    } else {
      throw new DeviceError('unavailable', t('devices.appearanceUnsupported'))
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

  /** Who uses the device now. */
  control(id: DeviceId): SurfaceControl {
    return this.controls.state(id)
  }

  /**
   * An agent's call of `sessionId`'s turn starts on the device, which the turn uses from now until
   * it ends. While the user holds it, the call waits as `wait` says; it settles with the function
   * that ends the call, or throws a ControlWait.
   */
  begin(
    id: DeviceId,
    turn: { sessionId: string; agentName: string },
    wait: ControlWaitOptions,
  ): Promise<() => void> {
    if (this.controls.state(id).kind === 'idle') this.turns.set(id, { ...turn })
    return this.controls.begin(id, wait)
  }

  /**
   * The turn of `sessionId` ended, however it ended, or every turn when null: the devices they used
   * are nobody's now.
   */
  turnEnded(sessionId: string | null): void {
    for (const [id, turn] of [...this.turns]) {
      if (sessionId === null || turn.sessionId === sessionId) this.controls.turnEnded(id)
    }
  }

  /** The user's Take over, from the label, the pill or the bubble; false when no turn has it. */
  takeOver(id: DeviceId, sessionId: string): boolean {
    this.checkHolder(id, sessionId)
    return this.controls.takeOver(id)
  }

  /** The user's Hand back: the turn goes on, and its waiting calls with it. */
  handBack(id: DeviceId, sessionId: string): boolean {
    this.checkHolder(id, sessionId)
    return this.controls.handBack(id)
  }

  /** The agent acted on the device: its watchers draw it, at a point of the screen or on all of it. */
  acted(id: DeviceId, at: ControlPoint | null): void {
    for (const port of this.portsOf(id)) {
      this.deps.emit(port, { type: 'device.act', deviceId: id, at })
    }
  }

  /**
   * Where a point the agent named in the device's own points lies on its screen as shown, from 0
   * to 1; null when the host cannot tell the device's size in points.
   */
  async pointOnScreen(id: DeviceId, x: number, y: number): Promise<ControlPoint | null> {
    const live = this.live.get(id)
    const found = this.found.get(id)
    if (!live?.screen || !found) return null
    const { width, height } = live.screen
    const sideways = live.screen.orientation.startsWith('landscape')
    let scale: number | null = null
    // Android's tools speak the screen's own pixels; an iOS simulator's frame its points.
    if (found.platform === 'android') scale = 1
    else {
      const frame = await live.driver.frame?.().catch(() => null)
      const portraitWidth = Math.min(width, height)
      if (frame && frame.screen.width > 0) scale = portraitWidth / frame.screen.width
    }
    if (!scale) return null
    // The picture of a simulator stays portrait when it turns; the agent's points follow the turn.
    const shownWidth = (sideways ? Math.max(width, height) : Math.min(width, height)) / scale
    const shownHeight = (sideways ? Math.min(width, height) : Math.max(width, height)) / scale
    const fx = x / shownWidth
    const fy = y / shownHeight
    return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { x: fx, y: fy } : null
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
    for (const device of lists.flat()) {
      next.set(device.id, this.unbooted.has(device.id) ? { ...device, state: 'booting' } : device)
    }
    this.found = next
    // One that went down is no longer ours: started again by the user, it stays on. An emulator
    // is down once its AVD is listed and its serial is not; adb lists an offline one as both.
    let forgot = false
    for (const [id, down] of this.booted) {
      const shutDown = next.get(down)?.state === 'shutdown' && (down === id || !next.has(id))
      if (shutDown && !this.booting.has(id)) {
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
      operator: this.operatorOf(found.id),
      problems: found.problems,
      input: live?.input ?? false,
      bootedByHost: this.booted.has(found.id),
    }
  }

  private operatorOf(id: DeviceId): DeviceOperator | null {
    const control = this.controls.state(id)
    const turn = this.turns.get(id)
    if (control.kind === 'idle' || !turn) return null
    return {
      sessionId: turn.sessionId,
      agentName: turn.agentName,
      user: control.kind === 'you',
      control,
    }
  }

  private createDriver(found: FoundDevice, tools: Tools, env: Env): DeviceDriver {
    const log = (message: string): void => this.deps.log(`[${found.name}] ${message}`)
    if (found.platform === 'ios' && found.kind === 'simulator') {
      if (!tools.xcrun) throw new DeviceError('unavailable', t('devices.noXcode'))
      if (process.arch !== 'arm64') {
        throw new DeviceError('unavailable', t('devices.needsAppleSilicon'))
      }
      return new IosSimulatorDriver(found.target, env, log)
    }
    if (found.platform === 'ios') {
      return new IosDeviceDriver(found.target, found.osVersion, this.deps.resourcesPath, env, log)
    }
    if (!tools.adb) throw new DeviceError('unavailable', t('devices.noAdb'))
    return new AndroidDriver(found.target, tools.adb, this.deps.resourcesPath, env, log)
  }

  /** The device's stream, started once however many ask for it at the same time. */
  private ensureLive(found: FoundDevice): Promise<Live> {
    let pending = this.ensuring.get(found.id)
    if (!pending) {
      pending = this.startLive(found).finally(() => this.ensuring.delete(found.id))
      this.ensuring.set(found.id, pending)
    }
    return pending
  }

  private async startLive(found: FoundDevice): Promise<Live> {
    const existing = this.live.get(found.id)
    if (existing) {
      await existing.starting
      return existing
    }
    if (found.state === 'shutdown' || found.state === 'booting') {
      throw new DeviceError('unavailable', t('devices.notRunning'))
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
      throw new DeviceError('forbidden', t('devices.notOpenHere'))
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
