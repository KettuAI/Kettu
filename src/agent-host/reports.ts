// Reports from an agent's own commands, which ACP has no request for: Claude Code's `/usage`
// for the current use of the plan limits, and `/context` for what fills a session's context.
// Each runs in a session OverBench makes for it and deletes afterwards, so it shows in no thread
// and in no session list. Both commands run in Claude Code itself, without a model call.

import type { AgentId } from '@shared/thread'
import type { AgentConnection, AgentInit } from './acp/connection'
import { HostError } from './errors'
import { t } from './i18n'

export const REPORT_TIMEOUT_MS = 60_000

/** Agents with the reports: Claude Code, and the fake agent that stands in for it. */
export function hasReports(agentId: AgentId): boolean {
  return agentId === 'claude-code' || agentId === 'fake-agent'
}

/**
 * Runs `command` in the session `open` makes and returns the agent's messages, then deletes the
 * session, or closes it where the agent cannot delete.
 */
export async function runReport(
  runtime: { connection: AgentConnection; init: AgentInit },
  open: () => Promise<string>,
  command: string,
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
      for (const delay of DELETE_AGAIN_MS) {
        setTimeout(() => void connection.deleteSession(acpSessionId).catch(failed), delay).unref()
      }
    } else if (closeSession) {
      await connection.closeSession(acpSessionId).catch(failed)
    }
  }
}

// claude-agent-acp 0.94 deletes the transcript without waiting for Claude Code to exit, and
// Claude Code writes the session's title and costs back as it exits, which lists the session
// again. Deleting once more after that removes it; deleting what is gone does nothing.
const DELETE_AGAIN_MS = [1_000, 5_000]
