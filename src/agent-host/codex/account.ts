// Codex's account and plan limits in Kettu's terms, with the labels codex-acp gave them.

import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import { t } from '../i18n'
import type { GetAccountResponse, RateLimitSnapshot, RateLimitWindow } from './protocol'

const PLANS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

function planName(plan: string | null | undefined): string | null {
  if (!plan || plan === 'unknown') return null
  return PLANS[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1)
}

export function mapAccount(response: GetAccountResponse): AgentAccount {
  const account = response.account
  if (!account) {
    return response.requiresOpenaiAuth
      ? { kind: 'none', label: t('codex.account.none'), email: null }
      : { kind: 'gateway', label: t('codex.account.gateway'), email: null }
  }
  switch (account.type) {
    case 'chatgpt': {
      const plan = planName(account.planType)
      return { kind: 'account', label: plan ? `ChatGPT ${plan}` : 'ChatGPT', email: account.email }
    }
    case 'apiKey':
      return { kind: 'api_key', label: t('codex.account.apiKey'), email: null }
    case 'amazonBedrock':
      return { kind: 'external', label: 'AWS Bedrock', email: null }
    case 'gcp':
      return { kind: 'external', label: 'Google Cloud', email: null }
    default:
      return { kind: 'external', label: (account as { type: string }).type, email: null }
  }
}

const DAY_MINUTES = 24 * 60
const DEFAULT_POOL = 'codex'

/** A window's id and label by its length, as Codex's own `/status` names it. */
function windowOf(minutes: number | null): { window: string; label: string } | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null
  if (minutes === 300) return { window: 'five_hour', label: t('planWindow.five_hour') }
  if (minutes === 7 * DAY_MINUTES) return { window: 'seven_day', label: t('planWindow.seven_day') }
  if (minutes < 60) return { window: `${minutes}_minute`, label: `${minutes}-minute` }
  if (minutes < DAY_MINUTES) {
    const hours = Math.round(minutes / 60)
    return { window: `${hours}_hour`, label: `${hours}-hour` }
  }
  if (minutes < 7 * DAY_MINUTES) {
    const days = Math.round(minutes / DAY_MINUTES)
    return { window: `${days}_day`, label: `${days}-day` }
  }
  if (minutes <= 31 * DAY_MINUTES) return { window: 'monthly', label: t('planWindow.monthly') }
  return { window: 'annual', label: t('planWindow.annual') }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

function mapWindow(
  window: RateLimitWindow | null,
  pool: string | null,
  now: number,
): PlanLimit | null {
  if (!window) return null
  const named = windowOf(window.windowDurationMins)
  if (!named) return null
  const used = Math.min(100, Math.max(0, window.usedPercent))
  return {
    window: pool ? `${slug(pool)}_${named.window}` : named.window,
    label: pool ? `${named.label} · ${pool}` : named.label,
    usedPercent: used,
    resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
    state: used >= 100 ? 'reached' : 'ok',
    observedAt: now,
  }
}

/** The windows of one limit pool; pools other than Codex's own are named in the label. */
export function mapRateLimits(snapshot: RateLimitSnapshot, now: number): PlanLimit[] {
  const id = snapshot.limitId ?? DEFAULT_POOL
  const pool = id === DEFAULT_POOL ? null : (snapshot.limitName ?? id)
  return [snapshot.primary, snapshot.secondary]
    .map((window) => mapWindow(window, pool, now))
    .filter((limit) => limit !== null)
}
