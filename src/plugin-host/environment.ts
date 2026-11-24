// One plugin's script in an engine of its own. The script sees no host object: it gets `kettu`,
// `console`, `setTimeout`, `clearTimeout`, `module` and `exports`, which the bootstrap below
// builds inside the engine over five host functions that take and return only numbers and
// strings. Every value crosses as JSON text of a bounded size, and every entry into the script
// runs against a deadline.

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten-core'
import type { LogLevel } from '@shared/log/process-log'
import {
  PLUGIN_ANSWER_TIMEOUT_MS,
  PLUGIN_BEFORE_SEND_DEADLINE_MS,
  PLUGIN_CALL_DEADLINE_MS,
  PLUGIN_LOG_LINE_CHARS,
  PLUGIN_MEMORY_LIMIT_BYTES,
  PLUGIN_MESSAGE_LIMIT_CHARS,
  PLUGIN_PENDING_LIMIT,
  PLUGIN_STACK_LIMIT_BYTES,
  PluginRequestError,
  type PluginCrashReason,
  type PluginDeadline,
  type PluginHookReply,
} from '@shared/plugin-host'
import type { Engine } from './engine'

export interface EnvironmentLimits {
  callMs: number
  beforeSendMs: number
  answerMs: number
  memoryBytes: number
  stackBytes: number
  messageChars: number
  pending: number
}

export const DEFAULT_LIMITS: EnvironmentLimits = {
  callMs: PLUGIN_CALL_DEADLINE_MS,
  beforeSendMs: PLUGIN_BEFORE_SEND_DEADLINE_MS,
  answerMs: PLUGIN_ANSWER_TIMEOUT_MS,
  memoryBytes: PLUGIN_MEMORY_LIMIT_BYTES,
  stackBytes: PLUGIN_STACK_LIMIT_BYTES,
  messageChars: PLUGIN_MESSAGE_LIMIT_CHARS,
  pending: PLUGIN_PENDING_LIMIT,
}

export interface EnvironmentOptions {
  engine: Engine
  /** Answers a host function the script calls; a rejection reaches the script as an error. */
  callHost(name: string, args: unknown[]): unknown
  log(level: LogLevel, text: string): void
  /** The script passed a limit; the environment is already disposed. */
  onCrash(reason: PluginCrashReason): void
  limits?: Partial<EnvironmentLimits>
}

const OUT_OF_MEMORY = 'InternalError: out of memory'
const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error']
const MAX_TIMER_MS = 2 ** 31 - 1
// What a hook keeps of the listeners that threw: how many messages, and how long each.
const HOOK_ERRORS_KEPT = 5
const HOOK_ERROR_CHARS = 500

// Runs inside the engine, before the plugin's script. `native` holds the host functions, which
// only this closure keeps; it returns the one function the host enters the script through.
const BOOTSTRAP = `(function (native) {
  'use strict'
  const module = { exports: {} }
  const pending = new Map()
  const timers = new Map()
  const listeners = new Map()
  let nextId = 1
  const json = (value) => {
    const text = JSON.stringify(value)
    return text === undefined ? 'null' : text
  }
  const describe = (error) => {
    try {
      return error instanceof Error ? error.name + ': ' + error.message : String(error)
    } catch {
      return 'Error'
    }
  }
  const outOfMemory = (error) => describe(error) === '${OUT_OF_MEMORY}'
  const format = (args) =>
    args
      .map((arg) => {
        if (typeof arg === 'string') return arg
        if (arg instanceof Error) return arg.stack ? describe(arg) + '\\n' + arg.stack : describe(arg)
        try {
          return json(arg)
        } catch {
          return String(arg)
        }
      })
      .join(' ')
  const print = (level) => (...args) => native.log(level, format(args))
  globalThis.module = module
  globalThis.exports = module.exports
  globalThis.console = Object.freeze({
    log: print('info'),
    info: print('info'),
    warn: print('warn'),
    error: print('error'),
    debug: print('debug'),
  })
  globalThis.kettu = Object.freeze({
    call(name, ...args) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, [resolve, reject])
        try {
          native.call(id, String(name), json(args))
        } catch (error) {
          pending.delete(id)
          reject(error)
        }
      })
    },
    on(name, listener) {
      if (typeof listener !== 'function') throw new TypeError('The listener must be a function')
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
  })
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('The callback must be a function')
    const id = nextId++
    native.timer(id, Number(ms) || 0)
    timers.set(id, () => callback(...args))
    return id
  }
  globalThis.clearTimeout = (id) => {
    if (timers.delete(id)) native.clearTimer(id)
  }
  const fail = (callId, error) => native.settle(callId, 0, describe(error))
  return (kind, a, b, c) => {
    if (kind === 'result') {
      const entry = pending.get(a)
      if (!entry) return
      pending.delete(a)
      if (b) entry[0](JSON.parse(c))
      else entry[1](new Error(c))
    } else if (kind === 'timer') {
      const run = timers.get(a)
      if (!run) return
      timers.delete(a)
      run()
    } else if (kind === 'event') {
      const set = listeners.get(a)
      if (!set) return
      const payload = JSON.parse(b)
      const failed = (error) => native.log('error', 'A listener of "' + a + '" failed: ' + describe(error))
      for (const listener of [...set]) {
        try {
          const result = listener(payload)
          if (result && typeof result.then === 'function') result.then(undefined, failed)
        } catch (error) {
          if (outOfMemory(error)) throw error
          failed(error)
        }
      }
    } else if (kind === 'hook') {
      const set = listeners.get(b)
      const payload = JSON.parse(c)
      const errors = []
      const failed = (error) => {
        const text = describe(error)
        if (errors.length < ${HOOK_ERRORS_KEPT}) errors.push(text.slice(0, ${HOOK_ERROR_CHARS}))
        native.log('error', 'A listener of "' + b + '" failed: ' + text)
      }
      const runs = []
      for (const listener of set ? [...set] : []) {
        try {
          runs.push(Promise.resolve(listener(payload)))
        } catch (error) {
          if (outOfMemory(error)) throw error
          failed(error)
        }
      }
      Promise.allSettled(runs).then((settled) => {
        const answers = []
        for (const one of settled) {
          if (one.status === 'fulfilled') answers.push(one.value === undefined ? null : one.value)
          else failed(one.reason)
        }
        let text
        try {
          text = json({ answers, errors })
        } catch (error) {
          fail(a, error)
          return
        }
        native.settle(a, 1, text)
      })
    } else if (kind === 'call') {
      const exported = module.exports
      const fn =
        exported !== null && typeof exported === 'object' && Object.hasOwn(exported, b)
          ? exported[b]
          : undefined
      if (typeof fn !== 'function') {
        native.settle(a, 0, 'The plugin exports no function "' + b + '"')
        return
      }
      let value
      try {
        value = fn(...JSON.parse(c))
      } catch (error) {
        if (outOfMemory(error)) throw error
        fail(a, error)
        return
      }
      Promise.resolve(value).then((settled) => {
        let text
        try {
          text = json(settled)
        } catch (error) {
          fail(a, error)
          return
        }
        native.settle(a, 1, text)
      }, (error) => fail(a, error))
    }
  }
})`

interface PendingCall {
  resolve(value: unknown): void
  reject(error: PluginRequestError): void
  timer: NodeJS.Timeout
}

function failure(code: PluginRequestError['code'], message: string): PluginRequestError {
  return new PluginRequestError({ code, message })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PluginEnvironment {
  private readonly limits: EnvironmentLimits
  private readonly calls = new Map<number, PendingCall>()
  private readonly timers = new Map<number, NodeJS.Timeout>()
  private nextCall = 1
  private hostCalls = 0
  private deadline = Infinity
  private interrupted = false
  private outOfMemory = false
  private disposed = false

  private constructor(
    private readonly options: EnvironmentOptions,
    private readonly runtime: QuickJSRuntime,
    private readonly vm: QuickJSContext,
    private readonly entry: QuickJSHandle,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
  }

  /**
   * A new engine with `source` run in it. Rejects when the script throws as it loads; when it
   * passes a limit it also reports the crash.
   */
  static async create(options: EnvironmentOptions, source: string): Promise<PluginEnvironment> {
    const limits = { ...DEFAULT_LIMITS, ...options.limits }
    const runtime = (await options.engine.instantiate()).newRuntime()
    runtime.setMemoryLimit(limits.memoryBytes)
    runtime.setMaxStackSize(limits.stackBytes)
    const vm = runtime.newContext()
    // Set before the environment exists, so the handler and the host functions can name it.
    const self: { current: PluginEnvironment | null } = { current: null }
    runtime.setInterruptHandler(() => self.current?.overdue() ?? false)
    const native = vm.newObject()
    const expose = (
      name: string,
      run: (env: PluginEnvironment, ...args: QuickJSHandle[]) => void,
    ) =>
      vm
        .newFunction(name, (...args) => {
          if (self.current) run(self.current, ...args)
          return vm.undefined
        })
        .consume((handle) => vm.setProp(native, name, handle))
    expose('call', (env, id, name, json) =>
      env.hostCall(vm.getNumber(id!), vm.getString(name!), vm.getString(json!)),
    )
    expose('settle', (env, id, ok, text) =>
      env.settle(vm.getNumber(id!), vm.getNumber(ok!) === 1, vm.getString(text!)),
    )
    expose('timer', (env, id, ms) => env.startTimer(vm.getNumber(id!), vm.getNumber(ms!)))
    expose('clearTimer', (env, id) => env.clearTimer(vm.getNumber(id!)))
    expose('log', (env, level, text) => env.guestLog(vm.getString(level!), vm.getString(text!)))
    const boot = vm.unwrapResult(vm.evalCode(BOOTSTRAP, 'kettu:bootstrap'))
    const entry = vm.unwrapResult(vm.callFunction(boot, vm.undefined, native))
    boot.dispose()
    native.dispose()
    const environment = new PluginEnvironment(options, runtime, vm, entry)
    self.current = environment
    const failed = environment.enter(limits.callMs, () => vm.evalCode(source, 'plugin.js'))
    if (failed !== null) {
      const crashed = environment.disposed
      environment.dispose()
      throw failure(crashed ? 'crashed' : 'failed', `The plugin's script failed to load: ${failed}`)
    }
    return environment
  }

  /** Calls a function the script exported, with the answer it returns or resolves to. */
  call(name: string, args: unknown[], deadline: PluginDeadline): Promise<unknown> {
    return this.request('call', name, args, deadline === 'before-send')
  }

  /**
   * Asks the listeners the script registered for an event, within the hook deadline unless
   * `deadline` is `call`: what each returned or resolved to, in the order they were added. A
   * listener that throws is left out of the answers and its message is kept beside them.
   */
  hook(
    name: string,
    payload: unknown,
    deadline: PluginDeadline = 'before-send',
  ): Promise<PluginHookReply> {
    return this.request(
      'hook',
      name,
      payload ?? null,
      deadline === 'before-send',
    ) as Promise<PluginHookReply>
  }

  private request(
    kind: 'call' | 'hook',
    name: string,
    value: unknown,
    quick: boolean,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(failure('crashed', 'The plugin has stopped'))
    let text: string
    try {
      text = this.encode(value)
    } catch (error) {
      return Promise.reject(error as Error)
    }
    const answerMs = quick ? this.limits.beforeSendMs : this.limits.answerMs
    return new Promise((resolve, reject) => {
      const id = this.nextCall++
      const timer = setTimeout(() => {
        this.calls.delete(id)
        this.options.log('warn', `"${name}" did not answer within ${answerMs} ms`)
        reject(failure('timeout', `The plugin did not answer within ${answerMs} ms`))
      }, answerMs)
      this.calls.set(id, { resolve, reject, timer })
      const failed = this.dispatch(quick ? this.limits.beforeSendMs : this.limits.callMs, [
        kind,
        id,
        name,
        text,
      ])
      if (failed !== null) this.finish(id)?.reject(failure('failed', failed))
    })
  }

  /** Delivers an event to the listeners the script registered for it. */
  event(name: string, payload: unknown): void {
    if (this.disposed) throw failure('crashed', 'The plugin has stopped')
    const failed = this.dispatch(this.limits.callMs, ['event', name, this.encode(payload ?? null)])
    if (failed === null) return
    throw failure(this.disposed ? 'crashed' : 'failed', failed)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const id of [...this.calls.keys()]) {
      this.finish(id)?.reject(failure('crashed', 'The plugin has stopped'))
    }
    for (const part of [this.entry, this.vm, this.runtime]) {
      try {
        part.dispose()
      } catch (error) {
        // The engine's instance is dropped with it either way.
        this.options.log('debug', `Could not release the engine cleanly: ${errorText(error)}`)
      }
    }
  }

  private overdue(): boolean {
    if (performance.now() <= this.deadline) return false
    this.interrupted = true
    return true
  }

  private encode(value: unknown): string {
    const text = JSON.stringify(value) ?? 'null'
    if (text.length > this.limits.messageChars) {
      throw failure('too_large', `A value of ${text.length} characters is too large to pass`)
    }
    return text
  }

  private dispatch(limitMs: number, args: (string | number)[]): string | null {
    return this.enter(limitMs, () => {
      const handles = args.map((arg) =>
        typeof arg === 'string' ? this.vm.newString(arg) : this.vm.newNumber(arg),
      )
      try {
        return this.vm.callFunction(this.entry, this.vm.undefined, ...handles)
      } finally {
        for (const handle of handles) handle.dispose()
      }
    })
  }

  /**
   * Runs the script through `run` and then the jobs it queued, all against one deadline. Returns
   * what it threw, or null; an environment that passed a limit is disposed and reported.
   */
  private enter(
    limitMs: number,
    run: () => ReturnType<QuickJSContext['callFunction']>,
  ): string | null {
    if (this.disposed) return 'The plugin has stopped'
    let failed: string | null = null
    this.interrupted = false
    this.deadline = performance.now() + limitMs
    try {
      const result = run()
      if (result.error) failed = this.thrown(result.error)
      else result.value.dispose()
      if (failed === null) {
        const jobs = this.runtime.executePendingJobs()
        if (jobs.error) failed = this.thrown(jobs.error)
      }
    } catch (error) {
      // The engine could not even take the arguments, which happens when its memory is full.
      this.outOfMemory = true
      failed = errorText(error)
    } finally {
      this.deadline = Infinity
    }
    if (this.interrupted) {
      this.crash('deadline')
      return `It ran longer than ${limitMs} ms and was stopped`
    }
    if (this.outOfMemory) {
      this.crash('memory')
      return 'It used more memory than a plugin may and was stopped'
    }
    return failed
  }

  private thrown(error: QuickJSHandle): string {
    let text: string
    try {
      const dumped: unknown = this.vm.dump(error)
      if (dumped === null) text = OUT_OF_MEMORY
      else if (typeof dumped === 'object') {
        const { name, message } = dumped as { name?: unknown; message?: unknown }
        text = `${typeof name === 'string' ? name : 'Error'}: ${String(message ?? '')}`
      } else text = String(dumped)
    } catch {
      text = 'Error'
    }
    error.dispose()
    if (text === OUT_OF_MEMORY) this.outOfMemory = true
    return text
  }

  private crash(reason: PluginCrashReason): void {
    if (this.disposed) return
    this.dispose()
    this.options.onCrash(reason)
  }

  private finish(id: number): PendingCall | null {
    const call = this.calls.get(id)
    if (!call) return null
    this.calls.delete(id)
    clearTimeout(call.timer)
    return call
  }

  // The host functions. Each is called from inside the script, so it never enters the script
  // itself, and throws only what the script may see.

  private hostCall(id: number, name: string, json: string): void {
    if (this.hostCalls >= this.limits.pending) throw new Error('Too many calls wait for an answer')
    if (json.length > this.limits.messageChars) throw new Error('The arguments are too large')
    const args: unknown = JSON.parse(json)
    if (!Array.isArray(args)) throw new Error('The arguments must be a list')
    this.hostCalls++
    const answer = (ok: boolean, text: string): void => {
      this.hostCalls--
      if (this.disposed) return
      const failed = this.dispatch(this.limits.callMs, ['result', id, ok ? 1 : 0, text])
      if (failed !== null) this.options.log('error', failed)
    }
    Promise.resolve()
      .then(() => this.options.callHost(name, args))
      .then((value) => this.encode(value ?? null))
      .then(
        (text) => answer(true, text),
        (error: unknown) => answer(false, errorText(error)),
      )
  }

  private settle(id: number, ok: boolean, text: string): void {
    if (!ok && text === OUT_OF_MEMORY) this.outOfMemory = true
    // A script past a limit still runs its rejection handlers; the crash answers its calls.
    if (this.interrupted || this.outOfMemory) return
    const call = this.finish(id)
    if (!call) return
    if (!ok) return call.reject(failure('failed', text.slice(0, PLUGIN_LOG_LINE_CHARS)))
    if (text.length > this.limits.messageChars) {
      return call.reject(failure('too_large', 'The answer is too large to pass'))
    }
    try {
      call.resolve(JSON.parse(text))
    } catch {
      call.reject(failure('failed', 'The answer is not JSON'))
    }
  }

  private startTimer(id: number, ms: number): void {
    if (this.timers.size >= this.limits.pending) throw new Error('Too many timers')
    const delay = Math.min(Math.max(Number.isFinite(ms) ? ms : 0, 1), MAX_TIMER_MS)
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        const failed = this.dispatch(this.limits.callMs, ['timer', id])
        if (failed !== null) this.options.log('error', failed)
      }, delay),
    )
  }

  private clearTimer(id: number): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
  }

  private guestLog(level: string, text: string): void {
    this.options.log(
      LOG_LEVELS.includes(level) ? (level as LogLevel) : 'info',
      text.length > PLUGIN_LOG_LINE_CHARS ? `${text.slice(0, PLUGIN_LOG_LINE_CHARS)}...` : text,
    )
  }
}
