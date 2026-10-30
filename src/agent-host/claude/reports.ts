// What Claude Code answers about the account, its plan limits and a session's context, in
// Kettu's terms. Claude Code works each out itself, without a request to the model.

import type { AgentAccount, ContextBreakdown, ContextList, PlanLimit } from '@shared/agent-host'
import { WINDOW_LABELS } from '../session-updates'
import type { AccountInfo, ContextUsageAnswer, UsageAnswer, UsageWindow } from './sdk'

const EXTERNAL_PROVIDERS: Record<string, string> = {
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Azure AI Foundry',
  anthropicAws: 'Anthropic on AWS',
  anthropicGoogleCloud: 'Anthropic on Google Cloud',
  mantle: 'Mantle',
}

/** The plan with exactly one "Claude": an older CLI reports `max`, a newer one `Claude Max`. */
function planLabel(plan: string): string {
  const titled = plan.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1))
  return /^claude(\s|$)/i.test(plan) ? titled : `Claude ${titled}`
}

/**
 * The account a session runs under, or null when Claude Code names none: a provider other than
 * Anthropic, then an API key, which pays before a subscription sign-in, then the subscription.
 */
export function mapAccount(info: AccountInfo | undefined): AgentAccount | null {
  if (!info) return null
  const { apiProvider, apiKeySource, subscriptionType } = info
  if (apiProvider === 'gateway')
    return { kind: 'gateway', label: 'Custom model gateway', email: null }
  if (apiProvider && apiProvider !== 'firstParty') {
    return { kind: 'external', label: EXTERNAL_PROVIDERS[apiProvider] ?? apiProvider, email: null }
  }
  if (apiKeySource && apiKeySource !== 'none') {
    return { kind: 'api_key', label: 'Anthropic API key', email: null }
  }
  if (subscriptionType) {
    return { kind: 'account', label: planLabel(subscriptionType), email: info.email ?? null }
  }
  return null
}

/**
 * The account `claude auth status --json` names, which also tells when Claude Code is signed out:
 * no login, no key and no other provider. A login without a profile names no one.
 */
export function mapAuthStatus(stdout: string): AgentAccount | null {
  let status: unknown
  try {
    status = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof status !== 'object' || status === null || Array.isArray(status)) return null
  const fields = status as Record<string, unknown>
  if (typeof fields.loggedIn !== 'boolean') return null
  const text = (name: string): string | undefined =>
    typeof fields[name] === 'string' ? fields[name] : undefined
  const info: AccountInfo = {}
  for (const name of ['apiProvider', 'apiKeySource', 'subscriptionType', 'email'] as const) {
    const value = text(name)
    if (value !== undefined) info[name] = value
  }
  const account = mapAccount(info)
  if (account || fields.loggedIn) return account
  return { kind: 'none', label: 'Not signed in', email: null }
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

function limit(window: string, label: string, value: UsageWindow, now: number): PlanLimit | null {
  const used =
    typeof value.utilization === 'number' && Number.isFinite(value.utilization)
      ? Math.min(100, Math.max(0, value.utilization))
      : null
  const resets = value.resets_at ? Date.parse(value.resets_at) : NaN
  if (used === null && !Number.isFinite(resets)) return null
  return {
    window,
    label,
    usedPercent: used,
    resetsAt: Number.isFinite(resets) ? resets : null,
    state: used !== null && used >= 100 ? 'reached' : 'ok',
    observedAt: now,
  }
}

/**
 * The plan limits from Claude Code's usage answer. Window ids match the rate-limit events', so
 * the two merge; a per-model weekly window gets `seven_day_<model>`, as Claude Code's `/usage`
 * named it. An account without plan limits, such as an API key, gives none.
 */
export function mapUsageLimits(answer: UsageAnswer, now: number): PlanLimit[] {
  const limits = answer.rate_limits
  if (!answer.rate_limits_available || !limits) return []
  const out: PlanLimit[] = []
  const add = (item: PlanLimit | null): void => {
    if (item && !out.some((known) => known.window === item.window)) out.push(item)
  }
  for (const window of ['five_hour', 'seven_day'] as const) {
    const value = limits[window]
    if (value) add(limit(window, WINDOW_LABELS[window]!, value, now))
  }
  for (const scoped of limits.model_scoped ?? []) {
    if (!scoped?.display_name) continue
    const window = `seven_day_${slug(scoped.display_name)}`
    add(limit(window, WINDOW_LABELS[window] ?? `Weekly · ${scoped.display_name}`, scoped, now))
  }
  for (const window of ['seven_day_opus', 'seven_day_sonnet'] as const) {
    const value = limits[window]
    if (value) add(limit(window, WINDOW_LABELS[window]!, value, now))
  }
  return out
}

/** Tokens as Claude Code's `/context` writes them: `671`, `32.1k`, `1.2M`. */
export function compactTokens(tokens: number): string {
  const round = (value: number): string => value.toFixed(1).replace(/\.0$/, '')
  if (tokens >= 1_000_000) return `${round(tokens / 1_000_000)}M`
  if (tokens >= 1000) return `${round(tokens / 1000)}k`
  return String(Math.round(tokens))
}

/** What fills a session's context, from Claude Code's summary of it. */
export function mapContextUsage(answer: ContextUsageAnswer, now: number): ContextBreakdown {
  const size = answer.rawMaxTokens ?? answer.maxTokens
  const share = (tokens: number): number | null => (size > 0 ? tokens / size : null)
  const categories = answer.categories
    .filter((category) => !category.isDeferred)
    .map((category) => ({
      name: category.name,
      tokens: category.tokens,
      share: share(category.tokens),
    }))
  const lists: ContextList[] = []
  const list = (name: string, items: ContextList['items']): void => {
    if (items.length > 0) lists.push({ name, items })
  }
  list(
    'MCP Tools',
    (answer.mcpTools ?? [])
      .filter((tool) => tool.isLoaded !== false)
      .map((tool) => ({
        name: tool.name,
        detail: tool.serverName ?? null,
        tokens: compactTokens(tool.tokens),
      })),
  )
  list(
    'Custom Agents',
    (answer.agents ?? []).map((agent) => ({
      name: agent.agentType,
      detail: agent.source ?? null,
      tokens: compactTokens(agent.tokens),
    })),
  )
  list(
    'Memory Files',
    (answer.memoryFiles ?? []).map((file) => ({
      name: file.type ?? file.path,
      detail: file.type ? file.path : null,
      tokens: compactTokens(file.tokens),
    })),
  )
  list(
    'Skills',
    (answer.skills?.skillFrontmatter ?? []).map((skill) => ({
      name: skill.name,
      detail: skill.source ?? null,
      tokens: compactTokens(skill.tokens),
    })),
  )
  return {
    model: answer.model ?? null,
    used: answer.totalTokens,
    size,
    categories,
    lists,
    observedAt: now,
  }
}
