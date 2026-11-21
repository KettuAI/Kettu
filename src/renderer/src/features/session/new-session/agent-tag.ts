// The one short tag New session's agent menu writes at the end of a row: what stops the agent from
// starting a session now, or would soon.

import type { AgentStatus, PlanLimit, ProviderBalance } from '@shared/agent-host'
import { holdingLimit } from '@shared/plan-limits'
import type { ConfigOption } from '@shared/thread'
import { harnessProblem } from '@renderer/features/agents/harness-problem'
import { limitPhrase, limitShort, limitShortScope, resetDay, resetTime } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { limitPercent, type LimitView } from '@renderer/lib/plan-limit'
import { agentNeed } from './start-options'
import type { LineTone } from './picker'

export interface AgentTag {
  text: string
  tone: LineTone
  /** The whole sentence, shown while the pointer rests on the tag; null where the tag says all. */
  title: string | null
  /**
   * `text` split around the model, group or pool of a window, the one part that gives way when the
   * row is tight; null where the tag names none.
   */
  scope: { before: string; name: string; after: string } | null
}

const tag = (text: string, tone: LineTone, title: string | null): AgentTag => ({
  text,
  tone,
  title,
  scope: null,
})

/** A window's tag, with its model, group or pool marked off in the text. */
function windowTag(
  text: string,
  tone: LineTone,
  title: string,
  window: string,
  scope: string | null,
): AgentTag {
  const end = text.indexOf(window) + window.length
  if (!scope || end < window.length) return tag(text, tone, title)
  return {
    text,
    tone,
    title,
    scope: { before: text.slice(0, end - scope.length), name: scope, after: text.slice(end) },
  }
}

/** A window without its OpenCode provider, whose models are the only ones it holds back. */
function plain(limit: PlanLimit): PlanLimit {
  if (!limit.window.includes(':')) return limit
  const label = limit.label.split(' · ').at(-1) ?? limit.label
  return { ...limit, window: limit.window.slice(limit.window.indexOf(':') + 1), label }
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
export function limitsOf(
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
 * what the agent needs before it starts, a used-up balance, a used-up plan window that extra usage
 * covers, a used-up plan window, a window at 90% or more. `limits` are the account's newest
 * reading and `model` the one a new session starts on, since a window of another model does not
 * hold it back. Null when nothing is wrong.
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
  const window = limitShort(limit)
  const scope = limitShortScope(limit)
  const phrase = limitPhrase(limit)
  if (held.reached && limit.extraUsage) {
    return tag(
      t('session:newSession.picker.tag.extraUsage'),
      'attention',
      t('session:newSession.picker.limitExtraUsage', { limit: phrase }),
    )
  }
  if (held.reached) {
    const at = limit.resetsAt
    return windowTag(
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
      window,
      scope,
    )
  }
  const percent = limitPercent(limit, view)
  const key = view === 'left' ? 'left' : 'used'
  return windowTag(
    t(`session:newSession.picker.tag.${key}`, { window, percent }),
    'attention',
    t(`session:newSession.picker.limit.${key}`, { limit: phrase, percent }),
    window,
    scope,
  )
}
