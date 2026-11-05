// An iOS simulator through serve-sim (Apache-2.0), run as this host's child on loopback with a
// token of its own: its `stream.avcc` carries the frames, its helper socket the input.

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Env } from '../agent-host/find-command'
import type { DeviceInput, DeviceOrientation, DeviceScreen, FrameKind } from '@shared/device-host'
import { asciiKey, DriverError, hidUsage, type DeviceDriver, type DriverEvents } from './driver'
import { run } from './discovery'
import { FRAME_TAG, FrameReader, frameJson, taggedJson } from './framing'
import { freePort, nodeCommand, packageRoot } from './runtime'

const START_TIMEOUT_MS = 60_000
const INPUT_ADMITTED = 0x83
const SCREEN_CONFIG = 0x82
const PASTE = 0x12

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
  // `./middleware` resolves to `dist/middleware.cjs` for require; the CLI sits beside it.
  return `${packageRoot('@expo/serve-sim', 'middleware', 0)}/serve-sim.js`
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
      { env: node.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
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
