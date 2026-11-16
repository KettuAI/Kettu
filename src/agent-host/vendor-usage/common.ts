import type { PlanLimit, ProviderBalance } from '@shared/agent-host'

export interface VendorUsage {
  tier?: string
  limits: PlanLimit[]
  balances: ProviderBalance[]
}

export function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function number(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

/** Unix seconds, Unix milliseconds or an RFC 3339 string, as milliseconds. */
export function time(value: unknown): number | null {
  const parsed = number(value)
  if (parsed !== null) return parsed > 0 ? (parsed < 1e12 ? parsed * 1000 : parsed) : null
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

export function amountLimit(
  window: string,
  label: string,
  used: number,
  total: number,
  unit: string,
  now: number,
  resetsAt: number | null = null,
): PlanLimit {
  return {
    window,
    label,
    usedPercent: total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : null,
    resetsAt,
    state: total > 0 && used >= total ? 'reached' : 'ok',
    observedAt: now,
    amount: { used, total, unit },
  }
}

export function percentLimit(
  window: string,
  label: string,
  percent: number,
  now: number,
  resetsAt: number | null = null,
): PlanLimit {
  const usedPercent = Math.max(0, Math.min(100, percent))
  return {
    window,
    label,
    usedPercent,
    resetsAt,
    state: usedPercent >= 100 ? 'reached' : 'ok',
    observedAt: now,
  }
}

export function balance(label: string, amount: number, currency: string): ProviderBalance {
  return { label, amount, currency }
}

/** A response's text, refused past `maxBytes` without reading the rest. */
export async function readBody(response: Response, maxBytes = 64 * 1024): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) throw new Error('too large')
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error('too large')
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
      if (size > maxBytes) {
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
