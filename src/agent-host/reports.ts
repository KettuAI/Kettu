// Reports from an agent's own commands, for what its connection does not answer itself and ACP
// has no request for: Claude Code's `/usage` for the current use of the plan limits, and its
// `/context` for what fills a session's context. Each runs in a hidden session that Kettu makes
// for it and removes afterwards, so it shows in no thread and stays in none of the agent's
// history. Both run in the agent itself, without a model call of their own.

import type { PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { parseUsageReport } from './acp/claude-reports'
import type { AgentConnection } from './connection'
import { HostError } from './errors'
import { t } from './i18n'

export const REPORT_TIMEOUT_MS = 60_000

/** The running agent a hidden session is opened in. */
export interface HiddenRuntime {
  connection: AgentConnection
}

// Claude Code's reports, which the fake agent stands in for.
const CLAUDE_AGENTS: Partial<Record<AgentId, true>> = {
  'claude-code': true,
  'fake-agent': true,
}

export interface Report {
  command: string
}

/** The command whose report names an agent's plan limits, and how to read that report. */
export interface LimitsReport extends Report {
  /** The limits in one message of the report; null for a message that is not the report. */
  parse(markdown: string, now: number): PlanLimit[] | null
}

const CLAUDE_USAGE: LimitsReport = { command: '/usage', parse: parseUsageReport }

const LIMITS_REPORTS: Partial<Record<AgentId, LimitsReport>> = {
  'claude-code': CLAUDE_USAGE,
  // The fake agent stands in for Claude Code.
  'fake-agent': CLAUDE_USAGE,
}

export const CONTEXT_REPORT: Report = { command: '/context' }

export function limitsReport(agentId: AgentId): LimitsReport | null {
  return LIMITS_REPORTS[agentId] ?? null
}

/** Agents with `/context`: Claude Code, and the fake agent that stands in for it. */
export function hasContextReport(agentId: AgentId): boolean {
  return CLAUDE_AGENTS[agentId] === true
}

/**
 * Runs the report's command in the session `open` makes and returns the agent's messages, then
 * removes the session. An agent whose hidden sessions cannot be removed gets no report.
 */
export async function runReport(
  runtime: HiddenRuntime,
  open: () => Promise<string>,
  { command }: Report,
  log: (message: string) => void,
  timeoutMs = REPORT_TIMEOUT_MS,
): Promise<string[]> {
  const { connection } = runtime
  if (!connection.hiddenSessions) {
    log(`${command} not run: the agent's hidden sessions cannot be removed without a trace`)
    return []
  }
  const sessionId = await open()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      connection.collect(sessionId, command),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void connection.cancel(sessionId).catch(() => {})
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
    await connection.removeHidden(sessionId, (message) =>
      log(`Could not remove the session of ${command}: ${message}`),
    )
  }
}
