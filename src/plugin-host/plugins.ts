// The plugins of the process: which are loaded, what woke them, and how often each crashed. A
// plugin is loaded only by an activation that names something its manifest declared.

import type { LogLevel } from '@shared/log/process-log'
import {
  isPluginId,
  PLUGIN_CRASH_LIMIT,
  PLUGIN_CRASH_WINDOW_MS,
  PLUGIN_SCRIPT_LIMIT_BYTES,
  PluginRequestError,
  type PluginCrashReason,
  type PluginDeadline,
  type PluginHookReply,
  type PluginScript,
  type PluginStatus,
} from '@shared/plugin-host'
import type { Engine } from './engine'
import { PluginEnvironment, type EnvironmentLimits } from './environment'
import type { HostFunctions } from './host-functions'

export interface PluginManagerOptions {
  engine: Engine
  /** The host functions answered here; any other name goes to `forward`. */
  functions: HostFunctions
  /** Asks the agent host to answer a host function. */
  forward(pluginId: string, name: string, args: unknown[]): Promise<unknown>
  /** The text of a plugin's script. */
  readScript(scriptPath: string): Promise<string>
  log(pluginId: string, level: LogLevel, text: string): void
  /** Called whenever a plugin's status changed. */
  onStatus?(plugins: PluginStatus[]): void
  now?(): number
  limits?: Partial<EnvironmentLimits>
}

interface Entry {
  environment: PluginEnvironment | null
  loading: Promise<PluginEnvironment> | null
  /** Bumped by whatever unloads the plugin, so a load that was under way is dropped. */
  generation: number
  crashes: number[]
  reason: PluginCrashReason | null
  disabled: boolean
}

function failure(code: PluginRequestError['code'], message: string): PluginRequestError {
  return new PluginRequestError({ code, message })
}

export class PluginManager {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number

  constructor(private readonly options: PluginManagerOptions) {
    this.now = options.now ?? Date.now
  }

  /** Loads the plugin's script if `trigger` is something its manifest says wakes it. */
  async activate(plugin: PluginScript, trigger: string): Promise<void> {
    if (!plugin.activation.includes(trigger)) {
      throw failure('not_declared', `The plugin does not declare "${trigger}"`)
    }
    const entry = this.entry(plugin.id)
    if (entry.disabled) throw this.disabledError()
    if (entry.environment) return
    entry.loading ??= this.load(plugin, entry).finally(() => {
      entry.loading = null
    })
    await entry.loading
  }

  async call(
    pluginId: string,
    name: string,
    args: unknown[],
    deadline: PluginDeadline,
  ): Promise<unknown> {
    return this.active(pluginId).call(name, args, deadline)
  }

  event(pluginId: string, name: string, payload: unknown): void {
    this.active(pluginId).event(name, payload)
  }

  hook(
    pluginId: string,
    name: string,
    payload: unknown,
    deadline: PluginDeadline = 'before-send',
  ): Promise<PluginHookReply> {
    return this.active(pluginId).hook(name, payload, deadline)
  }

  /** Unloads the plugin; it stays known, with its crashes. */
  deactivate(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    this.unload(entry)
    this.changed()
  }

  /** Lets a plugin that crashed too often be woken again. */
  enable(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry?.disabled) return
    entry.disabled = false
    entry.crashes = []
    entry.reason = null
    this.changed()
  }

  /** Marks plugins as disabled that were so before this process started. */
  restore(disabled: { id: string; reason: PluginCrashReason | null }[]): void {
    for (const { id, reason } of disabled) {
      if (!isPluginId(id)) continue
      const entry = this.entry(id)
      this.unload(entry)
      entry.disabled = true
      entry.reason = reason
    }
    this.changed()
  }

  status(): PluginStatus[] {
    const since = this.now() - PLUGIN_CRASH_WINDOW_MS
    return [...this.entries].map(([id, entry]) => ({
      id,
      state: entry.disabled ? 'disabled' : entry.environment ? 'active' : 'idle',
      crashes: entry.crashes.filter((at) => at > since).length,
      reason: entry.reason,
    }))
  }

  /** Unloads every plugin and forgets them all, as when the agent host is gone. */
  clear(): void {
    for (const entry of this.entries.values()) this.unload(entry)
    this.entries.clear()
  }

  private entry(pluginId: string): Entry {
    let entry = this.entries.get(pluginId)
    if (!entry) {
      entry = {
        environment: null,
        loading: null,
        generation: 0,
        crashes: [],
        reason: null,
        disabled: false,
      }
      this.entries.set(pluginId, entry)
    }
    return entry
  }

  private active(pluginId: string): PluginEnvironment {
    const entry = this.entries.get(pluginId)
    if (entry?.disabled) throw this.disabledError()
    if (!entry?.environment) throw failure('not_active', 'Nothing has woken the plugin yet')
    return entry.environment
  }

  private disabledError(): PluginRequestError {
    return failure('disabled', 'The plugin crashed too often and is disabled')
  }

  private unload(entry: Entry): void {
    entry.generation++
    entry.environment?.dispose()
    entry.environment = null
  }

  private async load(plugin: PluginScript, entry: Entry): Promise<PluginEnvironment> {
    const { id } = plugin
    const generation = entry.generation
    const log = (level: LogLevel, text: string): void => this.options.log(id, level, text)
    let source: string
    try {
      source = await this.options.readScript(plugin.scriptPath)
    } catch (error) {
      throw failure('failed', `The plugin's script cannot be read: ${(error as Error).message}`)
    }
    if (Buffer.byteLength(source) > PLUGIN_SCRIPT_LIMIT_BYTES) {
      throw failure('too_large', "The plugin's script is too large")
    }
    const functions = this.options.functions
    let environment: PluginEnvironment
    try {
      environment = await PluginEnvironment.create(
        {
          engine: this.options.engine,
          callHost: (name, args) =>
            Object.hasOwn(functions, name)
              ? functions[name]!({ pluginId: id, log }, args)
              : this.options.forward(id, name, args),
          log,
          onCrash: (reason) => this.crashed(id, entry, reason),
          ...(this.options.limits ? { limits: this.options.limits } : {}),
        },
        source,
      )
    } catch (error) {
      log('error', (error as Error).message)
      throw error
    }
    if (entry.generation !== generation || entry.disabled) {
      environment.dispose()
      throw failure('not_active', 'The plugin was unloaded while it loaded')
    }
    entry.environment = environment
    log('info', 'Loaded')
    this.changed()
    return environment
  }

  private crashed(id: string, entry: Entry, reason: PluginCrashReason): void {
    const now = this.now()
    entry.generation++
    entry.environment = null
    entry.reason = reason
    entry.crashes = entry.crashes.filter((at) => at > now - PLUGIN_CRASH_WINDOW_MS)
    entry.crashes.push(now)
    const what = reason === 'deadline' ? 'ran past its time limit' : 'used too much memory'
    if (entry.crashes.length >= PLUGIN_CRASH_LIMIT) {
      entry.disabled = true
      this.options.log(
        id,
        'error',
        `It ${what}; disabled after ${entry.crashes.length} crashes in a minute`,
      )
    } else {
      this.options.log(id, 'error', `It ${what} and was stopped`)
    }
    this.changed()
  }

  private changed(): void {
    this.options.onStatus?.(this.status())
  }
}
