// The agent host's side of the plugin host: it asks for the process when a plugin's script must
// run, wakes plugins for what their manifests declare, calls them, delivers events and lets the
// process go once no plugin is loaded.

import {
  isPluginId,
  PLUGIN_ANSWER_TIMEOUT_MS,
  PLUGIN_CRASH_WINDOW_MS,
  PLUGIN_HOST_IDLE_STOP_MS,
  PluginRequestError,
  type AgentToPluginHost,
  type PluginDeadline,
  type PluginError,
  type PluginHookReply,
  type PluginHostToAgent,
  type PluginScript,
  type PluginStatus,
} from '@shared/plugin-host'
import type { PortChannel } from '@shared/port-channel'
import { missingPermission, type PluginApiCall } from './call'

export interface PluginHostClientTimings {
  startMs: number
  idleStopMs: number
  crashWindowMs: number
}

export interface PluginHostClientOptions {
  /** Tells the process that runs the hosts whether the plugin host is needed. */
  want(run: boolean): void
  /**
   * Every host function plugins may call here, by name; only own keys are looked up. A call is
   * answered only to a plugin that has the permission the entry names.
   */
  functions: Readonly<Record<string, PluginApiCall>>
  log(level: 'info' | 'warn', message: string): void
  /** Called with every plugin's status whenever one changes. */
  onStatus?(plugins: PluginStatus[]): void
  timings?: PluginHostClientTimings
}

type Request = AgentToPluginHost extends infer M
  ? M extends { requestId: number }
    ? Omit<M, 'requestId'>
    : never
  : never

interface Pending {
  resolve(value: unknown): void
  reject(error: PluginRequestError): void
}

interface Waiter {
  resolve(): void
  reject(error: PluginRequestError): void
  timer: ReturnType<typeof setTimeout>
}

const TIMINGS: PluginHostClientTimings = {
  startMs: 30_000,
  idleStopMs: PLUGIN_HOST_IDLE_STOP_MS,
  crashWindowMs: PLUGIN_CRASH_WINDOW_MS,
}

function unavailable(message: string): PluginRequestError {
  return new PluginRequestError({ code: 'unavailable', message })
}

function isPluginError(value: unknown): value is PluginError {
  if (typeof value !== 'object' || value === null) return false
  const { code, message } = value as Record<string, unknown>
  return typeof code === 'string' && typeof message === 'string'
}

export class PluginHostClient {
  private port: PortChannel<AgentToPluginHost> | null = null
  private wanted = false
  private stopped = false
  private nextRequest = 1
  private readonly pending = new Map<number, Pending>()
  private readonly waiters = new Set<Waiter>()
  private readonly plugins = new Map<string, PluginScript>()
  private readonly grants = new Map<string, readonly string[]>()
  private statuses = new Map<string, PluginStatus>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly timings: PluginHostClientTimings

  constructor(private readonly options: PluginHostClientOptions) {
    this.timings = options.timings ?? TIMINGS
  }

  /**
   * Makes an installed plugin's script known, or replaces what was known of it; nothing is
   * loaded until something it declares wakes it. `permissions` are the ones the user agreed to
   * for this version, which its calls are checked against.
   */
  register(plugin: PluginScript, permissions: readonly string[] = []): void {
    this.plugins.set(plugin.id, { ...plugin, activation: [...plugin.activation] })
    this.grants.set(plugin.id, [...permissions])
  }

  /** Forgets a plugin, as when it is removed or turned off, and unloads its script. */
  async unregister(pluginId: string): Promise<void> {
    this.plugins.delete(pluginId)
    this.grants.delete(pluginId)
    if (this.port && this.statuses.get(pluginId)?.state === 'active') {
      await this.request({ type: 'deactivate', pluginId })
    }
    this.statuses.delete(pluginId)
  }

  /** Asks for the plugin host and settles once its port is here. */
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(unavailable('The plugin host is stopping'))
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.port) return Promise.resolve()
    if (!this.wanted) {
      this.wanted = true
      this.options.want(true)
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          // Asked again by the next start, which also restarts a process that gave up.
          this.wanted = false
          reject(unavailable('The plugin host did not start'))
        }, this.timings.startMs),
      }
      this.waiters.add(waiter)
    })
  }

  /**
   * Loads the plugin's script because `trigger` happened, starting the plugin host if it is not
   * running. Rejects with `not_declared` when the plugin's manifest does not name `trigger`.
   */
  async activate(pluginId: string, trigger: string): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) throw new PluginRequestError({ code: 'invalid', message: 'Unknown plugin' })
    if (!plugin.activation.includes(trigger)) {
      throw new PluginRequestError({
        code: 'not_declared',
        message: `The plugin does not declare "${trigger}"`,
      })
    }
    const status = this.statuses.get(pluginId)
    if (status?.state === 'disabled') {
      throw new PluginRequestError({
        code: 'disabled',
        message: 'The plugin crashed too often and is disabled',
      })
    }
    if (status?.state === 'active' && this.port) return
    await this.start()
    try {
      await this.request({ type: 'activate', plugin, trigger })
    } finally {
      this.settleIdle()
    }
  }

  /** Calls a function an active plugin exported. */
  call(
    pluginId: string,
    name: string,
    args: unknown[],
    deadline: PluginDeadline = 'call',
  ): Promise<unknown> {
    return this.request({ type: 'call', pluginId, name, args, deadline })
  }

  /** Delivers an event to an active plugin's listeners. */
  async deliverEvent(pluginId: string, name: string, payload: unknown): Promise<void> {
    await this.request({ type: 'event', pluginId, name, payload })
  }

  /**
   * Asks the listeners of an active plugin for an event, which is what each returned. The wait is
   * bounded by the hook deadline, or by the call's when `deadline` is `call`, past which it
   * rejects with `timeout`.
   */
  async hook(
    pluginId: string,
    name: string,
    payload: unknown,
    deadline: PluginDeadline = 'before-send',
  ): Promise<unknown[]> {
    return (await this.hookReply(pluginId, name, payload, deadline)).answers
  }

  /** The same, with the message of each listener that threw beside what the others returned. */
  async hookReply(
    pluginId: string,
    name: string,
    payload: unknown,
    deadline: PluginDeadline = 'before-send',
  ): Promise<PluginHookReply> {
    const reply = await this.request({ type: 'hook', pluginId, name, payload, deadline })
    if (typeof reply !== 'object' || reply === null) return { answers: [], errors: [] }
    const { answers, errors } = reply as Partial<Record<keyof PluginHookReply, unknown>>
    return {
      answers: Array.isArray(answers) ? answers : [],
      errors: Array.isArray(errors)
        ? errors.filter((error): error is string => typeof error === 'string')
        : [],
    }
  }

  /**
   * The plugins an event may be sent to: those whose manifests name it and that hold the
   * permission it needs, but for one that crashed too often.
   */
  subscribers(event: string, permission: string): { id: string; permissions: readonly string[] }[] {
    const out: { id: string; permissions: readonly string[] }[] = []
    for (const [id, plugin] of this.plugins) {
      const permissions = this.grants.get(id) ?? []
      if (!plugin.activation.includes(event) || !permissions.includes(permission)) continue
      if (this.statuses.get(id)?.state === 'disabled') continue
      out.push({ id, permissions })
    }
    return out
  }

  /** Lets a plugin that crashed too often be woken again. */
  async enable(pluginId: string): Promise<void> {
    if (this.statuses.get(pluginId)?.state !== 'disabled') return
    if (this.port) await this.request({ type: 'enable', pluginId })
    else this.statuses.delete(pluginId)
    this.changed()
  }

  /** Every plugin that was woken since the agent host started, with why one is disabled. */
  status(): PluginStatus[] {
    return [...this.statuses.values()]
  }

  /** The plugin host's port, when the process is ready; it replaces the one before it. */
  attach(port: PortChannel<AgentToPluginHost>): void {
    if (this.stopped || !this.wanted) {
      port.close()
      return
    }
    this.detach()
    this.port = port
    port.onClose(() => {
      if (this.port !== port) return
      this.options.log('warn', 'The plugin host is gone; its plugins load again when woken')
      this.detach()
      this.settleIdle()
    })
    port.onMessage((data) => this.receive(port, data))
    const disabled = this.status()
      .filter((plugin) => plugin.state === 'disabled')
      .map(({ id, reason }) => ({ id, reason }))
    if (disabled.length > 0) port.send({ type: 'restore', disabled })
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    this.waiters.clear()
    this.settleIdle()
  }

  /** Unloads every plugin and lets the plugin host go, for good. */
  stop(): void {
    this.stopped = true
    this.release()
  }

  private release(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(unavailable('The plugin host is stopping'))
    }
    this.waiters.clear()
    const port = this.port
    this.detach()
    port?.close()
    if (this.wanted) this.options.want(false)
    this.wanted = false
  }

  /** Drops the port: what waited on it fails, and no plugin is loaded any more. */
  private detach(): void {
    this.port = null
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(unavailable('The plugin host stopped'))
    }
    // Only a disabled plugin outlives the process that held it.
    this.statuses = new Map([...this.statuses].filter(([, plugin]) => plugin.state === 'disabled'))
    this.changed()
  }

  private request(message: Request): Promise<unknown> {
    const port = this.port
    if (!port) {
      return Promise.reject(
        new PluginRequestError({ code: 'not_active', message: 'Nothing has woken the plugin yet' }),
      )
    }
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequest++
      this.pending.set(requestId, { resolve, reject })
      port.send({ ...message, requestId } as AgentToPluginHost)
    })
  }

  private receive(port: PortChannel<AgentToPluginHost>, data: unknown): void {
    if (port !== this.port || typeof data !== 'object' || data === null) return
    const message = data as PluginHostToAgent
    switch (message.type) {
      case 'answer': {
        const pending = this.pending.get(message.requestId)
        if (!pending) return
        this.pending.delete(message.requestId)
        if (!('error' in message)) pending.resolve(message.result)
        else if (isPluginError(message.error)) pending.reject(new PluginRequestError(message.error))
        else pending.reject(new PluginRequestError({ code: 'failed', message: 'Unknown error' }))
        return
      }
      case 'status': {
        if (!Array.isArray(message.plugins)) return
        this.statuses = new Map(
          message.plugins.filter((plugin) => isPluginId(plugin?.id)).map((p) => [p.id, p]),
        )
        this.changed()
        this.settleIdle()
        return
      }
      case 'function-call':
        this.answerFunction(port, message)
        return
    }
  }

  private answerFunction(
    port: PortChannel<AgentToPluginHost>,
    message: Extract<PluginHostToAgent, { type: 'function-call' }>,
  ): void {
    const { callId, pluginId, name, args } = message
    if (!Number.isSafeInteger(callId)) return
    const fail = (error: PluginError): void => port.send({ type: 'function-result', callId, error })
    const functions = this.options.functions
    if (
      !isPluginId(pluginId) ||
      !this.plugins.has(pluginId) ||
      typeof name !== 'string' ||
      !Array.isArray(args) ||
      !Object.hasOwn(functions, name)
    ) {
      fail({ code: 'unknown_function', message: `No host function "${String(name)}"` })
      return
    }
    const call = functions[name]!
    const permissions = this.grants.get(pluginId) ?? []
    const missing = missingPermission(call.permission, permissions)
    if (missing !== null) {
      fail({
        code: 'permission_denied',
        message: `"${name}" needs the permission "${missing}", which this plugin does not have`,
      })
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    Promise.race([
      Promise.resolve().then(() => call.run({ pluginId, permissions }, args)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('It took too long')), PLUGIN_ANSWER_TIMEOUT_MS)
      }),
    ])
      .then(
        (result) => port.send({ type: 'function-result', callId, result: result ?? null }),
        (error: unknown) =>
          fail({ code: 'failed', message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => clearTimeout(timer))
  }

  /**
   * With no plugin loaded, the process is let go after a while. It holds the plugins' recent
   * crashes, so it stays until those are too old to count.
   */
  private settleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const plugins = this.status()
    if (this.stopped || !this.wanted || plugins.some((plugin) => plugin.state === 'active')) return
    const crashed = plugins.some((plugin) => plugin.state === 'idle' && plugin.crashes > 0)
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = null
        this.options.log('info', 'No plugin is loaded; the plugin host may stop')
        this.release()
      },
      crashed
        ? Math.max(this.timings.idleStopMs, this.timings.crashWindowMs)
        : this.timings.idleStopMs,
    )
  }

  private changed(): void {
    this.options.onStatus?.(this.status())
  }
}
