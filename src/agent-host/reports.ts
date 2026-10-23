// Reports from an agent's own commands, which ACP has no request for: Claude Code's `/usage`
// and Codex's `/status` for the current use of the plan limits, and Claude Code's `/context` for
// what fills a session's context. Each runs in a hidden session that OverBench makes for it and
// removes afterwards, so it shows in no thread and stays in none of the agent's history. All
// three run in the agent itself, without a model call.

import type { PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { parseUsageReport } from './acp/claude-reports'
import { parseStatusReport } from './acp/codex-reports'
import type { AgentConnection, AgentInit } from './acp/connection'
import { HostError } from './errors'
import { t } from './i18n'

export const REPORT_TIMEOUT_MS = 60_000

/**
 * How a hidden session is removed so that none of the agent's history keeps it: `session/delete`,
 * once more after a while as claude-agent-acp needs (DELETE_AGAIN_MS), or `session/close`.
 */
export type Removal = 'delete' | 'delete-again' | 'close'

const REMOVALS: Partial<Record<AgentId, Removal>> = {
  'claude-code': 'delete-again',
  // codex-acp 2.2.2 answers `session/delete` with Codex's `thread/archive`, which writes the thread
  // to disk among the archived ones. A thread that never reached the model, such as one that only
  // ran `/status`, is not written at all, and closing it leaves nothing.
  codex: 'close',
  // The fake agent stands in for Claude Code.
  'fake-agent': 'delete-again',
}

export function removalOf(agentId: AgentId): Removal {
  return REMOVALS[agentId] ?? 'delete'
}

export interface Report {
  command: string
  removal: Removal
}

/** The command whose report names an agent's plan limits, and how to read that report. */
export interface LimitsReport extends Report {
  /** The limits in one message of the report; null for a message that is not the report. */
  parse(markdown: string, now: number): PlanLimit[] | null
}

const CLAUDE_USAGE: LimitsReport = {
  command: '/usage',
  removal: removalOf('claude-code'),
  parse: parseUsageReport,
}

const LIMITS_REPORTS: Partial<Record<AgentId, LimitsReport>> = {
  'claude-code': CLAUDE_USAGE,
  codex: { command: '/status', removal: removalOf('codex'), parse: parseStatusReport },
  // The fake agent stands in for Claude Code.
  'fake-agent': CLAUDE_USAGE,
}

export const CONTEXT_REPORT: Report = { command: '/context', removal: removalOf('claude-code') }

export function limitsReport(agentId: AgentId): LimitsReport | null {
  return LIMITS_REPORTS[agentId] ?? null
}

/** Agents with `/context`: Claude Code, and the fake agent that stands in for it. */
export function hasContextReport(agentId: AgentId): boolean {
  return agentId === 'claude-code' || agentId === 'fake-agent'
}

/**
 * Runs the report's command in the session `open` makes and returns the agent's messages, then
 * removes the session.
 */
export async function runReport(
  runtime: { connection: AgentConnection; init: AgentInit },
  open: () => Promise<string>,
  { command, removal }: Report,
  log: (message: string) => void,
  timeoutMs = REPORT_TIMEOUT_MS,
): Promise<string[]> {
  const { connection } = runtime
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
    await removeHiddenSession(runtime, acpSessionId, removal, (message) =>
      log(`Could not remove the session of ${command}: ${message}`),
    )
  }
}

/**
 * Removes a session OverBench made for itself, by `removal`, or the other way where the agent
 * lacks it; its late updates are dropped. Failures go to `log` while the agent still runs.
 */
export async function removeHiddenSession(
  { connection, init }: { connection: AgentConnection; init: AgentInit },
  acpSessionId: string,
  removal: Removal,
  log: (message: string) => void,
): Promise<void> {
  connection.unregister(acpSessionId)
  const { deleteSession, closeSession } = init.capabilities
  const failed = (error: unknown): void => {
    if (!connection.isClosed) log((error as Error).message)
  }
  const close = removal === 'close' ? closeSession : closeSession && !deleteSession
  if (close) {
    await connection.closeSession(acpSessionId).catch(failed)
  } else if (deleteSession) {
    await connection.deleteSession(acpSessionId).catch(failed)
    for (const delay of removal === 'delete-again' ? DELETE_AGAIN_MS : []) {
      setTimeout(() => void connection.deleteSession(acpSessionId).catch(failed), delay).unref()
    }
  }
}

// claude-agent-acp 0.94 deletes the transcript without waiting for Claude Code to exit, and
// Claude Code writes the session's title and costs back as it exits, which lists the session
// again. Deleting once more after that removes it; deleting what is gone does nothing there,
// while codex-acp fails it as an unknown session.
const DELETE_AGAIN_MS = [1_000, 5_000]
