// Reports from an agent's own commands, which ACP has no request for: Claude Code's `/usage`
// and Codex's `/status` for the current use of the plan limits, and Claude Code's `/context` for
// what fills a session's context. Each runs in a session OverBench makes for it and deletes or
// closes afterwards, so it shows in no thread and in no session list. All three run in the agent
// itself, without a model call.

import type { PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { parseUsageReport } from './acp/claude-reports'
import { parseStatusReport } from './acp/codex-reports'
import type { AgentConnection, AgentInit } from './acp/connection'
import { HostError } from './errors'
import { t } from './i18n'

export const REPORT_TIMEOUT_MS = 60_000

export interface Report {
  command: string
  /** Deletes the session once more after a while, as claude-agent-acp needs (DELETE_AGAIN_MS). */
  deleteAgain: boolean
}

/** The command whose report names an agent's plan limits, and how to read that report. */
export interface LimitsReport extends Report {
  /** The limits in one message of the report; null for a message that is not the report. */
  parse(markdown: string, now: number): PlanLimit[] | null
}

const CLAUDE_USAGE: LimitsReport = { command: '/usage', deleteAgain: true, parse: parseUsageReport }

const LIMITS_REPORTS: Partial<Record<AgentId, LimitsReport>> = {
  'claude-code': CLAUDE_USAGE,
  codex: { command: '/status', deleteAgain: false, parse: parseStatusReport },
  // The fake agent stands in for Claude Code.
  'fake-agent': CLAUDE_USAGE,
}

export const CONTEXT_REPORT: Report = { command: '/context', deleteAgain: true }

export function limitsReport(agentId: AgentId): LimitsReport | null {
  return LIMITS_REPORTS[agentId] ?? null
}

/** Agents with `/context`: Claude Code, and the fake agent that stands in for it. */
export function hasContextReport(agentId: AgentId): boolean {
  return agentId === 'claude-code' || agentId === 'fake-agent'
}

/**
 * Runs the report's command in the session `open` makes and returns the agent's messages, then
 * deletes the session, or closes it where the agent cannot delete.
 */
export async function runReport(
  runtime: { connection: AgentConnection; init: AgentInit },
  open: () => Promise<string>,
  { command, deleteAgain }: Report,
  log: (message: string) => void,
  timeoutMs = REPORT_TIMEOUT_MS,
): Promise<string[]> {
  const { connection, init } = runtime
  const acpSessionId = await open()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      connection.collect(acpSessionId, command),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void connection.cancel(acpSessionId).catch(() => {})
          reject(
            new HostError(
              'agent_error',
              t('agent.reportTimeout', { command, seconds: String(timeoutMs / 1000) }),
            ),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    const { deleteSession, closeSession } = init.capabilities
    const failed = (error: unknown): void => {
      if (!connection.isClosed) {
        log(`Could not remove the session of ${command}: ${(error as Error).message}`)
      }
    }
    if (deleteSession) {
      await connection.deleteSession(acpSessionId).catch(failed)
      for (const delay of deleteAgain ? DELETE_AGAIN_MS : []) {
        setTimeout(() => void connection.deleteSession(acpSessionId).catch(failed), delay).unref()
      }
    } else if (closeSession) {
      await connection.closeSession(acpSessionId).catch(failed)
    }
  }
}

// claude-agent-acp 0.94 deletes the transcript without waiting for Claude Code to exit, and
// Claude Code writes the session's title and costs back as it exits, which lists the session
// again. Deleting once more after that removes it; deleting what is gone does nothing there,
// while codex-acp fails it as an unknown session.
const DELETE_AGAIN_MS = [1_000, 5_000]
