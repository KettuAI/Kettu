// Plan limit notices: a window of an agent's account reaching 90%, used up, or reset after it was
// used up, each said once. Windows are followed by account, so two agents signed in to the same
// account say it once, and every host words the key alike, so main can drop another host's copy.

import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import { limitLevel, type PlanLimitNoticeLevel } from '@shared/plan-limits'
import { harnessOf, type AgentId } from '@shared/thread'
import { t } from './i18n'
import { resetTime, windowName } from './routines/manager'

export interface LimitNotice {
  agentId: AgentId
  level: PlanLimitNoticeLevel
  key: string
  limit: PlanLimit
  /** The account as the agent names it, or the agent's name without one. */
  account: string
}

type Level = 'ok' | 'near' | 'reached'

interface Seen {
  level: Level
  resetsAt: number | null
  /** Said in this period of the window: near, reached, or both. */
  said: Set<Level>
}

// A reset reported within this of the one before belongs to the same period of the window.
const SAME_PERIOD_MS = 60_000

function levelOf(limit: PlanLimit): Level {
  if (limit.state === 'reached') return 'reached'
  return limitLevel(limit) === 'bad' ? 'near' : 'ok'
}

/** The account the agent is signed in to, the same text on every host. */
function accountKey(status: AgentStatus): string {
  const account = status.account
  return `${harnessOf(status.id)}:${account?.email ?? account?.label ?? status.id}`
}

export class LimitNotices {
  private readonly seen = new Map<string, Seen>()

  /**
   * What changed in an agent's windows since its last status. A window seen for the first time
   * says nothing, so starting Kettu with a window already full stays quiet.
   */
  observe(status: AgentStatus, now: number): LimitNotice[] {
    const notices: LimitNotice[] = []
    const account = status.account?.label || status.name
    for (const limit of status.limits) {
      const key = `${accountKey(status)}:${limit.window}`
      const level = levelOf(limit)
      const before = this.seen.get(key)
      if (!before) {
        this.seen.set(key, { level, resetsAt: limit.resetsAt, said: new Set() })
        continue
      }
      const newPeriod =
        before.resetsAt !== null &&
        limit.resetsAt !== null &&
        limit.resetsAt - before.resetsAt > SAME_PERIOD_MS
      // A period that ended without a report of the window's own is over once its reset passed.
      const passed = before.resetsAt !== null && before.resetsAt <= now && level !== 'reached'
      const say = (notice: PlanLimitNoticeLevel): void => {
        notices.push({ agentId: status.id, level: notice, key, limit, account })
      }
      if (before.level === 'reached' && level !== 'reached') say('reset')
      if (newPeriod || passed || (before.level === 'reached' && level !== 'reached')) {
        before.said.clear()
      }
      if (level === 'reached' && before.level !== 'reached' && !before.said.has('reached')) {
        say('reached')
        before.said.add('reached')
      } else if (level === 'near' && before.level === 'ok' && before.said.size === 0) {
        say('near')
        before.said.add('near')
      }
      before.level = level
      before.resetsAt = limit.resetsAt
    }
    return notices
  }
}

/**
 * A notice's title and line. One about the session the window stopped is titled with the session,
 * since it stands in for that session's own notice.
 */
export function limitNoticeText(
  notice: LimitNotice,
  sessionTitle: string | null,
  now: number,
): { title: string; body: string } {
  const { limit, account } = notice
  const params = {
    limit: windowName(limit),
    percent: String(Math.round(limit.usedPercent ?? 100)),
    account,
    time: limit.resetsAt !== null ? resetTime(limit.resetsAt, now) : '',
  }
  const until = limit.resetsAt !== null
  if (sessionTitle !== null) {
    return {
      title: sessionTitle,
      body:
        notice.level === 'reset'
          ? t('planLimitNotice.sessionReset', params)
          : t(
              until ? 'planLimitNotice.sessionReached' : 'planLimitNotice.sessionReachedNoReset',
              params,
            ),
    }
  }
  const title =
    notice.level === 'near'
      ? t('planLimitNotice.near', params)
      : notice.level === 'reached'
        ? t('planLimitNotice.reached', params)
        : t('planLimitNotice.reset', params)
  const body =
    notice.level === 'reset'
      ? t('planLimitNotice.goOn', params)
      : until
        ? t('planLimitNotice.resets', params)
        : account
  return { title, body }
}
