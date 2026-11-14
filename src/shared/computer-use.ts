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
  /** The global shortcut that stops using the computer from anywhere, as an Electron accelerator. */
  stopShortcut: string
}

/** Stop from anywhere: Control, Option, Command and period on macOS; with Shift elsewhere. */
export function defaultStopShortcut(platform: string): string {
  return platform === 'darwin' ? 'Control+Alt+Command+.' : 'Control+Alt+Shift+.'
}

export const DEFAULT_COMPUTER_USE: ComputerUseSettings = {
  enabled: false,
  allowedApps: [],
  stopShortcut: '',
}

const SHORTCUT_MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Command', 'Super'])
// Keys that may end a global shortcut: a letter, digit, function key or one of these.
const SHORTCUT_KEY =
  /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|[.,;'/\\[\]`=-]|Space|Tab|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete)$/

/**
 * Whether `value` is a stop shortcut Kettu registers: modifiers then one key, with at least two
 * modifiers so that ordinary typing never stops computer use. Empty means the platform's default.
 */
export function isStopShortcut(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === '') return true
  if (value.length > 64) return false
  const parts = value.split('+')
  const key = parts.pop()!
  const modifiers = new Set(parts)
  if (modifiers.size !== parts.length || modifiers.size < 2) return false
  if (![...modifiers].every((part) => SHORTCUT_MODIFIERS.has(part))) return false
  return SHORTCUT_KEY.test(key)
}

const MAC_KEYS: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' }
const OTHER_KEYS: Record<string, string> = { Control: 'Ctrl', Command: 'Super' }

/** An accelerator's keys as the platform writes them: ⌃ ⌥ ⌘ . on macOS, Ctrl Alt Shift . elsewhere. */
export function acceleratorKeys(accelerator: string, platform: string): string[] {
  const names = platform === 'darwin' ? MAC_KEYS : OTHER_KEYS
  return accelerator.split('+').map((part) => names[part] ?? part)
}

/** Who has the app a session uses: the agent, or the user, who took it over. */
export type ComputerControl = 'agent' | 'you'

/**
 * Where the agent acted last in the window it uses, as a share of the window's width and height
 * from its top left, so every view of the window places it; null where the action has no point,
 * such as a key. `seq` counts the actions, so a repeat at the same point still shows.
 */
export interface ComputerAct {
  seq: number
  kind: 'click' | 'type' | 'key' | 'scroll' | 'drag' | 'menu'
  x: number | null
  y: number | null
}

/** The window a session uses, as computer use knows it from the driver. */
export interface ComputerWindowRef {
  pid: number
  id: number
  title: string | null
}

/**
 * The session that holds the computer, as main draws it while Kettu is in the background: the
 * floating label, the light around the real window and the agent's pointer.
 */
export interface ComputerHold {
  sessionId: string
  agentId: string
  agentName: string
  /** The app it last read or drove, and where the app lies, for its icon. */
  app: string | null
  appPath: string | null
  window: ComputerWindowRef | null
  control: ComputerControl
  act: ComputerAct | null
}

/** Where the window a session uses is now, in screen points, as main asks for it. */
export interface ComputerFrame {
  bounds: { x: number; y: number; width: number; height: number }
  /** On screen and on the current Space: neither minimized, hidden nor on another Space. */
  visible: boolean
  title: string | null
}

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

function isShare(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && value >= 0 && value <= 1)
}

const ACT_KINDS = new Set(['click', 'type', 'key', 'scroll', 'drag', 'menu'])

function isAct(value: unknown): value is ComputerAct {
  if (typeof value !== 'object' || value === null) return false
  const { seq, kind, x, y } = value as Record<string, unknown>
  return Number.isSafeInteger(seq) && ACT_KINDS.has(kind as string) && isShare(x) && isShare(y)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isText(value: unknown, max = 1_024): value is string {
  return typeof value === 'string' && value.length <= max
}

/** Whether a host's message is a hold main can draw. */
export function isComputerHold(value: unknown): value is ComputerHold {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  const window = o.window as Record<string, unknown> | null | undefined
  return (
    isText(o.sessionId) &&
    isText(o.agentId) &&
    isText(o.agentName) &&
    (o.app === null || isText(o.app)) &&
    (o.appPath === null || isText(o.appPath, 4_096)) &&
    (window === null ||
      (typeof window === 'object' &&
        Number.isSafeInteger(window.pid) &&
        Number.isSafeInteger(window.id) &&
        (window.title === null || isText(window.title)))) &&
    (o.control === 'agent' || o.control === 'you') &&
    (o.act === null || isAct(o.act))
  )
}

/** Whether a host's answer is a window's frame. */
export function isComputerFrame(value: unknown): value is ComputerFrame {
  if (typeof value !== 'object' || value === null) return false
  const { bounds, visible, title } = value as Record<string, unknown>
  const b = bounds as Record<string, unknown> | null | undefined
  return (
    typeof b === 'object' &&
    b !== null &&
    isFiniteNumber(b.x) &&
    isFiniteNumber(b.y) &&
    isFiniteNumber(b.width) &&
    isFiniteNumber(b.height) &&
    b.width > 0 &&
    b.height > 0 &&
    typeof visible === 'boolean' &&
    (title === null || isText(title))
  )
}
