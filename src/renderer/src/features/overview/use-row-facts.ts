// A row's facts for every view of the Overview page, read from the stores and its host.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionOutputs } from '@shared/agent-host'
import { sessionPullRequests } from '@renderer/features/sidebar/session-prs'
import { useOutputs } from '@renderer/features/sidebar/use-outputs'
import { stepTitle, stepWord, workflowTitle } from '@renderer/features/tasks/model'
import { basename } from '@renderer/lib/format'
import { hostPath } from '@renderer/lib/host-paths'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import { openSession, openTask } from '@renderer/stores/view'
import { useHostName, useNamesHosts } from '@renderer/stores/window-host'
import {
  frontStep,
  planSteps,
  replyLine,
  taskSteps,
  type OverviewRow,
  type OverviewStep,
} from './model'

export type RowOutput =
  | { kind: 'artifact'; id: string; title: string }
  | { kind: 'pr'; url: string; number: number; sessionId?: string | null }

export interface RowFacts {
  title: string
  /** The project's folder name, or "No project". */
  project: string
  /** The workflow's name, or the agent's. */
  by: string
  /** The host's name, when the window names hosts. */
  host: string | null
  steps: OverviewStep[] | null
  now: string
  outputs: RowOutput[]
  /** When what it does now started, for a running row. */
  since: number
  /** A session's outputs as read; null for a task or while they are read. */
  read: SessionOutputs | null
  open: () => void
}

const NO_SUMMARY = {
  id: '',
  updatedAt: 0,
} as Parameters<typeof useOutputs>[0]

/** A row's facts; a session's plan and what it made are read from its host. */
export function useRowFacts(row: OverviewRow): RowFacts {
  const { t } = useTranslation('overview')
  const { t: tt } = useTranslation('tasks')
  const { t: ts } = useTranslation('sidebar')
  const namesHosts = useNamesHosts()
  const hostName = useHostName()
  const view = useTasksStore((s) => (row.kind === 'task' ? s.views[row.task.id] : undefined))
  const read = useSessionOutputs(row)
  return useMemo(() => {
    const host = namesHosts ? hostName(row.hostId) : null
    if (row.kind === 'task') {
      const { task } = row
      const steps = taskSteps(task, (id, fallback) => stepTitle(view?.workflow, id, fallback))
      const front = frontStep(steps)
      const source = front ? task.steps.find((step) => step.id === front.id) : undefined
      const word = source ? stepWord(source, view) : null
      const documents = new Map<string, RowOutput>()
      for (const round of view?.rounds ?? []) {
        if (round.document) {
          documents.set(round.document.artifactId, {
            kind: 'artifact',
            id: round.document.artifactId,
            title: round.document.title,
          })
        }
      }
      return {
        title: task.title,
        project: basename(hostPath(task.projectPath)),
        by: workflowTitle(task, view),
        host,
        steps,
        now:
          task.status !== 'running'
            ? tt(`ended.${task.status}`)
            : front && word
              ? t('now.step', { step: front.name, state: tt(`state.${word}`) })
              : tt('state.waiting'),
        outputs: [...documents.values()].reverse(),
        since: front?.startedAt ?? task.updatedAt,
        read: null,
        open: () => openTask(task.id),
      }
    }
    const { summary } = row.node
    const steps = planSteps(read, row.state)
    const front = frontStep(steps)
    const outputs: RowOutput[] = [
      ...sessionPullRequests(summary).map((pr): RowOutput => ({
        kind: 'pr',
        url: pr.url,
        number: pr.number,
        sessionId: summary.id,
      })),
      ...(read?.artifacts ?? []).map((artifact): RowOutput => ({
        kind: 'artifact',
        id: artifact.id,
        title: artifact.title,
      })),
    ]
    const now =
      row.state === 'you'
        ? t('now.requests', { count: row.node.permissionCount })
        : row.state === 'stopped'
          ? t('now.failed')
          : row.state === 'running'
            ? (front?.name ?? t('now.working'))
            : (replyLine(read?.reply) ?? t('now.finished'))
    return {
      title: sessionTitle(summary),
      project: summary.scratch ? ts('project.noProject') : basename(hostPath(summary.projectPath)),
      by: agentName(summary.agentId, row.hostId),
      host,
      steps,
      now,
      outputs,
      since: read?.turnStartedAt ?? summary.updatedAt,
      read,
      open: () => openSession(summary.id, summary.projectPath),
    }
  }, [row, view, read, namesHosts, hostName, t, tt, ts])
}

function useSessionOutputs(row: OverviewRow): SessionOutputs | null {
  const outputs = useOutputs(row.kind === 'session' ? row.node.summary : NO_SUMMARY)
  return row.kind === 'session' ? outputs : null
}
