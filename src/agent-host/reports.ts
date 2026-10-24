// Reports from an agent's own commands, which ACP has no request for: Claude Code's `/usage`
// and Codex's `/status` for the current use of the plan limits, and Claude Code's `/context` for
// what fills a session's context. Each runs in a hidden session that OverBench makes for it and
// removes afterwards, so it shows in no thread and stays in none of the agent's history. All
// three run in the agent itself, without a model call of their own.

import type { PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { parseUsageReport } from './acp/claude-reports'
import { parseStatusReport } from './acp/codex-reports'
import type { AgentConnection, AgentInit } from './acp/connection'
import { HostError } from './errors'
import { t } from './i18n'

export const REPORT_TIMEOUT_MS = 60_000

/** The running agent a hidden session is opened in. */
export interface HiddenRuntime {
  agentId: AgentId
  connection: AgentConnection
  init: AgentInit
}

/**
 * How a hidden session is removed so that none of the agent's history keeps it: `session/delete`,
 * once more after a while as claude-agent-acp needs (DELETE_AGAIN_MS), or `session/close`.
 */
export type Removal = 'delete' | 'delete-again' | 'close'

// Each agent's removal, as checked against its own history. An agent not listed opens no hidden
// session, so OverBench leaves nothing in a history nobody checked.
const REMOVALS: Partial<Record<AgentId, Removal>> = {
  'claude-code': 'delete-again',
  // codex-acp 2.2.2 answers `session/delete` with Codex's `thread/archive`, which writes the thread
  // to disk among the archived ones. A thread that never reached the model, such as one that only
  // ran `/status`, is not written at all, and closing it leaves nothing.
  codex: 'close',
  opencode: 'delete',
  // The fake agent stands in for Claude Code.
  'fake-agent': 'delete-again',
}

/**
 * How the agent's hidden sessions are removed, or null when it may open none: it was not checked,
 * or it does not offer the request its removal needs. There is no fallback to the other request,
 * which can leave a trace (Codex's delete archives; OpenCode's close keeps the session listed).
 */
export function hiddenRemoval(agentId: AgentId, init: AgentInit): Removal | null {
  const removal = REMOVALS[agentId]
  if (!removal) return null
  const { closeSession, deleteSession } = init.capabilities
  return (removal === 'close' ? closeSession : deleteSession) ? removal : null
}

/**
 * `_meta` for opening a hidden session, added to `meta`. Claude Code's adapter passes
 * `claudeCode.options` to its SDK: `disableAllHooks` keeps the user's, the project's and plugins'
 * hooks and the status line from running for a session nobody sees (managed hooks still run), and
 * `persistSession: false` writes no transcript. Other agents get `meta` as it is.
 */
export function hiddenSessionMeta(
  agentId: AgentId,
  meta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (agentId !== 'claude-code' && agentId !== 'fake-agent') return meta
  const claudeCode = (meta?.claudeCode ?? {}) as { options?: { settings?: object } }
  const options = claudeCode.options ?? {}
  return {
    ...meta,
    claudeCode: {
      ...claudeCode,
      options: {
        ...options,
        persistSession: false,
        settings: { ...options.settings, disableAllHooks: true },
      },
    },
  }
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
  codex: { command: '/status', parse: parseStatusReport },
  // The fake agent stands in for Claude Code.
  'fake-agent': CLAUDE_USAGE,
}

export const CONTEXT_REPORT: Report = { command: '/context' }

export function limitsReport(agentId: AgentId): LimitsReport | null {
  return LIMITS_REPORTS[agentId] ?? null
}

/** Agents with `/context`: Claude Code, and the fake agent that stands in for it. */
export function hasContextReport(agentId: AgentId): boolean {
  return agentId === 'claude-code' || agentId === 'fake-agent'
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
  const removal = hiddenRemoval(runtime.agentId, runtime.init)
  if (!removal) {
    log(`${command} not run: the agent's hidden sessions cannot be removed without a trace`)
    return []
  }
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
 * Removes a session OverBench made for itself by `removal`, from `hiddenRemoval`, and drops its
 * late updates. Failures go to `log` while the agent still runs.
 */
export async function removeHiddenSession(
  { connection }: HiddenRuntime,
  acpSessionId: string,
  removal: Removal,
  log: (message: string) => void,
): Promise<void> {
  connection.unregister(acpSessionId)
  const failed = (error: unknown): void => {
    if (!connection.isClosed) log((error as Error).message)
  }
  if (removal === 'close') {
    await connection.closeSession(acpSessionId).catch(failed)
    return
  }
  await connection.deleteSession(acpSessionId).catch(failed)
  for (const delay of removal === 'delete-again' ? DELETE_AGAIN_MS : []) {
    setTimeout(() => void connection.deleteSession(acpSessionId).catch(failed), delay).unref()
  }
}

// claude-agent-acp 0.94 deletes the transcript without waiting for Claude Code to exit, and
// Claude Code writes the session's title and costs back as it exits, which lists the session
// again. Deleting once more after that removes it; deleting what is gone does nothing there,
// while codex-acp fails it as an unknown session.
const DELETE_AGAIN_MS = [1_000, 5_000]
