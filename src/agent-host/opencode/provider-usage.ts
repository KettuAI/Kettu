// OpenCode provider usage: the Console limits it reports itself, and the balance endpoints of the
// vendors whose keys it stores. Secrets stay in the request headers and never reach a result.

import type { AgentProvider, PlanLimit, ProviderBalance } from '@shared/agent-host'

export const USAGE_ERROR = 'Usage could not be read.'

export type ProviderUsage = NonNullable<AgentProvider['usage']>

export function unsupportedUsage(now: number): ProviderUsage {
  return { state: 'unsupported', limits: [], balances: [], observedAt: now, error: null }
}

export function failedUsage(now: number): ProviderUsage {
  return { state: 'error', limits: [], balances: [], observedAt: now, error: USAGE_ERROR }
}

function readyUsage(
  now: number,
  limits: PlanLimit[],
  balances: ProviderBalance[] = [],
): ProviderUsage {
  return { state: 'ready', limits, balances, observedAt: now, error: null }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function list(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A number, or a numeric string, as some billing APIs report amounts. */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function percent(value: unknown): number | null {
  const parsed = num(value)
  return parsed === null ? null : Math.min(100, Math.max(0, parsed))
}

/** Unix seconds, Unix milliseconds or an RFC 3339 string, as milliseconds. */
function instant(value: unknown): number | null {
  const parsed = num(value)
  if (parsed !== null) return parsed < 1e12 ? parsed * 1000 : parsed
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function limitState(used: number, limited: boolean): PlanLimit['state'] {
  if (limited || used >= 100) return 'reached'
  return 'ok'
}

function limit(
  window: string,
  label: string,
  used: number,
  resetsAt: number | null,
  now: number,
  limited = false,
): PlanLimit {
  return {
    window,
    label,
    usedPercent: used,
    resetsAt,
    state: limitState(used, limited),
    observedAt: now,
  }
}

const WINDOWS = [
  ['rolling', 'Rolling'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
] as const

function goLimits(go: Record<string, unknown>, now: number): PlanLimit[] {
  const limits: PlanLimit[] = []
  for (const [window, label] of WINDOWS) {
    const meter = record(go[window])
    if (!meter) continue
    const used = percent(meter.percent)
    if (used === null) continue
    limits.push(limit(window, label, used, instant(meter.resetsAt), now, meter.limited === true))
  }
  return limits
}

/** The Go allowance and Console budgets from OpenCode's own usage route. */
export function mapNativeUsage(value: unknown, now: number): ProviderUsage {
  if (value === null) return unsupportedUsage(now)
  const body = record(value)
  if (!body) return failedUsage(now)
  const workspace = record(body.workspace)
  if (!workspace || typeof workspace.id !== 'string') return failedUsage(now)

  const limits: PlanLimit[] = []
  const go = record(body.go)
  if (go) limits.push(...goLimits(go, now))
  for (const item of list(body.budgets) ?? []) {
    const budget = record(item)
    if (!budget) continue
    const id = text(budget.id)
    const total = num(budget.limit)
    const spent = num(budget.spent)
    if (!id || total === null || total <= 0 || spent === null) continue
    limits.push(
      limit(
        `budget_${id}`,
        'Monthly budget',
        percent((spent / total) * 100) ?? 0,
        instant(budget.resetsAt),
        now,
      ),
    )
  }
  return readyUsage(now, limits)
}

interface Endpoint {
  url: string
  headers(key: string): Record<string, string>
  parse(body: unknown, now: number): ProviderUsage | null
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

function goEndpoint(): Endpoint {
  return {
    url: 'https://opencode.ai/zen/go/v1/usage',
    headers: bearer,
    parse(body, now) {
      const root = record(body)
      if (!root) return null
      const usage = record(root.usage) ?? root
      const limits: PlanLimit[] = []
      for (const [window, label] of WINDOWS) {
        const meter = record(usage[window] ?? usage[`${window}Usage`])
        if (!meter) continue
        const used = percent(meter.percent)
        if (used === null) continue
        const status = text(meter.status)
        limits.push(
          limit(
            window,
            label,
            used,
            instant(meter.resetsAt),
            now,
            status !== null && status !== 'ok' && status !== 'warning',
          ),
        )
      }
      return limits.length > 0 ? readyUsage(now, limits) : failedUsage(now)
    },
  }
}

function deepSeekEndpoint(): Endpoint {
  return {
    url: 'https://api.deepseek.com/user/balance',
    headers: bearer,
    parse(body, now) {
      const root = record(body)
      const infos = root ? list(root.balance_infos) : null
      if (!infos) return null
      const balances: ProviderBalance[] = []
      for (const item of infos) {
        const info = record(item)
        const amount = num(info?.total_balance)
        const currency = text(info?.currency)
        if (amount === null || !currency) continue
        balances.push({ label: 'Balance', amount, currency })
      }
      return balances.length > 0 ? readyUsage(now, [], balances) : failedUsage(now)
    },
  }
}

function moonshotEndpoint(host: string, currency: string): Endpoint {
  return {
    url: `https://${host}/v1/users/me/balance`,
    headers: bearer,
    parse(body, now) {
      const root = record(body)
      if (!root) return null
      const code = num(root.code)
      if (code !== null && code !== 0) return null
      const data = record(root.data)
      const amount = num(data?.available_balance)
      if (amount === null) return null
      return readyUsage(now, [], [{ label: 'Balance', amount, currency }])
    },
  }
}

function openRouterEndpoint(): Endpoint {
  return {
    url: 'https://openrouter.ai/api/v1/credits',
    headers: bearer,
    parse(body, now) {
      const root = record(body)
      const data = root ? record(root.data) : null
      const credits = num(data?.total_credits)
      const used = num(data?.total_usage)
      if (credits === null || used === null) return null
      return readyUsage(now, [], [{ label: 'Balance', amount: credits - used, currency: 'USD' }])
    },
  }
}

function glmEndpoint(host: string): Endpoint {
  return {
    // Z.ai and GLM take the key as the authorization value, with no scheme.
    url: `https://${host}/api/monitor/usage/quota/limit`,
    headers: (key) => ({ authorization: key }),
    parse(body, now) {
      const root = record(body)
      if (!root) return null
      if (root.success === false) return null
      const code = num(root.code)
      if (code !== null && code !== 200) return null
      const data = record(root.data)
      const items = data ? list(data.limits) : null
      if (!items) return null
      const limits: PlanLimit[] = []
      for (const item of items) {
        const row = record(item)
        if (!row) continue
        const used = percent(row.percentage)
        if (used === null) continue
        const type = text(row.type)
        const unit = num(row.unit)
        let window = 'glm'
        let label = 'Usage'
        if (type === 'TIME_LIMIT') {
          window = 'tool_calls'
          label = 'Tool calls'
        } else if (type === 'TOKENS_LIMIT') {
          if (unit === 3) {
            window = 'five_hour'
            label = '5-hour'
          } else if (unit === 6) {
            window = 'seven_day'
            label = 'Weekly'
          } else {
            window = `tokens_${unit ?? 'other'}`
            label = 'Tokens'
          }
        } else if (type) {
          window = `glm_${type.toLowerCase()}`
        }
        limits.push(limit(window, label, used, instant(row.nextResetTime), now))
      }
      return limits.length > 0 ? readyUsage(now, limits) : unsupportedUsage(now)
    },
  }
}

function usedFrom(limitValue: unknown, usedValue: unknown, remainingValue: unknown): number | null {
  const total = num(limitValue)
  if (total === null || total <= 0) return null
  const used =
    num(usedValue) ?? (num(remainingValue) === null ? null : total - num(remainingValue)!)
  return used === null ? null : percent((used / total) * 100)
}

function kimiEndpoint(host: string): Endpoint {
  return {
    url: `https://${host}/coding/v1/usages`,
    headers: bearer,
    parse(body, now) {
      const root = record(body)
      if (!root) return null
      const limits: PlanLimit[] = []
      for (const item of list(root.limits) ?? []) {
        const row = record(item)
        const detail = record(row?.detail)
        if (!detail) continue
        const used = usedFrom(detail.limit, detail.used, detail.remaining)
        if (used === null) continue
        const window = record(row?.window)
        const duration = num(window?.duration)
        const unit = text(window?.timeUnit)
        const fiveHour = duration === 300 && unit === 'TIME_UNIT_MINUTE'
        limits.push(
          limit(
            fiveHour ? 'five_hour' : `kimi_${duration ?? 'other'}`,
            fiveHour ? '5-hour' : 'Usage',
            used,
            instant(detail.resetTime),
            now,
          ),
        )
      }
      const weekly = record(root.usage)
      if (weekly) {
        const used = usedFrom(weekly.limit, weekly.used, weekly.remaining)
        if (used !== null) {
          limits.push(limit('seven_day', 'Weekly', used, instant(weekly.resetTime), now))
        }
      }
      return limits.length > 0 ? readyUsage(now, limits) : unsupportedUsage(now)
    },
  }
}

function minimaxEndpoint(host: string): Endpoint {
  return {
    url: `https://${host}/v1/token_plan/remains`,
    headers: bearer,
    parse(body, now) {
      const root = record(body)
      if (!root) return null
      const base = record(root.base_resp)
      const code = base ? num(base.status_code) : null
      if (code !== null && code !== 0) return null
      const remains = list(root.model_remains)
      if (!remains) return null
      const rows = remains.flatMap((item) => {
        const row = record(item)
        return row ? [row] : []
      })
      // The text/coding pool drives the bars; the video pool has its own windows.
      const general = rows.find((row) => row.model_name === 'general')
      if (!general) return failedUsage(now)
      const limits: PlanLimit[] = []
      const remaining = num(general.current_interval_remaining_percent)
      if (remaining !== null) {
        limits.push(
          limit(
            'five_hour',
            '5-hour',
            percent(100 - remaining) ?? 0,
            instant(general.end_time),
            now,
          ),
        )
      }
      const weeklyRemaining = num(general.current_weekly_remaining_percent)
      if (weeklyRemaining !== null) {
        limits.push(
          limit(
            'weekly',
            'Weekly',
            percent(100 - weeklyRemaining) ?? 0,
            instant(general.weekly_end_time),
            now,
          ),
        )
      }
      return limits.length > 0 ? readyUsage(now, limits) : failedUsage(now)
    },
  }
}

const ENDPOINTS: Record<string, Endpoint> = {
  'opencode-go': goEndpoint(),
  deepseek: deepSeekEndpoint(),
  moonshotai: moonshotEndpoint('api.moonshot.ai', 'USD'),
  'moonshotai-cn': moonshotEndpoint('api.moonshot.cn', 'CNY'),
  openrouter: openRouterEndpoint(),
  zai: glmEndpoint('api.z.ai'),
  'zai-coding-plan': glmEndpoint('api.z.ai'),
  zhipuai: glmEndpoint('open.bigmodel.cn'),
  'zhipuai-coding-plan': glmEndpoint('open.bigmodel.cn'),
  'kimi-code-plan-global': kimiEndpoint('api.kimi.ai'),
  'kimi-code-plan-cn': kimiEndpoint('api.kimi.com'),
  'minimax-coding-plan': minimaxEndpoint('api.minimax.io'),
  'minimax-cn-coding-plan': minimaxEndpoint('api.minimaxi.com'),
}

export function hasUsageEndpoint(providerId: string): boolean {
  return Object.hasOwn(ENDPOINTS, providerId)
}

const MAX_BYTES = 64 * 1024
const DEFAULT_TIMEOUT = 8_000

async function readBody(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_BYTES) throw new Error('too large')
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('too large')
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export interface UsageQuery {
  providerId: string
  key: string
  now: number
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  /** Extra request headers, such as the Console workspace. */
  headers?: Record<string, string>
  /** A 403 answer means the provider has nothing to show, not a failure. */
  forbidden?: 'unsupported'
}

/** Asks one vendor endpoint. A failure is one generic error, never the answer or the key. */
export async function readProviderUsage(query: UsageQuery): Promise<ProviderUsage> {
  if (!Object.hasOwn(ENDPOINTS, query.providerId) || query.key === '') {
    return unsupportedUsage(query.now)
  }
  const endpoint = ENDPOINTS[query.providerId]!
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), query.timeoutMs ?? DEFAULT_TIMEOUT)
  try {
    const response = await (query.fetch ?? globalThis.fetch)(endpoint.url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...endpoint.headers(query.key),
        ...query.headers,
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 403 && query.forbidden === 'unsupported') {
      return unsupportedUsage(query.now)
    }
    if (!response.ok) return failedUsage(query.now)
    const body = JSON.parse(await readBody(response)) as unknown
    return endpoint.parse(body, query.now) ?? failedUsage(query.now)
  } catch {
    return failedUsage(query.now)
  } finally {
    clearTimeout(timer)
  }
}
