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
