import { useMemo } from 'react'
import { UserMultiple02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { AgentMonitor } from '@renderer/components/affect/agent-monitor'
import { AgentTree, type TreeAgent } from '@renderer/components/affect/agent-tree'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  subagentRunning,
  useLoadSubagent,
  useSubagentDigests,
  type SubagentDigestOf,
} from '@renderer/features/session/subagent/progress'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { askedStep, currentStep, subagentFailed, subagentWaiting } from './board-model'
import { useMonitorLabels, useTreeLabels } from './board-labels'
import { Finished, Section } from './row-parts'

const UNKNOWN: SubagentDigestOf = { digest: null, tokens: null }

/** Watches a running sub-agent's thread, or reads an ended one's once, for its step and time. */
function Loader({ child }: { child: SessionSummary }) {
  useLoadSubagent(child, true)
  return null
}

function rootStatus(session: SessionSummary): TreeAgent['status'] {
  if (session.status === 'awaiting_permission') return 'waiting'
  if (session.status === 'running' || session.status === 'starting') return 'running'
  if (session.status === 'failed') return 'failed'
  return 'done'
}

/**
 * The sub-agents a session started: those at work as an Agent Tree under the session's own
 * agent, each with its type, the step it is on, its tokens and its time; the ended ones folded
 * below, one Agent Monitor bar each.
 */
export function SubagentSection({
  session,
  subagents: children,
}: {
  session: SessionSummary
  /** Its sub-agents, those waiting for the user first. */
  subagents: SessionSummary[]
}) {
  const { t } = useTranslation('board')
  const { t: ts } = useTranslation('session')
  const treeLabels = useTreeLabels()
  const monitorLabels = useMonitorLabels()
  const idKey = children.map((child) => child.id).join(' ')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key stands for the ids
  const ids = useMemo(() => children.map((child) => child.id), [idKey])
  const digests = useSubagentDigests(ids)
  const live = children.filter(subagentRunning)
  const ended = children.filter((child) => !subagentRunning(child))
  const host = hostOfSession(session)
  const running = live.filter((child) => !subagentWaiting(child)).length

  const tokens = (n: number) => t('tokens', { tokens: (n / 1000).toFixed(1) + 'k' })
  const root: TreeAgent = {
    id: session.id,
    name: agentName(session.agentId, host),
    task: sessionTitle(session),
    status: rootStatus(session),
    avatar: <AgentMark agent={session.agentId} hostId={host} size={14} />,
    children: live.map((child) => {
      const { digest, tokens: total } = digests[child.id] ?? UNKNOWN
      const waiting = subagentWaiting(child)
      const asked = waiting ? askedStep(digest, child.projectPath) : null
      return {
        id: child.id,
        name: sessionTitle(child),
        ...(child.description ? { model: child.description } : {}),
        avatar: <AgentMark agent={child.agentId} hostId={host} size={14} />,
        status: waiting ? 'waiting' : 'running',
        task: waiting
          ? (asked ?? t('step.waiting'))
          : (currentStep(digest, child.projectPath) ?? t('step.starting')),
        ...(total === null ? {} : { cost: total }),
        // A sub-agent that ran before keeps no start for this run, so it shows no time.
        ...(digest?.durationMs == null ? { started: child.createdAt } : {}),
      }
    }),
  }
  const select = (agent: TreeAgent) => {
    const child = children.find((c) => c.id === agent.id)
    if (child) openSession(child.id, child.projectPath)
  }
  const failed = ended.filter(subagentFailed).length

  return (
    <Section
      icon={UserMultiple02Icon}
      title={t('sections.subagents')}
      count={children.length}
      running={running > 0 ? t('sections.running', { count: running }) : null}
    >
      {children.map((child) => (
        <Loader key={child.id} child={child} />
      ))}
      {children.length === 0 && <p className="kb-note">{t('none.subagents')}</p>}
      {live.length > 0 && (
        <AgentTree
          className="kb-tree"
          root={root}
          title={t('sections.subagents')}
          labels={treeLabels}
          formatCost={tokens}
          onSelect={select}
        />
      )}
      {ended.length > 0 && (
        <Finished count={ended.length} failed={failed} open={live.length === 0}>
          <div className="kb-stack">
            {ended.map((child) => {
              const { digest } = digests[child.id] ?? UNKNOWN
              const wasFailed = subagentFailed(child)
              const cancelled = !wasFailed && digest?.stopReason === 'cancelled'
              const took = digest?.durationMs ?? Math.max(0, child.updatedAt - child.createdAt)
              return (
                <AgentMonitor
                  key={child.id}
                  defaultFolded
                  state={wasFailed ? 'failed' : cancelled ? 'cancelled' : 'finished'}
                  agent={{
                    name: sessionTitle(child),
                    ...(child.description ? { role: child.description } : {}),
                    mark: <AgentMark agent={child.agentId} hostId={host} size={14} />,
                  }}
                  since={child.createdAt}
                  until={child.createdAt + took}
                  {...(digest?.tools != null
                    ? { outcome: { note: ts('subagent.tools', { count: digest.tools }) } }
                    : {})}
                  onOpenLog={() => openSession(child.id, child.projectPath)}
                  labels={monitorLabels}
                />
              )
            })}
          </div>
        </Finished>
      )}
    </Section>
  )
}
