import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentMonitorLabels } from '@renderer/components/affect/agent-monitor'
import type { AgentTreeLabels } from '@renderer/components/affect/agent-tree'

/** The Agent Tree's words in the app's language. */
export function useTreeLabels(): Partial<AgentTreeLabels> {
  const { t } = useTranslation('board')
  return useMemo(
    () => ({
      status: {
        queued: t('status.queued'),
        running: t('status.running'),
        waiting: t('status.needs'),
        done: t('status.done'),
        failed: t('status.failed'),
        stopped: t('status.stopped'),
      },
      agents: (count: number) => t('tree.agents', { count }),
      running: (count: number) => t('sections.running', { count }),
      needsYou: (count: number) => t('tree.needsYou', { count }),
      failed: (count: number) => t('finished.failed', { count }),
      // A waiting sub-agent is answered on its own page, which Approve opens.
      approve: t('actions.open'),
      reject: t('actions.close'),
      retry: t('tree.retry'),
      dismiss: t('tree.dismiss'),
      waitingDialog: t('tree.waitingDialog'),
      failedDialog: t('tree.failedDialog'),
      branchCost: t('tree.branchCost'),
      showSub: (count: number, name: string) => t('tree.showSub', { count, name }),
      foldSub: (name: string) => t('tree.foldSub', { name }),
      beside: (name: string) => t('tree.beside', { name }),
    }),
    [t],
  )
}

/** The Agent Monitor's words in the app's language. */
export function useMonitorLabels(): Partial<AgentMonitorLabels> {
  const { t } = useTranslation('board')
  return useMemo(
    () => ({
      agent: t('monitor.agent'),
      states: {
        idle: t('monitor.states.idle'),
        running: t('monitor.states.running'),
        waiting: t('monitor.states.waiting'),
        paused: t('monitor.states.paused'),
        finished: t('monitor.states.finished'),
        failed: t('monitor.states.failed'),
        cancelled: t('monitor.states.cancelled'),
      },
      kinds: {
        read: t('monitor.kinds.read'),
        search: t('monitor.kinds.search'),
        edit: t('monitor.kinds.edit'),
        run: t('monitor.kinds.run'),
        think: t('monitor.kinds.think'),
        web: t('monitor.kinds.web'),
      },
      failed: t('status.failed'),
      waitingOnYou: t('monitor.waitingOnYou'),
      finishedIn: (time: string) => t('monitor.finishedIn', { time }),
      files: (count: number) => t('monitor.files', { count }),
      errorFallback: t('monitor.errorFallback'),
      cancelledAfter: (time: string) => t('monitor.cancelledAfter', { time }),
      noTask: t('monitor.noTask'),
      said: (name: string, state: string, detail?: string) =>
        detail
          ? t('monitor.saidDetail', { name, state, detail })
          : t('monitor.said', { name, state }),
      open: (said: string) => t('monitor.open', { said }),
      costSoFar: (cost: string) => t('monitor.costSoFar', { cost }),
      foldAway: t('monitor.foldAway'),
      runningFor: (time: string) => t('monitor.runningFor', { time }),
      finishedSteps: t('monitor.finishedSteps'),
      details: (step: string) => t('monitor.details', { step }),
      close: t('actions.close'),
      started: t('monitor.started'),
      took: t('monitor.took'),
      share: t('monitor.share'),
      state: t('monitor.state'),
      running: t('status.running'),
      done: t('status.done'),
      decline: t('monitor.decline'),
      allow: t('monitor.allow'),
      retry: t('monitor.retry'),
      pause: t('monitor.pause'),
      resume: t('monitor.resume'),
      cancel: t('monitor.cancel'),
      log: t('monitor.log'),
    }),
    [t],
  )
}
