// Which artifact a call to the service acted on, for the agent's tool call in the thread, and
// which of the thread's tool calls a service call is. See docs/design/artifacts.md#opening-from-a-session.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ArtifactLink } from '@shared/thread'

const ACTIONS: Record<string, ArtifactLink['action']> = {
  create_artifact: 'create',
  update_artifact: 'update',
  restore_artifact_version: 'restore',
  delete_artifact: 'delete',
  read_artifact: 'read',
}

/**
 * The link a successful call makes, or null for a call that names no one artifact or failed.
 * `titleOf` gives the artifact's title when neither the call nor its result carries it.
 */
export async function artifactLink(
  tool: string,
  input: unknown,
  result: CallToolResult,
  titleOf: (id: string) => Promise<string | null>,
): Promise<ArtifactLink | null> {
  const action = ACTIONS[tool]
  const out = result.structuredContent
  if (!action || result.isError || !out || typeof out.id !== 'string') return null
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const named =
    typeof out.title === 'string' ? out.title : typeof args.title === 'string' ? args.title : null
  const title = named ?? (await titleOf(out.id))
  if (title === null) return null
  return {
    id: out.id,
    title,
    action,
    version: typeof out.version === 'number' ? out.version : null,
  }
}

/**
 * Whether an agent's tool call is a call to this tool of the `overbench` server, by its title as
 * each adapter writes it: `mcp__overbench__create_artifact` (Claude Code),
 * `mcp.overbench.create_artifact` (Codex) and `overbench_create_artifact` (OpenCode).
 */
export function callsTool(title: string, tool: string): boolean {
  const at = title.lastIndexOf(tool)
  if (at < 0 || at + tool.length !== title.length) return false
  return /overbench[._]{1,2}$/.test(title.slice(0, at))
}
