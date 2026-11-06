// Computer use: agents reading and driving the desktop apps of the computer the desktop app runs
// on, through the `computer_*` tools of the `kettu` MCP server.

/** The tools the `kettu` MCP server offers, which the agent host runs through Cua Driver. */
export const COMPUTER_TOOL_NAMES = [
  'computer_list_apps',
  'computer_list_windows',
  'computer_get_window_state',
  'computer_click',
  'computer_type_text',
  'computer_press_key',
  'computer_hotkey',
  'computer_scroll',
  'computer_drag',
  'computer_invoke_menu',
] as const

export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number]

export function isComputerToolName(name: string): name is ComputerToolName {
  return (COMPUTER_TOOL_NAMES as readonly string[]).includes(name)
}

export type ComputerToolErrorCode =
  // Off in Settings, not on this host, or for a turn nobody sent from this computer's window.
  | 'unavailable'
  // The user denied the app, or did not answer in time.
  | 'not_allowed'
  // An app, shortcut or menu item computer use never touches.
  | 'blocked'
  // Another session is using the computer.
  | 'busy'
  // The user pressed Stop; the next message from them lifts it.
  | 'stopped'
  | 'invalid'
  // The driver refused the call or failed; its message says why.
  | 'failed'
  | 'timeout'

/** An app as approvals know it: an identity that outlives its process, and the name shown. */
export interface ComputerApp {
  /** A bundle id on macOS; on Windows and Linux the executable's file name, lowercased. */
  id: string
  name: string
}

export function isComputerApp(value: unknown): value is ComputerApp {
  if (typeof value !== 'object' || value === null) return false
  const { id, name } = value as Record<string, unknown>
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 512 &&
    typeof name === 'string' &&
    name.length <= 512
  )
}

/** What the user answered a session's first use of an app. */
export type ComputerAppDecision = 'session' | 'always' | 'deny'

export function isComputerAppDecision(value: unknown): value is ComputerAppDecision {
  return value === 'session' || value === 'always' || value === 'deny'
}

/** The answer to a first use of an app; `timeout` when the user did not answer. */
export type ComputerAppAnswer = ComputerAppDecision | 'timeout'

/** How long a call waits for the user to answer a first use of an app. */
export const COMPUTER_APP_WAIT_MS = 120_000

/** A step of the setup a first call waits on: the switch, or a macOS permission. */
export type ComputerSetupStep = 'enable' | 'accessibility' | 'screen-recording'

export function isComputerSetupStep(value: unknown): value is ComputerSetupStep {
  return value === 'enable' || value === 'accessibility' || value === 'screen-recording'
}

/** How a setup card ended: all done, the user said not now, or not done in time. */
export type ComputerSetupOutcome = 'ready' | 'declined' | 'timeout'

/** How long a call waits for the user to finish the setup. */
export const COMPUTER_SETUP_WAIT_MS = 5 * 60_000
/** How often a waiting setup checks the switch and the permissions again. */
export const COMPUTER_SETUP_POLL_MS = 1_500

/** The macOS permissions as the driver reports Kettu's grants. */
export interface ComputerPermissions {
  accessibility: boolean
  screenRecording: boolean
}

/** The part of the settings computer use reads, which main keeps and the host is sent. */
export interface ComputerUseSettings {
  enabled: boolean
  /** Apps the user allowed for every session. */
  allowedApps: ComputerApp[]
}

export const DEFAULT_COMPUTER_USE: ComputerUseSettings = { enabled: false, allowedApps: [] }

/** A system permission computer use needs, as the Settings page shows it. */
export type ComputerPermission = 'granted' | 'denied' | 'not-determined' | 'unknown'

/** This computer as computer use sees it, for Settings › Computer use. */
export interface ComputerUseStatus {
  /** The build carries the driver; a development checkout may not have fetched it. */
  driver: boolean
  /** macOS: Accessibility and Screen Recording, which Kettu holds for the driver. */
  accessibility: ComputerPermission | null
  screenRecording: ComputerPermission | null
  /** Linux: the desktop session's kind and desktop, which decide what the driver can do. */
  sessionType: 'x11' | 'wayland' | null
  desktop: string | null
}

/** The macOS permission a Settings button asks for. */
export type ComputerPermissionKind = 'accessibility' | 'screen-recording'

export function isComputerPermissionKind(value: unknown): value is ComputerPermissionKind {
  return value === 'accessibility' || value === 'screen-recording'
}
