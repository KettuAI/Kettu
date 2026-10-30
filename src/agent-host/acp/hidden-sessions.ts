// What Kettu's session options mean on each ACP adapter: the `_meta` a session opens with, and
// how a session Kettu opened for itself is removed so that none of the agent's history keeps it.

import type { AgentId } from '@shared/thread'
import type { AgentInit, SessionOptions } from '../connection'

/**
 * How a hidden session is removed so that none of the agent's history keeps it: `session/delete`,
 * once more after a while as claude-agent-acp needs (DELETE_AGAIN_MS), or `session/close`.
 */
export type Removal = 'delete' | 'delete-again' | 'close'

// Each agent's removal, as checked against its own history. An agent not listed opens no hidden
// session, so Kettu leaves nothing in a history nobody checked.
const REMOVALS: Partial<Record<AgentId, Removal>> = {
  'claude-code': 'delete-again',
  // codex-acp 2.2.2 answers `session/delete` with Codex's `thread/archive`, which writes the thread
  // to disk among the archived ones. A thread that never reached the model, such as one that only
  // ran `/status`, is not written at all, and closing it leaves nothing.
  codex: 'close',
  opencode: 'delete',
  // The session router turns the delete into ending the session's adapter process, then deleting.
  pi: 'delete',
  // The fake agent stands in for Claude Code.
  'fake-agent': 'delete-again',
}

/**
 * How the agent's hidden sessions are removed, or null when it may open none: it was not checked,
 * or it does not offer the request its removal needs. There is no fallback to the other request,
 * which can leave a trace (Codex's delete archives; OpenCode's close keeps the session listed).
 */
export function hiddenRemoval(
  agentId: AgentId | undefined,
  capabilities: Pick<AgentInit['capabilities'], 'closeSession' | 'deleteSession'>,
): Removal | null {
  const removal = agentId ? REMOVALS[agentId] : undefined
  if (!removal) return null
  const { closeSession, deleteSession } = capabilities
  return (removal === 'close' ? closeSession : deleteSession) ? removal : null
}

// claude-agent-acp 0.94 deletes the transcript without waiting for Claude Code to exit, and
// Claude Code writes the session's title and costs back as it exits, which lists the session
// again. Deleting once more after that removes it; deleting what is gone does nothing there,
// while codex-acp fails it as an unknown session.
export const DELETE_AGAIN_MS = [1_000, 5_000]

// Claude Code's adapter, which the fake agent stands in for.
const CLAUDE_AGENTS: Partial<Record<AgentId, true>> = {
  'claude-code': true,
  'fake-agent': true,
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
  if (!CLAUDE_AGENTS[agentId]) return meta
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

/** The `_meta` a session opens with, which only Claude Code's adapter reads. */
export function sessionMeta(
  agentId: AgentId | undefined,
  options: SessionOptions,
): Record<string, unknown> | undefined {
  if (!agentId || !CLAUDE_AGENTS[agentId]) return undefined
  const meta =
    options.ultracode === undefined
      ? undefined
      : { claudeCode: { options: { settings: { ultracode: options.ultracode } } } }
  return options.hidden ? hiddenSessionMeta(agentId, meta) : meta
}
