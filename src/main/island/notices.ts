// The island's notices under the sessions: Kettu's own update, the agents' updates and the
// tightest plan limit window, each one line, with what a click on it does. The words are main's,
// as everywhere on the island.

import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import { updateOffer } from '@shared/agent-update-offer'
import { limitLevel, resetTimeText } from '@shared/plan-limits'
import type { UpdateStatus } from '@shared/updates'
import { islandT, locale } from '../i18n'
import type { IslandMark, IslandNotice } from './protocol'
import type { HostState } from './view'
import { limitLabel } from './windows'

/** What a notice does when clicked: restart into the downloaded update, or open a page. */
export type NoticeAction = 'restart' | 'updates' | 'usage'

export interface BuiltNotices {
  notices: IslandNotice[]
  actions: ReadonlyMap<string, NoticeAction>
}

/** The marks a notice about agents leads with, as many as the island stacks. */
const MAX_MARKS = 3

/** The update Kettu offers now, unless its notice was dismissed: downloaded, or a step of the user's. */
export function appUpdate(status: UpdateStatus | null): { version: string; ready: boolean } | null {
  if (!status) return null
  const { state } = status
  if (state.kind === 'ready' && status.dismissed !== state.version) {
    return { version: state.version, ready: true }
  }
  if (state.kind === 'available' && status.dismissed !== state.version) {
    return { version: state.version, ready: false }
  }
  return null
}

function markOf(status: AgentStatus): IslandMark {
  return { harness: status.harnessId, color: status.color ?? null }
}

function appNotice(status: UpdateStatus | null): [IslandNotice, NoticeAction] | null {
  const update = appUpdate(status)
  if (!update) return null
  const { version, ready } = update
  return [
    {
      key: 'app-update',
      kind: 'app_update',
      marks: [],
      title: islandT(ready ? 'notice.appReady' : 'notice.appAvailable', { version }),
      detail: ready ? islandT('notice.appReadyNote') : null,
      meter: null,
      trailing: null,
      button: ready ? islandT('notice.restart') : null,
      link: ready ? null : islandT('notice.update'),
    },
    ready ? 'restart' : 'updates',
  ]
}

/** This computer's harnesses with an update on offer, as the sidebar's card offers them. */
function agentNotice(local: HostState | undefined): [IslandNotice, NoticeAction] | null {
  if (!local) return null
  const offering = [...local.agents.values()].filter(
    (status) =>
      status.isDefault &&
      !status.updateSkipped &&
      !(status.task?.kind === 'update' && status.task.state === 'running') &&
      updateOffer(status) !== null,
  )
  if (offering.length === 0) return null
  const names = offering.map((status) => status.harnessName)
  const title =
    names.length === 1
      ? islandT('notice.agentOne', { name: names[0] })
      : names.length === 2
        ? islandT('notice.agentTwo', { first: names[0], second: names[1] })
        : islandT('notice.agentMany', {
            name: names[0],
            count: names.length,
            others: names.length - 1,
          })
  return [
    {
      key: 'agent-updates',
      kind: 'agent_update',
      marks: offering.slice(0, MAX_MARKS).map(markOf),
      title,
      detail: null,
      meter: null,
      trailing: null,
      button: null,
      link: islandT('notice.view'),
    },
    'updates',
  ]
}

/**
 * The fullest window at 90% or more across every host's agents, used up first; an account signed
 * in on several agents or hosts counts once. Windows whose reset already passed are left out.
 */
function limitNotice(
  hosts: readonly HostState[],
  now: number,
): [IslandNotice, NoticeAction] | null {
  let best: { status: AgentStatus; limit: PlanLimit; used: number } | null = null
  for (const state of hosts) {
    for (const status of state.agents.values()) {
      for (const limit of status.limits) {
        if (limit.resetsAt !== null && limit.resetsAt <= now) continue
        if (limitLevel(limit) !== 'bad') continue
        const used = limit.state === 'reached' ? Infinity : Math.round(limit.usedPercent ?? 0)
        if (!best || used > best.used) best = { status, limit, used }
      }
    }
  }
  if (!best) return null
  const { status, limit, used } = best
  const reached = used === Infinity
  return [
    {
      key: 'limit',
      kind: 'limit',
      marks: [markOf(status)],
      title: status.account?.label || status.name,
      detail: limitLabel(limit),
      meter: {
        percent: reached ? 100 : used,
        reached,
        text: reached ? islandT('notice.usedUp') : `${used}%`,
      },
      trailing:
        limit.resetsAt !== null
          ? islandT('notice.resets', { time: resetTimeText(limit.resetsAt, now, locale()) })
          : null,
      button: null,
      link: null,
    },
    'usage',
  ]
}

export function buildNotices(
  update: UpdateStatus | null,
  hosts: readonly HostState[],
  now: number,
): BuiltNotices {
  const built = [
    appNotice(update),
    agentNotice(hosts.find((state) => state.host === null)),
    limitNotice(hosts, now),
  ].filter((entry) => entry !== null)
  return {
    notices: built.map(([notice]) => notice),
    actions: new Map(built.map(([notice, action]) => [notice.key, action])),
  }
}
