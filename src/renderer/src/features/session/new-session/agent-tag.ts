// The one short tag New session's agent menu writes at the end of a row: what stops the agent from
// starting a session now, or would soon.

import type { AgentStatus, PlanLimit, ProviderBalance } from '@shared/agent-host'
import { holdingLimit } from '@shared/plan-limits'
import type { ConfigOption } from '@shared/thread'
import { harnessProblem } from '@renderer/features/agents/harness-problem'
import { limitLabel, limitPhrase, resetDay, resetTime } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { limitPercent, type LimitView } from '@renderer/lib/plan-limit'
import { agentNeed } from './start-options'
import type { LineTone } from './picker'

export interface AgentTag {
  text: string
  tone: LineTone
  /** The whole sentence, shown while the pointer rests on the tag; null where the tag says all. */
  title: string | null
}

const tag = (text: string, tone: LineTone, title: string | null): AgentTag => ({
  text,
  tone,
  title,
})

// Names some windows go by besides the ones the interface knows.
const WINDOW_ALIASES: Readonly<Record<string, string>> = {
  rolling: 'five_hour',
  weekly: 'seven_day',
  '1_day': 'daily',
}

/**
 * A window under the names the interface knows: an OpenCode provider's `opencode:rolling` is its
 * 5-hour window.
 */
function plain(limit: PlanLimit): PlanLimit {
  const own = limit.window.slice(limit.window.indexOf(':') + 1)
  const window = WINDOW_ALIASES[own] ?? own
  if (window === limit.window) return limit
  const label = limit.window.includes(':')
    ? (limit.label.split(' · ').at(-1) ?? limit.label)
    : limit.label
  return { ...limit, window, label }
}

/** A window's short name for a tag: 5h, 7d, 30d, "Fable 7d". */
function windowName(limit: PlanLimit): string {
  const short = `composer:usage.shortWindow.${limit.window}`
  if (i18n.exists(short)) return i18n.t(short as 'composer:usage.shortWindow.five_hour')
  // A model's or a group's window names it in its label, and a group's name ends in "Models".
  const named = (pattern: RegExp): string =>
    (pattern.exec(limit.label)?.[1] ?? limitLabel(limit)).replace(/\s+models?$/i, '')
  if (limit.window.startsWith('seven_day_')) {
    return i18n.t('session:newSession.picker.tag.weeklyOf', { model: named(/^Weekly · (.+)$/) })
  }
  if (limit.window.startsWith('five_hour_')) {
    return i18n.t('session:newSession.picker.tag.fiveHourOf', { model: named(/^5-hour · (.+)$/) })
  }
  const counted = /^(\d+)_(minute|hour|day)$/.exec(limit.window)
  if (counted) {
    const unit = { minute: 'minutes', hour: 'hours', day: 'days' }[counted[2]!]!
    return i18n.t(`usage:limits.short.${unit}` as 'usage:limits.short.hours', {
      count: Number(counted[1]),
    })
  }
  return limitLabel(limit)
}

/** The model's provider, which an OpenCode model value starts with: `deepseek/deepseek-v4-pro`. */
function providerOf(model: ConfigOption | undefined): string | null {
  return typeof model?.value === 'string' ? (model.value.split('/')[0] ?? null) : null
}

/** Whether there are balances and none is left. */
const spent = (balances: readonly ProviderBalance[]): boolean =>
  balances.length > 0 && balances.every((balance) => balance.amount <= 0)

/**
 * Whether the agent is paid from a balance alone and it is used up: DeepSeek Harness on the
 * official key, and OpenCode on a DeepSeek or OpenRouter model. A balance beside a plan, such as
 * add-on credits, or a wallet of an account does not count.
 */
function balanceUsedUp(status: AgentStatus, model: ConfigOption | undefined): boolean {
  if (status.harnessId === 'deepseek') {
    const { balance } = status
    return (
      status.account?.kind === 'api_key' && balance?.state === 'ready' && spent(balance.balances)
    )
  }
  if (status.harnessId === 'opencode') {
    const provider = providerOf(model)
    if (provider !== 'deepseek' && provider !== 'openrouter') return false
    const usage = status.providers?.find((p) => p.id === provider)?.usage
    return usage?.state === 'ready' && spent(usage.balances)
  }
  return false
}

/** The limits that can hold back the model: an OpenCode provider's windows only its own models. */
function limitsOf(
  status: AgentStatus,
  limits: readonly PlanLimit[],
  model: ConfigOption | undefined,
): readonly PlanLimit[] {
  const provider = status.harnessId === 'opencode' ? providerOf(model) : null
  // Extra usage is no plan window: it says nothing of whether the plan lets a session start.
  return limits.filter(
    (limit) => limit.window !== 'overage' && (!provider || limit.window.startsWith(`${provider}:`)),
  )
}

/**
 * The tag of an agent's row, the first of these that applies: a version Kettu's checks reject,
 * what the agent needs before it starts, a used-up balance, a used-up plan window, a window at
 * 90% or more. `limits` are the account's newest reading and `model` the one a new session starts
 * on, since a window of another model does not hold it back. Null when nothing is wrong.
 */
export function agentTag(
  status: AgentStatus,
  options: {
    now: number
    view: LimitView
    limits: readonly PlanLimit[]
    model: ConfigOption | undefined
  },
): AgentTag | null {
  const { now, view, model } = options
  const t = i18n.t.bind(i18n)
  const need = agentNeed(status)
  // An outdated program is told to update before its version is called unsupported.
  const warning = need === 'update' ? null : status.versionWarning
  if (warning) {
    return tag(
      t('session:newSession.picker.tag.unsupported'),
      'attention',
      t(
        warning.broken || !warning.supported
          ? 'session:newSession.picker.versionBroken'
          : 'session:newSession.picker.versionUnsupported',
        { version: warning.version },
      ),
    )
  }
  if (need === 'update') {
    const task = status.task?.kind === 'update' ? status.task : null
    if (task?.state === 'running')
      return tag(t('session:newSession.picker.tag.updating'), 'muted', null)
    const failed = task?.state === 'failed' && task.error ? task.error : null
    return tag(
      t('session:newSession.picker.tag.update'),
      failed ? 'danger' : 'attention',
      failed ?? t('session:newSession.picker.needsUpdate', { problem: t('agents:problem.tooOld') }),
    )
  }
  if (need === 'blocked') {
    const problem = harnessProblem(status)
    return tag(
      t('session:newSession.picker.tag.fix'),
      'danger',
      t('session:newSession.picker.needsFix', { problem: problem?.text ?? '' }),
    )
  }
  if (need === 'failed') {
    return tag(
      t('session:newSession.picker.tag.failed'),
      'danger',
      t('session:newSession.picker.failed'),
    )
  }
  if (need === 'sign-in') {
    return tag(
      t('session:newSession.picker.tag.signIn'),
      'attention',
      t('session:newSession.picker.signedOut'),
    )
  }
  if (need === 'installing')
    return tag(t('session:newSession.picker.tag.installing'), 'muted', null)
  if (need === 'setup') {
    return tag(
      t('session:newSession.picker.tag.setsUp'),
      'muted',
      t('session:newSession.agentMenu.setsUp'),
    )
  }
  if (balanceUsedUp(status, model)) {
    return tag(
      t('session:newSession.picker.tag.noBalance'),
      'danger',
      t('session:newSession.picker.balanceUsedUp'),
    )
  }
  const held = holdingLimit(limitsOf(status, options.limits, model), model, now)
  if (!held) return null
  const limit = plain(held.limit)
  const window = windowName(limit)
  const phrase = limitPhrase(limit)
  if (held.reached) {
    const at = limit.resetsAt
    return tag(
      at === null
        ? t('session:newSession.picker.tag.usedUp', { window })
        : t('session:newSession.picker.tag.resets', { window, time: resetDay(at, now) }),
      'danger',
      at === null
        ? t('session:newSession.picker.limitUsedUp', { limit: phrase })
        : t('session:newSession.picker.limitReachedResets', {
            limit: phrase,
            time: resetTime(at, now),
          }),
    )
  }
  const percent = limitPercent(limit, view)
  const key = view === 'left' ? 'left' : 'used'
  return tag(
    t(`session:newSession.picker.tag.${key}`, { window, percent }),
    'attention',
    t(`session:newSession.picker.limit.${key}`, { limit: phrase, percent }),
  )
}
