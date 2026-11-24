// The plugin host: the process that runs plugins' scripts, each in an engine of its own, and the
// one port the agent host reaches it through. Nothing else connects to it.

/** How long one entry into a plugin's script may run: a call, an event, a timer or an answer. */
export const PLUGIN_CALL_DEADLINE_MS = 2000
/**
 * The same for a call on a path that is not kept waiting: a message about to be sent and a
 * permission request about to be shown.
 */
export const PLUGIN_BEFORE_SEND_DEADLINE_MS = 500
/** How long a call may wait for the plugin's answer, across everything the plugin awaits. */
export const PLUGIN_ANSWER_TIMEOUT_MS = 30_000
export const PLUGIN_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
// Below the stack the engine's own WebAssembly instance has, which a deeper script would overflow.
export const PLUGIN_STACK_LIMIT_BYTES = 256 * 1024
/** The JSON of one value crossing between a plugin and the host, either way, in characters. */
export const PLUGIN_MESSAGE_LIMIT_CHARS = 1024 * 1024
export const PLUGIN_SCRIPT_LIMIT_BYTES = 8 * 1024 * 1024
/** Timers and unanswered host calls one plugin may hold at a time. */
export const PLUGIN_PENDING_LIMIT = 256
export const PLUGIN_LOG_LINE_CHARS = 8 * 1024
/** This many crashes within the window disable a plugin until it is enabled again. */
export const PLUGIN_CRASH_LIMIT = 3
export const PLUGIN_CRASH_WINDOW_MS = 60_000
/** How long the process stays once no plugin is active, so a plugin woken again finds it. */
export const PLUGIN_HOST_IDLE_STOP_MS = 30_000
export const PLUGIN_HOST_PING_INTERVAL_MS = 15_000
/** A process that leaves a ping unanswered this long is killed and started again. */
export const PLUGIN_HOST_PING_TIMEOUT_MS = 10_000

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/

export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_ID.test(value)
}

/** A plugin's script as the plugin host needs it. */
export interface PluginScript {
  id: string
  /** The plugin's one bundled JavaScript file. */
  scriptPath: string
  /** What wakes the plugin, as its manifest declares it: event names, command names, panel ids. */
  activation: string[]
}

export function isPluginScript(value: unknown): value is PluginScript {
  if (typeof value !== 'object' || value === null) return false
  const { id, scriptPath, activation } = value as Record<string, unknown>
  return (
    isPluginId(id) &&
    typeof scriptPath === 'string' &&
    scriptPath.length > 0 &&
    Array.isArray(activation) &&
    activation.every((entry) => typeof entry === 'string')
  )
}

export type PluginDeadline = 'call' | 'before-send'

/**
 * What the listeners of a hook gave: what each one returned or resolved to, and the message of
 * each that threw or rejected, for a caller that says why nothing answered.
 */
export interface PluginHookReply {
  answers: unknown[]
  errors: string[]
}

export type PluginErrorCode =
  | 'invalid' // the request itself is malformed
  | 'not_declared' // the plugin's manifest does not name what would wake it
  | 'not_active' // nothing woke the plugin yet
  | 'disabled' // it crashed too often
  | 'crashed' // it passed a limit during this request and was stopped
  | 'timeout' // it did not answer in time
  | 'too_large' // a value is past what may cross
  | 'unknown_function' // no host function has this name
  | 'permission_denied' // the plugin was not given the permission the function needs
  | 'unavailable' // the plugin host is not running
  | 'failed' // the plugin's own code threw

export interface PluginError {
  code: PluginErrorCode
  message: string
}

export class PluginRequestError extends Error {
  readonly code: PluginErrorCode

  constructor(error: PluginError) {
    super(error.message)
    this.name = 'PluginRequestError'
    this.code = error.code
  }
}

export type PluginCrashReason = 'deadline' | 'memory'

export interface PluginStatus {
  id: string
  /** `active`: its script is loaded. `disabled`: it crashed too often and waits to be enabled. */
  state: 'idle' | 'active' | 'disabled'
  /** Crashes within the last window. */
  crashes: number
  /** Why it last crashed, which for a disabled plugin is why it is disabled. */
  reason: PluginCrashReason | null
}

/** What the agent host sends on the port; every request is answered by its `requestId`. */
export type AgentToPluginHost =
  | { type: 'activate'; requestId: number; plugin: PluginScript; trigger: string }
  | {
      type: 'call'
      requestId: number
      pluginId: string
      name: string
      args: unknown[]
      deadline: PluginDeadline
    }
  | { type: 'event'; requestId: number; pluginId: string; name: string; payload: unknown }
  // An event whose listeners answer: what each returned or resolved to, within the hook deadline,
  // or within the call's when `deadline` says `call`.
  | {
      type: 'hook'
      requestId: number
      pluginId: string
      name: string
      payload: unknown
      deadline?: PluginDeadline
    }
  | { type: 'deactivate'; requestId: number; pluginId: string }
  | { type: 'enable'; requestId: number; pluginId: string }
  // The plugins disabled before this process started, which a restart must not enable.
  | { type: 'restore'; disabled: { id: string; reason: PluginCrashReason | null }[] }
  // The answer to a function-call.
  | { type: 'function-result'; callId: number; result: unknown }
  | { type: 'function-result'; callId: number; error: PluginError }

export type PluginHostToAgent =
  | { type: 'answer'; requestId: number; result: unknown }
  | { type: 'answer'; requestId: number; error: PluginError }
  // Every plugin the process knows, sent whenever one changes.
  | { type: 'status'; plugins: PluginStatus[] }
  // A plugin calls a host function the plugin host does not answer itself.
  | { type: 'function-call'; callId: number; pluginId: string; name: string; args: unknown[] }

export type MainToPluginHost =
  | {
      type: 'plugin-host:init'
      /** The engine's WebAssembly file. */
      wasmPath: string
      // Under Node.js, the local socket the host takes its port on; the desktop app hands it over.
      socketPath?: string
    }
  // The agent host's port, which travels in the transfer list.
  | { type: 'plugin-host:connect' }
  | { type: 'plugin-host:ping'; id: number }
  | { type: 'plugin-host:shutdown' }

export type PluginHostToMain =
  | { type: 'plugin-host:ready' }
  | { type: 'plugin-host:pong'; id: number }
  | { type: 'plugin-host:stopped' }
