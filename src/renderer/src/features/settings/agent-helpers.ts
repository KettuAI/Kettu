// What the Agent and Harness sections of Settings both use that is not a component: who makes each
// harness, a button's request state, and reading an agent's account, usage and version.

import { useEffect, useState } from 'react'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { HarnessId } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'
import { isInstalled, useAgentsStore } from '@renderer/stores/agents'

export const VENDORS: Partial<Record<HarnessId, string>> = {
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  opencode: 'SST',
  pi: 'Earendil',
  omp: 'Oh My Pi',
  hermes: 'Nous Research',
  muse: 'Meta',
  codewhale: 'Codewhale',
}

export function useAction(): [(run: () => Promise<unknown>) => void, boolean, string | null] {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (run: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    run()
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false))
  }
  return [act, busy, error]
}

export function limitsReadable(status: AgentStatus): boolean {
  return status.capabilities.reports && isInstalled(status) && status.signIn !== 'required'
}

/**
 * Reads what an agent's row and page show: its account and plan limits, starting an agent that
 * reports them, and its details. True while the account and limits are being read.
 */
export function useAgentReads(status: AgentStatus): boolean {
  const [reading, setReading] = useState(true)
  useEffect(() => {
    let current = true
    host('agents.refreshAccount', { agentId: status.id })
      .catch((e: unknown) =>
        console.warn(`Could not read the account and plan limits: ${errorMessage(e)}`),
      )
      .finally(() => {
        if (current) setReading(false)
      })
    return () => {
      current = false
    }
  }, [status.id])
  // Again on each state or task change, so an adapter installed or updated shows its CLI version.
  const task = status.task?.state ?? null
  useEffect(() => {
    useAgentsStore
      .getState()
      .loadDetails(status.id)
      .catch((e: unknown) => console.warn(`Could not read the agent details: ${errorMessage(e)}`))
  }, [status.id, status.state, task, status.configDir?.runs])
  return reading
}

/** The windows whose reset has not passed; an older reading of them no longer holds. */
export function currentLimits(limits: PlanLimit[], now: number): PlanLimit[] {
  return limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
}

export function percent(limit: PlanLimit): string {
  return limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`
}

/** The harness's own version: the user's CLI it runs, or the program's, never Kettu's package. */
export function harnessVersion(status: AgentStatus): string | null {
  return status.cli ? (status.cli.installed?.version ?? null) : status.version
}

/** Whether the agent's harness has another agent, which is when "Default" tells them apart. */
export function useHasOtherAgents(status: AgentStatus): boolean {
  return useAgentsStore((s) =>
    s.order.some((id) => id !== status.id && s.byId[id]?.harnessId === status.harnessId),
  )
}
