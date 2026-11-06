// The contract between the device host and its clients: a window's renderer, a paired device's
// channel through the remote host, and the agent host running agents' device tools.

import type { Platform } from './platform'
import type { PortConnectionState } from './port-rpc'

export type DevicePlatform = 'ios' | 'android'
export type DeviceKind = 'simulator' | 'emulator' | 'physical'

/**
 * `ios-sim:<udid>`, `ios:<udid>`, `android:<serial>` or `avd:<name>` for an emulator that is not
 * running; a running emulator is listed by its serial.
 */
export type DeviceId = string

export type DeviceState = 'booted' | 'booting' | 'shutdown' | 'connected' | 'unavailable'

/** A step the host or the device still needs before the device can be shown or driven. */
export type DeviceProblem =
  | 'xcode-missing'
  | 'apple-silicon-required'
  | 'android-sdk-missing'
  | 'developer-mode-off'
  | 'not-paired'
  | 'ddi-not-mounted'
  | 'usb-required'
  | 'ios-27-for-input'
  | 'runner-unsigned'
  | 'runner-untrusted'
  | 'ui-automation-off'
  | 'usb-debugging-unauthorized'
  | 'offline'

export interface DeviceOperator {
  /** The session whose agent is acting on the device right now, or null when the user took over. */
  sessionId: string | null
  agentName: string | null
  /** The user's input took over; agents' calls fail until they hand back. */
  user: boolean
}

export interface DeviceInfo {
  id: DeviceId
  platform: DevicePlatform
  kind: DeviceKind
  name: string
  /** Such as "26.5" or "15"; null when unknown. */
  osVersion: string | null
  model: string | null
  state: DeviceState
  connection: 'usb' | 'network' | null
  /** The session that holds the device, or null when none does. */
  sessionId: string | null
  operator: DeviceOperator | null
  problems: DeviceProblem[]
  /** Whether the user can tap and type on its stream now. */
  input: boolean
}

export interface DeviceEnvironment {
  platform: Platform
  /** iOS simulators and physical devices can be used: macOS with Xcode. */
  ios: boolean
  /** iOS simulators can stream: Apple silicon as well. */
  iosStream: boolean
  android: boolean
  problems: DeviceProblem[]
}

export type DeviceOrientation =
  'portrait' | 'portrait_upside_down' | 'landscape_left' | 'landscape_right'

export interface DeviceScreen {
  width: number
  height: number
  orientation: DeviceOrientation
  /** WebCodecs' codec string, such as `avc1.640033` or `hvc1.1.6.L153.B0`. */
  codec: string
}

export type DeviceButton =
  'home' | 'lock' | 'volumeUp' | 'volumeDown' | 'back' | 'recents' | 'rotate'

export type TouchPhase = 'begin' | 'move' | 'end'

/** What the user does on the stream. Coordinates are 0 to 1 within the frame as it is shown. */
export type DeviceInput =
  | { type: 'touch'; phase: TouchPhase; x: number; y: number; finger?: number }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  /** A key by its `KeyboardEvent.code`, for keys that are not text, or text on a hardware keyboard. */
  | { type: 'key'; phase: 'down' | 'up'; code: string }
  /** Text the device's keyboard cannot take a key at a time, such as Chinese, or pasted text. */
  | { type: 'text'; text: string }
  | { type: 'button'; button: DeviceButton }

export type FrameKind = 'description' | 'key' | 'delta' | 'seed'

/** A rectangle in a device frame's own points. */
export interface DeviceFrameRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The device's own frame, as Xcode draws its simulator, in portrait: pictures placed back to
 * front in the frame's points, with the screen over them. Clients turn it with the screen.
 */
export interface DeviceFrame {
  width: number
  height: number
  screen: DeviceFrameRect
  /** The screen's corner radii in points: top left, top right, bottom right, bottom left. */
  radii: [number, number, number, number]
  images: Array<DeviceFrameRect & { png: ArrayBuffer }>
}

export interface DeviceContract {
  'devices.environment': { params: Record<string, never>; result: DeviceEnvironment }
  'devices.list': { params: { sessionId?: string }; result: DeviceInfo[] }
  /** Boots the device if it is a simulator or emulator, and gives it to the session. */
  'devices.open': { params: { deviceId: DeviceId; sessionId: string }; result: DeviceInfo }
  /** Takes the device from the session; `shutdown` also shuts a simulator or emulator down. */
  'devices.close': {
    params: { deviceId: DeviceId; sessionId: string; shutdown?: boolean }
    result: void
  }
  /** Starts sending the device's frames to this port, starting at a keyframe. */
  'devices.watch': { params: { deviceId: DeviceId }; result: { screen: DeviceScreen | null } }
  'devices.unwatch': { params: { deviceId: DeviceId }; result: void }
  /** The client has decoded frames up to `seq`; the host sends more only as these arrive. */
  'devices.ack': { params: { deviceId: DeviceId; seq: number }; result: void }
  'devices.input': { params: { deviceId: DeviceId; input: DeviceInput }; result: void }
  /** Hands the device back to the agent after the user took over. */
  'devices.handBack': { params: { deviceId: DeviceId }; result: void }
  /** Cancels the agent's current call and gives the user control. */
  'devices.stopAgent': { params: { deviceId: DeviceId }; result: void }
  'devices.screenshot': { params: { deviceId: DeviceId }; result: { png: ArrayBuffer } }
  /** The frame to draw the screen in, or null where the client draws a plain one. */
  'devices.frame': { params: { deviceId: DeviceId }; result: { frame: DeviceFrame | null } }
}

export type DeviceMethod = keyof DeviceContract
export type DeviceParams<M extends DeviceMethod> = DeviceContract[M]['params']
export type DeviceResult<M extends DeviceMethod> = DeviceContract[M]['result']

export const DEVICE_METHODS = [
  'devices.environment',
  'devices.list',
  'devices.open',
  'devices.close',
  'devices.watch',
  'devices.unwatch',
  'devices.ack',
  'devices.input',
  'devices.handBack',
  'devices.stopAgent',
  'devices.screenshot',
  'devices.frame',
] as const satisfies readonly DeviceMethod[]

export type DeviceEvent =
  | { type: 'devices.changed'; devices: DeviceInfo[] }
  | { type: 'device.screen'; deviceId: DeviceId; screen: DeviceScreen }
  /** `data` is an avcC or hvcC record for a description, a JPEG for a seed, else an access unit. */
  | { type: 'device.frame'; deviceId: DeviceId; seq: number; kind: FrameKind; data: ArrayBuffer }
  | {
      type: 'device.stream'
      deviceId: DeviceId
      state: 'starting' | 'live' | 'stopped' | 'error'
      error?: string
    }
  /** To a paired device: its port to the device host was lost, so it watches its devices again. */
  | { type: 'devices.restarted' }
  /** A session's agent opened a device, so a window shows it if that session's panel is free. */
  | { type: 'device.opened'; deviceId: DeviceId; sessionId: string }

export interface DevicesApi {
  request<M extends DeviceMethod>(method: M, params: DeviceParams<M>): Promise<DeviceResult<M>>
  onEvent(listener: (event: DeviceEvent) => void): () => void
  onConnection(listener: (state: PortConnectionState) => void): () => void
  restart(): Promise<void>
}

/** Frames a client may have in flight before it acknowledges; behind that the host skips ahead. */
export const DEVICE_FLOW = {
  window: 8,
  maxTextBytes: 4096,
} as const
