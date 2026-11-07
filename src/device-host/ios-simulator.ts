// An iOS simulator through serve-sim (Apache-2.0), run as this host's child on loopback with a
// token of its own: its `stream.avcc` carries the frames, its helper socket the input.

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { Env } from '../agent-host/find-command'
import type {
  DeviceFrame,
  DeviceInput,
  DeviceOrientation,
  DeviceScreen,
  FrameKind,
} from '@shared/device-host'
import { asciiKey, DriverError, hidUsage, type DeviceDriver, type DriverEvents } from './driver'
import { run } from './discovery'
import { framePlan, type FramePlan } from './frame'
import { FRAME_TAG, FrameReader, frameJson, taggedJson } from './framing'
import { freePort, nodeCommand, packageRoot } from './runtime'

const START_TIMEOUT_MS = 60_000
const INPUT_ADMITTED = 0x83
const SCREEN_CONFIG = 0x82
const PASTE = 0x12
const MAX_FRAME_IMAGE_BYTES = 4 * 1024 * 1024
const ORIENT_WAIT_MS = 5_000
const ORIENT_POLL_MS = 100

const KIND_BY_TAG: Record<number, FrameKind> = {
  [FRAME_TAG.description]: 'description',
  [FRAME_TAG.keyframe]: 'key',
  [FRAME_TAG.delta]: 'delta',
  [FRAME_TAG.seed]: 'seed',
}

interface Started {
  url: string
  token: string
}

function serveSimScript(): string {
  return path.join(packageRoot('@expo/serve-sim'), 'dist', 'serve-sim.js')
}

function codecOf(description: Uint8Array): string {
  const hex = (byte: number): string => byte.toString(16).padStart(2, '0')
  return `avc1.${hex(description[1] ?? 0x42)}${hex(description[2] ?? 0xe0)}${hex(description[3] ?? 0x1e)}`
}

export class IosSimulatorDriver implements DeviceDriver {
  private child: ChildProcess | null = null
  private started: Started | null = null
  private events: DriverEvents | null = null
  private video: AbortController | null = null
  private socket: WebSocket | null = null
  private admitted = false
  private stopped = false
  private orientation: DeviceOrientation = 'portrait'
  private size: { width: number; height: number } | null = null
  private codec: string | null = null
  private nextPaste = 1
  private framed: Promise<DeviceFrame | null> | null = null
  /** The frame's pressable buttons, which `frameButton` inputs name. */
  private frameButtons: FramePlan['hid'] = new Map()

  constructor(
    private readonly udid: string,
    private readonly env: Env,
    private readonly log: (message: string) => void,
  ) {}

  async start(events: DriverEvents): Promise<void> {
    this.events = events
    const port = await freePort()
    const node = nodeCommand(this.env as NodeJS.ProcessEnv)
    const child = spawn(
      node.file,
      [
        serveSimScript(),
        this.udid,
        '--require-token',
        '-q',
        '--port',
        String(port),
        '--disable',
        'clipboard',
      ],
      {
        // Kettu's patch of serve-sim: it would otherwise open a Device Hub window for the device.
        env: { ...node.env, SERVE_SIM_DEVICE_HUB: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()))
    child.once('exit', (code) => {
      this.child = null
      if (!this.stopped) this.end(`The simulator stream stopped (exit ${code ?? 'signal'})`)
    })
    this.started = await new Promise<Started>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DriverError('start_timeout', 'The simulator stream did not start')),
        START_TIMEOUT_MS,
      )
      const lines = createInterface({ input: child.stdout! })
      lines.on('line', (line) => {
        const value = (() => {
          try {
            return JSON.parse(line) as Partial<Started>
          } catch {
            return null
          }
        })()
        if (value && typeof value.url === 'string' && typeof value.token === 'string') {
          clearTimeout(timer)
          lines.close()
          resolve({ url: value.url, token: value.token })
        }
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new DriverError('start_failed', 'The simulator stream could not start'))
      })
    })
    this.openInput()
    void this.readVideo()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.video?.abort()
    this.socket?.close()
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }

  requestKeyframe(): void {
    // A new stream starts with a description and a keyframe from the shared encoder.
    if (!this.started || this.stopped) return
    this.video?.abort()
    void this.readVideo()
  }

  send(input: DeviceInput): void {
    switch (input.type) {
      case 'touch': {
        const type = input.phase
        this.post(taggedJson(FRAME_TAG.touch, { type, ...this.rawPoint(input.x, input.y) }))
        break
      }
      case 'scroll': {
        // The simulator has no scroll events: a short drag in the opposite direction.
        const from = this.rawPoint(input.x, input.y)
        const to = this.rawPoint(
          Math.min(1, Math.max(0, input.x - input.dx * 0.002)),
          Math.min(1, Math.max(0, input.y - input.dy * 0.002)),
        )
        this.post(taggedJson(FRAME_TAG.touch, { type: 'begin', ...from }))
        this.post(taggedJson(FRAME_TAG.touch, { type: 'move', ...to }))
        this.post(taggedJson(FRAME_TAG.touch, { type: 'end', ...to }))
        break
      }
      case 'key': {
        const usage = hidUsage(input.code)
        if (usage !== null) this.post(taggedJson(FRAME_TAG.key, { type: input.phase, usage }))
        break
      }
      case 'text':
        this.typeText(input.text)
        break
      case 'button':
        if (input.button === 'rotate') this.rotate()
        else if (input.button === 'home')
          this.post(taggedJson(FRAME_TAG.button, { button: 'home' }))
        else if (input.button === 'lock')
          this.post(taggedJson(FRAME_TAG.button, { button: 'lock' }))
        else if (input.button === 'recents')
          this.post(taggedJson(FRAME_TAG.button, { button: 'app_switcher' }))
        break
      case 'frameButton': {
        const hid = this.frameButtons.get(input.name)
        if (hid) {
          const press = { button: input.name, ...hid, phase: input.phase }
          this.post(taggedJson(FRAME_TAG.button, press))
        }
        break
      }
    }
  }

  async screenshot(): Promise<Uint8Array> {
    const started = this.started
    if (!started) throw new DriverError('not_started', 'The simulator stream has not started')
    const response = await fetch(`${started.url}/api/screenshot`, {
      method: 'POST',
      headers: { authorization: `Bearer ${started.token}` },
    })
    if (!response.ok) throw new DriverError('screenshot', `Screenshot failed (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  }

  frame(): Promise<DeviceFrame | null> {
    // A failed read is tried again by the next client rather than kept.
    this.framed ??= this.loadFrame().catch((error: unknown) => {
      this.log(`Simulator frame unavailable: ${String(error)}`)
      this.framed = null
      return null
    })
    return this.framed
  }

  private async loadFrame(): Promise<DeviceFrame | null> {
    const started = this.started
    if (!started) return null
    const headers = { authorization: `Bearer ${started.token}` }
    const response = await fetch(`${started.url}/api`, { headers })
    if (!response.ok) throw new Error(`/api answered ${response.status}`)
    const plan = framePlan(((await response.json()) as { chrome?: unknown }).chrome)
    if (!plan) return null
    const pictures = new Map<string, Promise<ArrayBuffer>>()
    const picture = (image: string): Promise<ArrayBuffer> => {
      const query = `chrome=${encodeURIComponent(plan.chrome)}&image=${encodeURIComponent(image)}&v=2`
      let loading = pictures.get(image)
      if (!loading) {
        loading = fetch(`${started.url}/grid/api/devicekit-chrome?${query}`, { headers }).then(
          async (answer) => {
            if (!answer.ok) throw new Error(`${image} answered ${answer.status}`)
            const png = await answer.arrayBuffer()
            if (png.byteLength > MAX_FRAME_IMAGE_BYTES) throw new Error(`${image} is too large`)
            return png
          },
        )
        pictures.set(image, loading)
      }
      return loading
    }
    const images = await Promise.all(
      plan.images.map(async ({ image, button, ...area }) => ({
        ...area,
        png: await picture(image),
        ...(button && {
          button: {
            name: button.name,
            hover: button.hover,
            // Without its pressed picture the button still presses; clients brighten it.
            down: button.down ? await picture(button.down).catch(() => null) : null,
          },
        }),
      })),
    )
    this.frameButtons = plan.hid
    return {
      width: plan.width,
      height: plan.height,
      screen: plan.screen,
      radii: plan.radii,
      images,
    }
  }

  /** serve-sim takes points in the framebuffer's own orientation, which stays portrait. */
  private rawPoint(x: number, y: number): { x: number; y: number } {
    const size = this.size
    if (!size || size.width > size.height) return { x, y }
    switch (this.orientation) {
      case 'landscape_left':
        return { x: y, y: 1 - x }
      case 'landscape_right':
        return { x: 1 - y, y: x }
      case 'portrait_upside_down':
        return { x: 1 - x, y: 1 - y }
      default:
        return { x, y }
    }
  }

  async orient(orientation: DeviceOrientation): Promise<boolean> {
    if (!this.admitted) return false
    this.post(taggedJson(FRAME_TAG.orientation, { orientation }))
    // serve-sim sends a screen configuration once the device has turned.
    for (let waited = 0; this.orientation !== orientation && waited < ORIENT_WAIT_MS;) {
      await new Promise((resolve) => setTimeout(resolve, ORIENT_POLL_MS))
      waited += ORIENT_POLL_MS
    }
    return this.orientation === orientation
  }

  private rotate(): void {
    const order: DeviceOrientation[] = [
      'portrait',
      'landscape_left',
      'portrait_upside_down',
      'landscape_right',
    ]
    const next = order[(order.indexOf(this.orientation) + 1) % order.length]!
    this.post(taggedJson(FRAME_TAG.orientation, { orientation: next }))
  }

  /** ASCII goes as keys; anything else through serve-sim's paste, which writes the pasteboard and presses Command+V. */
  private typeText(text: string): void {
    const keys = [...text].map(asciiKey)
    if (keys.every((key) => key !== null)) {
      for (const key of keys) {
        if (key!.shift) this.post(taggedJson(FRAME_TAG.key, { type: 'down', usage: 0xe1 }))
        this.post(taggedJson(FRAME_TAG.key, { type: 'down', usage: key!.usage }))
        this.post(taggedJson(FRAME_TAG.key, { type: 'up', usage: key!.usage }))
        if (key!.shift) this.post(taggedJson(FRAME_TAG.key, { type: 'up', usage: 0xe1 }))
      }
      return
    }
    this.post(taggedJson(PASTE, { requestId: this.nextPaste++, text }))
  }

  private post(message: Uint8Array<ArrayBuffer>): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.admitted) this.socket.send(message)
  }

  private openInput(): void {
    const started = this.started
    if (!started || this.stopped) return
    const url = `${started.url.replace(/^http/, 'ws')}/helper/${this.udid}/ws`
    const socket = new WebSocket(url, [`serve-sim.token.${started.token}`])
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.admitted = false
    socket.onmessage = (event) => {
      const bytes = new Uint8Array(event.data as ArrayBuffer)
      if (bytes[0] === INPUT_ADMITTED) {
        this.admitted = true
        this.events?.input(true)
        return
      }
      if (bytes[0] !== SCREEN_CONFIG) return
      const config = frameJson(bytes.subarray(1)) as {
        width?: number
        height?: number
        orientation?: DeviceOrientation
        inputUnavailable?: boolean
      } | null
      if (!config || !config.width || !config.height) return
      this.size = { width: config.width, height: config.height }
      this.orientation = config.orientation ?? 'portrait'
      if (config.inputUnavailable) this.events?.input(false)
      this.emitScreen()
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.events?.input(false)
      if (!this.stopped) setTimeout(() => this.openInput(), 1_000)
    }
  }

  private emitScreen(): void {
    if (!this.size || !this.codec) return
    const screen: DeviceScreen = { ...this.size, orientation: this.orientation, codec: this.codec }
    this.events?.screen(screen)
  }

  private async readVideo(): Promise<void> {
    const started = this.started
    if (!started) return
    const controller = new AbortController()
    this.video = controller
    try {
      const response = await fetch(`${started.url}/helper/${this.udid}/stream.avcc`, {
        headers: { authorization: `Bearer ${started.token}` },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`stream.avcc answered ${response.status}`)
      const reader = new FrameReader()
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        for (const frame of reader.push(chunk)) {
          const kind = KIND_BY_TAG[frame.tag]
          if (!kind) continue
          if (kind === 'description') {
            this.codec = codecOf(frame.payload)
            this.emitScreen()
          }
          this.events?.frame(kind, frame.payload)
        }
      }
      if (!controller.signal.aborted && !this.stopped) setTimeout(() => this.requestKeyframe(), 500)
    } catch (error) {
      if (controller.signal.aborted || this.stopped) return
      this.log(`Simulator video stopped: ${String(error)}`)
      setTimeout(() => this.requestKeyframe(), 1_000)
    }
  }

  private end(error: string | null): void {
    this.video?.abort()
    this.socket?.close()
    this.events?.ended(error)
  }
}

export async function bootSimulator(xcrun: string, udid: string, env: Env): Promise<void> {
  await run(xcrun, ['simctl', 'boot', udid], env, 120_000).catch((error: { stderr?: string }) => {
    // Booting a booted device fails with this; it is what we want.
    if (!/current state: Booted/i.test(error.stderr ?? '')) throw error
  })
  await run(xcrun, ['simctl', 'bootstatus', udid, '-b'], env, 180_000)
}

export async function shutdownSimulator(xcrun: string, udid: string, env: Env): Promise<void> {
  await run(xcrun, ['simctl', 'shutdown', udid], env, 60_000).catch(() => undefined)
}
