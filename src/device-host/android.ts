// An Android emulator or phone through scrcpy's server, pushed over adb and reached through a
// forward tunnel: one socket for H.264, one for control.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { Env } from '../agent-host/find-command'
import type { DeviceInput, DeviceScreen } from '@shared/device-host'
import { AnnexBToAvcc } from './annexb'
import { parseAdbDevices, run } from './discovery'
import { DriverError, type DeviceDriver, type DriverEvents } from './driver'
import { freePort, helperPath } from './runtime'
import {
  ANDROID_KEYCODE,
  backMessage,
  clipboardMessage,
  keycodeMessage,
  resetVideoMessage,
  rotateMessage,
  SCRCPY_CODEC_H264,
  SCRCPY_VERSION,
  ScrcpyVideoReader,
  scrollMessage,
  textChunks,
  textMessage,
  touchMessage,
  type ScreenPoint,
} from './scrcpy'

const DEVICE_PATH = '/data/local/tmp/kettu-scrcpy-server.jar'
const CONNECT_TIMEOUT_MS = 15_000

const KEYCODE_BY_CODE: Record<string, number> = {
  Enter: ANDROID_KEYCODE.enter,
  NumpadEnter: ANDROID_KEYCODE.enter,
  Backspace: ANDROID_KEYCODE.del,
  Delete: ANDROID_KEYCODE.forwardDel,
  Tab: ANDROID_KEYCODE.tab,
  Escape: ANDROID_KEYCODE.back,
  ArrowUp: ANDROID_KEYCODE.dpadUp,
  ArrowDown: ANDROID_KEYCODE.dpadDown,
  ArrowLeft: ANDROID_KEYCODE.dpadLeft,
  ArrowRight: ANDROID_KEYCODE.dpadRight,
  Home: ANDROID_KEYCODE.moveHome,
  End: ANDROID_KEYCODE.moveEnd,
  PageUp: ANDROID_KEYCODE.pageUp,
  PageDown: ANDROID_KEYCODE.pageDown,
  Space: ANDROID_KEYCODE.space,
}

const BUTTON_KEYCODE: Partial<Record<string, number>> = {
  home: ANDROID_KEYCODE.home,
  recents: ANDROID_KEYCODE.appSwitch,
  lock: ANDROID_KEYCODE.power,
  volumeUp: ANDROID_KEYCODE.volumeUp,
  volumeDown: ANDROID_KEYCODE.volumeDown,
}

function connectOnce(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

export class AndroidDriver implements DeviceDriver {
  private server: ChildProcess | null = null
  private video: Socket | null = null
  private control: Socket | null = null
  private port = 0
  private events: DriverEvents | null = null
  private size: { width: number; height: number } | null = null
  private codec: string | null = null
  private stopped = false
  private clipboardSequence = 1

  constructor(
    private readonly serial: string,
    private readonly adb: string,
    private readonly resourcesPath: string | null,
    private readonly env: Env,
    private readonly log: (message: string) => void,
  ) {}

  async start(events: DriverEvents): Promise<void> {
    this.events = events
    const jar = await helperPath('scrcpy-server', this.resourcesPath)
    if (!jar) throw new DriverError('helper_missing', 'scrcpy-server is not installed with Kettu')
    await run(this.adb, ['-s', this.serial, 'push', jar, DEVICE_PATH], this.env, 60_000)
    const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, '0')
    this.port = await freePort()
    await run(
      this.adb,
      ['-s', this.serial, 'forward', `tcp:${this.port}`, `localabstract:scrcpy_${scid}`],
      this.env,
    )
    const server = spawn(
      this.adb,
      [
        '-s',
        this.serial,
        'shell',
        `CLASSPATH=${DEVICE_PATH}`,
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        SCRCPY_VERSION,
        `scid=${scid}`,
        'log_level=info',
        'tunnel_forward=true',
        'audio=false',
        'control=true',
        'video_codec=h264',
        'max_size=1920',
        'video_bit_rate=8000000',
        'max_fps=60',
        'cleanup=true',
        'clipboard_autosync=false',
      ],
      { env: this.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    this.server = server
    server.stdout?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()))
    server.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()))
    server.once('exit', (code) => {
      this.server = null
      if (!this.stopped) this.end(`The Android stream stopped (exit ${code ?? 'signal'})`)
    })
    this.video = await this.connectVideo()
    this.control = await connectOnce(this.port)
    this.control.on('error', (error) => this.log(`Control socket: ${error.message}`))
    // Device messages (clipboard, acknowledgements) are not used.
    this.control.on('data', () => undefined)
    events.input(true)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.video?.destroy()
    this.control?.destroy()
    this.server?.kill('SIGTERM')
    if (this.port) {
      await run(
        this.adb,
        ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`],
        this.env,
      ).catch(() => undefined)
    }
  }

  requestKeyframe(): void {
    this.write(resetVideoMessage())
  }

  send(input: DeviceInput): void {
    const size = this.size
    switch (input.type) {
      case 'touch': {
        if (!size) return
        const action = input.phase === 'begin' ? 'down' : input.phase === 'move' ? 'move' : 'up'
        this.write(touchMessage(action, input.finger ?? 0, this.point(input.x, input.y, size)))
        break
      }
      case 'scroll': {
        if (!size) return
        const notches = (delta: number): number => Math.max(-16, Math.min(16, -delta / 40))
        this.write(
          scrollMessage(this.point(input.x, input.y, size), notches(input.dx), notches(input.dy)),
        )
        break
      }
      case 'key': {
        const keycode = KEYCODE_BY_CODE[input.code]
        if (keycode !== undefined) this.write(keycodeMessage(input.phase, keycode))
        break
      }
      case 'text':
        // Injected text goes through the keyboard's character map, which has no CJK; those paste.
        if (/^[\x20-\x7e\n]*$/.test(input.text)) {
          for (const chunk of textChunks(input.text)) this.write(textMessage(chunk))
        } else {
          this.write(clipboardMessage(this.clipboardSequence++, input.text, true))
        }
        break
      case 'button':
        if (input.button === 'rotate') this.write(rotateMessage())
        else if (input.button === 'back') {
          this.write(backMessage('down'))
          this.write(backMessage('up'))
        } else {
          const keycode = BUTTON_KEYCODE[input.button]
          if (keycode === undefined) break
          this.write(keycodeMessage('down', keycode))
          this.write(keycodeMessage('up', keycode))
        }
        break
    }
  }

  screenshot(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      execFile(
        this.adb,
        ['-s', this.serial, 'exec-out', 'screencap', '-p'],
        { env: this.env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
        (error, stdout) => (error ? reject(error) : resolve(new Uint8Array(stdout))),
      )
    })
  }

  private point(x: number, y: number, size: { width: number; height: number }): ScreenPoint {
    return { x: x * size.width, y: y * size.height, width: size.width, height: size.height }
  }

  private write(message: Uint8Array): void {
    if (this.control && !this.control.destroyed) this.control.write(message)
  }

  /** The forward tunnel accepts before the server listens; its dummy byte says it does. */
  private async connectVideo(): Promise<Socket> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    for (;;) {
      if (this.stopped) throw new DriverError('stopped', 'Stopped')
      try {
        const socket = await connectOnce(this.port)
        const reader = new ScrcpyVideoReader()
        const converter = new AnnexBToAvcc()
        const ready = await new Promise<boolean>((resolve) => {
          let first = true
          socket.on('data', (chunk: Buffer) => {
            if (first) {
              first = false
              resolve(true)
            }
            this.onVideo(reader.push(new Uint8Array(chunk)), converter)
          })
          socket.once('close', () => {
            if (first) resolve(false)
            else if (!this.stopped) this.end('The Android video stopped')
          })
          socket.once('error', () => undefined)
        })
        if (ready) return socket
        socket.destroy()
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline)
        throw new DriverError('connect', 'The Android stream did not start')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  private onVideo(events: ReturnType<ScrcpyVideoReader['push']>, converter: AnnexBToAvcc): void {
    for (const event of events) {
      if (event.type === 'codec' && event.codec !== SCRCPY_CODEC_H264) {
        this.end('The device does not encode H.264')
      } else if (event.type === 'disabled') {
        this.end(
          event.error ? 'The device could not start its encoder' : 'The device disabled video',
        )
      } else if (event.type === 'session') {
        this.size = { width: event.width, height: event.height }
        converter.reset()
        this.emitScreen()
      } else if (event.type === 'packet') {
        const unit = converter.push(event.data)
        if (unit.description) {
          this.codec = unit.description.codec
          this.events?.frame('description', unit.description.config)
          this.emitScreen()
        }
        if (!event.config && unit.data.length > 0) {
          this.events?.frame(unit.key || event.key ? 'key' : 'delta', unit.data)
        }
      }
    }
  }

  private emitScreen(): void {
    if (!this.size || !this.codec) return
    const screen: DeviceScreen = {
      ...this.size,
      orientation: this.size.width > this.size.height ? 'landscape_left' : 'portrait',
      codec: this.codec,
    }
    this.events?.screen(screen)
  }

  private end(error: string | null): void {
    if (this.stopped) return
    this.stopped = true
    this.video?.destroy()
    this.control?.destroy()
    this.server?.kill('SIGTERM')
    this.events?.ended(error)
  }
}

/** Starts an AVD without a window of its own, and resolves with its serial once it has booted. */
export async function bootEmulator(
  emulator: string,
  adb: string,
  avd: string,
  env: Env,
): Promise<string> {
  const before = new Set(parseAdbDevices(await run(adb, ['devices'], env)).map((row) => row.serial))
  const child = spawn(
    emulator,
    ['-avd', avd, '-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'host'],
    {
      env: env as NodeJS.ProcessEnv,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    },
  )
  child.unref()
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const rows = parseAdbDevices(await run(adb, ['devices'], env).catch(() => ''))
    for (const row of rows) {
      if (before.has(row.serial) || !row.serial.startsWith('emulator-') || row.state !== 'device')
        continue
      const booted = await run(
        adb,
        ['-s', row.serial, 'shell', 'getprop sys.boot_completed'],
        env,
        5_000,
      ).catch(() => '')
      if (booted.trim() === '1') return row.serial
    }
  }
  throw new Error('The emulator did not finish booting')
}
