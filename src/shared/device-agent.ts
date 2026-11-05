// Agents' device tools: their names, the actions the device host carries out for them, and the
// messages that carry a call from the agent host to the device host and back.

import type { DeviceButton, DeviceOrientation } from './device-host'

export const DEVICE_TOOL_NAMES = [
  'device_list',
  'device_open',
  'device_close',
  'device_snapshot',
  'device_tap',
  'device_fill',
  'device_type',
  'device_scroll',
  'device_swipe',
  'device_press_button',
  'device_rotate',
  'device_screenshot',
  'device_install_app',
  'device_launch_app',
  'device_terminate_app',
  'device_open_url',
  'device_logs',
  'device_set_appearance',
  'device_set_location',
  'device_set_permission',
] as const

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number]

export type DeviceAction =
  | { type: 'snapshot' }
  | { type: 'tap'; ref: string; long?: boolean }
  | { type: 'tap'; x: number; y: number; long?: boolean }
  | { type: 'fill'; ref: string; text: string }
  | { type: 'type'; text: string }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'swipe'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: 'button'; button: Exclude<DeviceButton, 'rotate'> }
  | { type: 'rotate'; orientation: DeviceOrientation }
  | { type: 'screenshot' }
  | { type: 'install'; path: string }
  | { type: 'launch'; app: string }
  | { type: 'terminate'; app: string }
  | { type: 'open_url'; url: string }
  | { type: 'logs'; lines: number }
  | { type: 'appearance'; mode: 'light' | 'dark' }
  | { type: 'location'; latitude: number; longitude: number }
  | { type: 'permission'; app: string; permission: string; grant: boolean }

export interface DeviceActionResult {
  text: string
  /** A PNG in base64, for a screenshot. */
  image?: string
}

/** What the agent host asks of the device host for one tool call. */
export type DeviceCall =
  | { kind: 'list'; sessionId: string }
  | { kind: 'open'; sessionId: string; agentName: string; deviceId: string }
  | { kind: 'close'; sessionId: string; deviceId: string; shutdown: boolean }
  | {
      kind: 'action'
      sessionId: string
      agentName: string
      deviceId: string
      action: DeviceAction
      /** The agent's own folder, where relative app paths are resolved. */
      projectPath: string | null
    }

export type DeviceCallAnswer =
  | { result: DeviceActionResult & { value?: unknown } }
  | { error: { code: DeviceCallErrorCode; message: string; data?: unknown } }

export type DeviceCallErrorCode =
  | 'invalid_params'
  | 'not_found'
  | 'busy'
  | 'not_open'
  | 'user_has_control'
  | 'stopped'
  | 'unavailable'
  | 'failed'

/** Seconds an agent's device call may run before it fails, long enough for an app's first build. */
export const DEVICE_CALL_TIMEOUT_MS = 240_000
/** How long the user has to answer a device access request. */
export const DEVICE_ACCESS_WAIT_MS = 120_000
