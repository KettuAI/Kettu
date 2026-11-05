// A physical iPhone or iPad through one of Kettu's helpers: on iOS 27 and later the device's own
// display and HID services, before that USB screen capture with input left to the agent's runner.
// Both speak the tagged framing over stdio.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Env } from '../agent-host/find-command'
import type { DeviceInput, DeviceOrientation, DeviceScreen, FrameKind } from '@shared/device-host'
import { asciiKey, DriverError, hidUsage, type DeviceDriver, type DriverEvents } from './driver'
import { encodeJsonFrame, FRAME_TAG, FrameReader, frameJson } from './framing'
import { helperPath } from './runtime'

const XCRUN = '/usr/bin/xcrun'

const KIND_BY_TAG: Record<number, FrameKind> = {
  [FRAME_TAG.description]: 'description',
  [FRAME_TAG.keyframe]: 'key',
  [FRAME_TAG.delta]: 'delta',
}

/** The helper's error codes, as the pane names the step that is missing. */
const HELPER_ERRORS: Record<string, string> = {
  'no-device': 'Connect the device with a USB cable',
  'unsupported-ios': 'This iOS version has no screen service',
  'developer-mode-off': 'Turn on Developer Mode on the device',
  'ddi-not-mounted': 'The developer disk image is not mounted',
  'not-paired': 'Trust this computer on the device',
  'camera-in-use': 'An app on the device is using the camera or microphone',
}

export function majorVersion(osVersion: string | null): number {
  return Number.parseInt(osVersion?.split('.')[0] ?? '', 10) || 0
}

export class IosDeviceDriver implements DeviceDriver {
  private child: ChildProcess | null = null
  private events: DriverEvents | null = null
  private stopped = false
  private hid = false

  constructor(
    private readonly udid: string,
    private readonly osVersion: string | null,
    private readonly resourcesPath: string | null,
    private readonly env: Env,
    private readonly log: (message: string) => void,
  ) {}

  async start(events: DriverEvents): Promise<void> {
    this.events = events
    // The developer disk image carries the services the helpers need; mounting it is idempotent.
    await new Promise<void>((resolve) =>
      execFile(
        XCRUN,
        ['devicectl', 'device', 'info', 'ddiServices', '--device', this.udid],
        { env: this.env, timeout: 60_000 },
        () => resolve(),
      ),
    )
    const modern = majorVersion(this.osVersion) >= 27
    const name = modern ? 'kettu-ios-device' : 'kettu-ios-usb-capture'
    const helper = await helperPath(name, this.resourcesPath)
    if (!helper) throw new DriverError('helper_missing', `${name} is not installed with Kettu`)
    const child = spawn(helper, ['stream', '--udid', this.udid], {
      env: this.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()))
    const reader = new FrameReader()
    let settle: ((error: Error | null) => void) | null = null
    const ready = new Promise<void>((resolve, reject) => {
      settle = (error) => {
        settle = null
        if (error) reject(error)
        else resolve()
      }
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(new Uint8Array(chunk))) {
        const kind = KIND_BY_TAG[frame.tag]
        if (kind) {
          events.frame(kind, frame.payload)
          continue
        }
        const value = frameJson(frame.payload) as Record<string, unknown> | null
        if (!value) continue
        if (frame.tag === FRAME_TAG.screen && value.type === 'screen') {
          const width = Number(value.width)
          const height = Number(value.height)
          if (!(width > 0 && height > 0) || typeof value.codec !== 'string') continue
          const screen: DeviceScreen = {
            width,
            height,
            orientation: (value.orientation as DeviceOrientation) ?? 'portrait',
            codec: value.codec,
          }
          events.screen(screen)
        } else if (frame.tag === FRAME_TAG.status) {
          if (value.type === 'ready') settle?.(null)
          else if (value.type === 'input') {
            this.hid = value.available === true
            events.input(this.hid)
          } else if (value.type === 'error') {
            const code = String(value.code)
            const message = HELPER_ERRORS[code] ?? String(value.message ?? code)
            settle?.(new DriverError(code, message))
            if (!settle) this.end(message)
          }
        }
      }
    })
    child.once('exit', (code) => {
      this.child = null
      settle?.(
        new DriverError('helper_exit', `The device stream stopped (exit ${code ?? 'signal'})`),
      )
      if (!this.stopped) this.end(`The device stream stopped (exit ${code ?? 'signal'})`)
    })
    await ready
  }

  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    if (!child) return
    // Closing stdin asks the helper to stop its stream and exit.
    child.stdin?.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  requestKeyframe(): void {
    this.write(FRAME_TAG.requestKeyframe, { type: 'keyframe' })
  }

  send(input: DeviceInput): void {
    if (!this.hid) return
    switch (input.type) {
      case 'touch':
        this.write(FRAME_TAG.touch, {
          type: input.phase,
          x: input.x,
          y: input.y,
          id: input.finger ?? 0,
        })
        break
      case 'scroll': {
        const to = (value: number, delta: number): number =>
          Math.min(1, Math.max(0, value - delta * 0.002))
        this.write(FRAME_TAG.touch, { type: 'begin', x: input.x, y: input.y, id: 0 })
        this.write(FRAME_TAG.touch, {
          type: 'move',
          x: to(input.x, input.dx),
          y: to(input.y, input.dy),
          id: 0,
        })
        this.write(FRAME_TAG.touch, {
          type: 'end',
          x: to(input.x, input.dx),
          y: to(input.y, input.dy),
          id: 0,
        })
        break
      }
      case 'key': {
        const usage = hidUsage(input.code)
        if (usage !== null) this.write(FRAME_TAG.key, { type: input.phase, usage })
        break
      }
      case 'text':
        void this.typeText(input.text)
        break
      case 'button':
        if (
          input.button === 'home' ||
          input.button === 'lock' ||
          input.button === 'volumeUp' ||
          input.button === 'volumeDown'
        ) {
          this.write(FRAME_TAG.button, { button: input.button })
        }
        break
    }
  }

  async screenshot(): Promise<Uint8Array> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-shot-'))
    const file = path.join(dir, 'screen.png')
    try {
      await new Promise<void>((resolve, reject) =>
        execFile(
          XCRUN,
          [
            'devicectl',
            'device',
            'capture',
            'screenshot',
            '--device',
            this.udid,
            '--destination',
            file,
          ],
          { env: this.env, timeout: 30_000 },
          (error) => (error ? reject(new DriverError('screenshot', error.message)) : resolve()),
        ),
      )
      return new Uint8Array(await readFile(file))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** ASCII as keys; other text onto the device's pasteboard and Command+V. */
  private async typeText(text: string): Promise<void> {
    const keys = [...text].map(asciiKey)
    if (keys.every((key) => key !== null)) {
      for (const key of keys) {
        if (key!.shift) this.write(FRAME_TAG.key, { type: 'down', usage: 0xe1 })
        this.write(FRAME_TAG.key, { type: 'down', usage: key!.usage })
        this.write(FRAME_TAG.key, { type: 'up', usage: key!.usage })
        if (key!.shift) this.write(FRAME_TAG.key, { type: 'up', usage: 0xe1 })
      }
      return
    }
    await new Promise<void>((resolve) => {
      const child = spawn(
        XCRUN,
        ['devicectl', 'device', 'pasteboard', 'copy', '--device', this.udid],
        {
          env: this.env as NodeJS.ProcessEnv,
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      )
      child.once('error', () => resolve())
      child.once('exit', () => resolve())
      child.stdin!.end(text)
    })
    for (const [type, usage] of [
      ['down', 0xe3],
      ['down', 0x19],
      ['up', 0x19],
      ['up', 0xe3],
    ] as const) {
      this.write(FRAME_TAG.key, { type, usage })
    }
  }

  private write(tag: number, value: unknown): void {
    const stdin = this.child?.stdin
    if (stdin && !stdin.destroyed) stdin.write(encodeJsonFrame(tag, value))
  }

  private end(error: string | null): void {
    if (this.stopped) return
    this.stopped = true
    this.child?.stdin?.end()
    this.events?.ended(error)
  }
}
