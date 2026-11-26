import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { PlanLimit } from '@shared/agent-host'
import { t } from '../i18n'
import { amountLimit, balance, number, object, type VendorUsage } from './common'
import { requestOverStdio } from './stdio-rpc'

const DEFAULT_TIMEOUT_MS = 20_000
const DAEMON_PROTOCOL_VERSION = 2
const SDK_VERSION = '0.1.0'
const INITIALIZE_CAPABILITIES = ['multi_session_v2', 'daemon_queries_v1']
const QODERCLI_AUTH = { type: 'qodercli' } as const

class ControlRpcError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

class LegacyProtocolFallback extends Error {
  readonly reason: 'protocol' | 'exit' | 'timeout'
  readonly causeError: Error

  constructor(reason: 'protocol' | 'exit' | 'timeout', causeError: Error) {
    super(causeError.message)
    this.reason = reason
    this.causeError = causeError
  }
}

interface PendingControlRequest {
  id: string
  isInitialize: boolean
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function needsExplicitAuthenticate(error: ControlRpcError): boolean {
  return error.code === 'AUTH_PAYLOAD_REQUIRED' || /daemon has no credentials/i.test(error.message)
}

function isLegacyFallbackErrorCode(code: string | undefined): boolean {
  return code === 'PROTOCOL_VERSION_UNSUPPORTED' || code === 'METHOD_NOT_FOUND'
}

/**
 * Queries Qoder's `--sdk` daemon over its v2 NDJSON control framing.
 *
 * Pre-handshake protocol mismatches, exits, or handshake timeouts throw
 * `LegacyProtocolFallback` so the caller can fall back to the legacy
 * Content-Length JSON-RPC transport.
 */
async function requestQoderControlUsage(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  handshakeTimeoutMs: number,
): Promise<unknown> {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const decoder = new StringDecoder('utf8')
  const deadline = Date.now() + timeoutMs

  let buffer = ''
  let nextRequestId = 0
  let initialized = false
  let pending: PendingControlRequest | null = null
  let failure: Error | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const failConnection = (error: Error): void => {
    if (failure) return
    failure = error
    clearTimer()
    const current = pending
    pending = null
    current?.reject(error)
  }

  const armTimer = (ms: number, onTimeout: () => Error): void => {
    clearTimer()
    timer = setTimeout(() => failConnection(onTimeout()), Math.max(1, ms))
  }

  const handleLine = (rawLine: string): void => {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line || failure) return

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      const badFrame = new Error(t('usageRead.rpc.badFrame'))
      failConnection(initialized ? badFrame : new LegacyProtocolFallback('protocol', badFrame))
      return
    }

    const frame = object(parsed)
    if (!frame) {
      const badFrame = new Error(t('usageRead.rpc.badFrame'))
      failConnection(initialized ? badFrame : new LegacyProtocolFallback('protocol', badFrame))
      return
    }

    if (!initialized && (frame.jsonrpc === '2.0' || frame.protocol_version === 1)) {
      failConnection(new LegacyProtocolFallback('protocol', new Error(t('usageRead.rpc.badFrame'))))
      return
    }

    if (frame.type === 'protocol_error') {
      const message =
        typeof frame.message === 'string' && frame.message.trim()
          ? frame.message.trim()
          : typeof frame.code === 'string' && frame.code.trim()
            ? frame.code.trim()
            : t('usageRead.rpc.badFrame')
      const protocolError = new Error(message)
      failConnection(
        initialized ? protocolError : new LegacyProtocolFallback('protocol', protocolError),
      )
      return
    }

    if (frame.type !== 'control_response') return

    const response = object(frame.response)
    if (!response) {
      const badFrame = new Error(t('usageRead.rpc.badFrame'))
      failConnection(initialized ? badFrame : new LegacyProtocolFallback('protocol', badFrame))
      return
    }

    const replyId = response.request_id ?? frame.request_id
    if (!pending || (typeof replyId !== 'string' && typeof replyId !== 'number')) return
    if (String(replyId) !== pending.id) return

    const current = pending
    pending = null

    if (response.subtype === 'success') {
      if (current.isInitialize) {
        initialized = true
        armTimer(deadline - Date.now(), () => new Error(t('usageRead.rpc.timedOut')))
      }
      current.resolve(response.response)
      return
    }

    if (response.subtype === 'error') {
      const message =
        typeof response.error === 'string' && response.error.trim()
          ? response.error.trim()
          : t('usageRead.rpc.failed')
      const code = typeof response.code === 'string' && response.code ? response.code : undefined
      const rpcError = new ControlRpcError(message, code)
      if (current.isInitialize && isLegacyFallbackErrorCode(code)) {
        current.reject(new LegacyProtocolFallback('protocol', rpcError))
      } else {
        current.reject(rpcError)
      }
      return
    }

    const badFrame = new Error(t('usageRead.rpc.badFrame'))
    failConnection(initialized ? badFrame : new LegacyProtocolFallback('protocol', badFrame))
  }

  const drainLines = (flush: boolean): void => {
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      handleLine(line)
      if (failure) return
    }
    if (flush) {
      buffer += decoder.end()
      if (buffer) {
        const tail = buffer
        buffer = ''
        handleLine(tail)
      }
    }
  }

  const sendRequest = (
    method: string,
    params: Record<string, unknown> = {},
    isInitialize = false,
  ): Promise<unknown> => {
    if (failure) return Promise.reject(failure)
    nextRequestId += 1
    const id = String(nextRequestId)
    const frame = {
      type: 'control_request',
      request_id: id,
      request: {
        type: method,
        ...params,
      },
    }
    return new Promise<unknown>((resolve, reject) => {
      pending = { id, isInitialize, resolve, reject }
      child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  // Suppress EPIPE when the child exits before stdin finishes flushing; the close event reports it.
  child.stdin.on('error', () => {})
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    drainLines(false)
  })
  child.stdout.once('end', () => {
    drainLines(true)
  })
  child.once('error', (error) => {
    failConnection(error)
  })
  child.once('close', (code) => {
    const exitError = new Error(t('usageRead.rpc.exited', { code: String(code) }))
    failConnection(initialized ? exitError : new LegacyProtocolFallback('exit', exitError))
  })

  armTimer(
    handshakeTimeoutMs,
    () => new LegacyProtocolFallback('timeout', new Error(t('usageRead.rpc.timedOut'))),
  )

  try {
    await sendRequest(
      'daemon.initialize',
      {
        daemon_protocol_version: DAEMON_PROTOCOL_VERSION,
        sdk_version: SDK_VERSION,
        capabilities: INITIALIZE_CAPABILITIES,
        auth: QODERCLI_AUTH,
      },
      true,
    )

    try {
      return await sendRequest('daemon.get_usage_info')
    } catch (error) {
      if (!(error instanceof ControlRpcError) || !needsExplicitAuthenticate(error)) throw error
      const authReply = object(await sendRequest('daemon.authenticate', { auth: QODERCLI_AUTH }))
      if (authReply?.authenticated === false) throw error
      return await sendRequest('daemon.get_usage_info')
    }
  } finally {
    clearTimer()
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

export function parseQoderUsage(value: unknown, now: number): VendorUsage | null {
  const body = object(value)
  const usage = object(body?.accountUsage) ?? object(body?.usage) ?? object(body?.data) ?? body
  if (!usage) return null
  const quota = object(usage?.userQuota) ?? object(usage?.quota) ?? usage
  if (!quota) return null
  const total = number(quota.total ?? quota.credits_total ?? quota.total_credits)
  const remainingQuota = number(quota.remaining)
  const used =
    number(quota.used ?? quota.credits_used ?? quota.used_credits) ??
    (total !== null && remainingQuota !== null ? Math.max(0, total - remainingQuota) : null)
  if (used === null || total === null || total <= 0) return null
  const limits: PlanLimit[] = [amountLimit('monthly', 'Monthly', used, total, 'credits', now)]
  const addOn = object(usage.addOnQuota ?? usage.add_on_quota)
  const remaining = number(addOn?.remaining)
  const balances = remaining === null ? [] : [balance('Add-on credits', remaining, 'credits')]
  return { tier: typeof usage.plan === 'string' ? usage.plan : undefined, limits, balances }
}

export async function readQoderUsage(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  now: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VendorUsage | null> {
  const deadline = Date.now() + timeoutMs
  const handshakeTimeoutMs = Math.min(timeoutMs, Math.max(1, Math.floor(timeoutMs * 0.6)))
  let reply: unknown
  try {
    reply = await requestQoderControlUsage(command, args, env, timeoutMs, handshakeTimeoutMs)
  } catch (error) {
    if (!(error instanceof LegacyProtocolFallback)) throw error
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw error.causeError
    try {
      reply = await requestOverStdio(
        command,
        args,
        env,
        [{ method: 'daemon.initialize' }, { method: 'daemon.get_usage_info' }],
        remainingMs,
      )
    } catch (legacyError) {
      if (
        error.reason === 'timeout' &&
        legacyError instanceof Error &&
        legacyError.message === t('usageRead.rpc.badFrame')
      ) {
        throw error.causeError
      }
      throw legacyError
    }
  }
  const parsed = parseQoderUsage(reply, now)
  if (parsed) return parsed
  const usageError = object(reply)?.usage_error
  if (typeof usageError === 'string' && usageError.trim()) {
    throw new Error(usageError.trim())
  }
  return null
}
