// A fork point for `session/fork`, which ACP's request cannot carry: both official adapters read
// one from `_meta.jetbrains.air.fork` and fork the session up to that message.

import { createHash } from 'node:crypto'
import { compareVersions } from '../versions'

// The first version of each adapter seen to honour it; the fake agent stands in for them.
const FORK_POINT_SINCE: ReadonlyMap<string, string> = new Map([
  ['@agentclientprotocol/claude-agent-acp', '0.94.0'],
  ['@agentclientprotocol/codex-acp', '2.2.2'],
  ['fake-agent', '0.1.0'],
])

/** Whether the agent `initialize` names forks at a fork point rather than ignoring it. */
export function forksAtMessage(
  info: { name: string; version: string } | null | undefined,
): boolean {
  if (!info) return false
  const since = FORK_POINT_SINCE.get(info.name)
  return since !== undefined && compareVersions(info.version, since) >= 0
}

export interface ForkPoint {
  messageId: string // the agent message's ACP messageId
  text: string // its text, which the adapters fall back to when they cannot find the id
  occurrence: number // 1-based, among the agent messages up to it with the same text
}

export function forkPointMeta(point: ForkPoint): Record<string, unknown> {
  return {
    jetbrains: {
      air: {
        fork: {
          version: 1,
          messageId: point.messageId,
          messageFingerprint: `sha256:${createHash('sha256').update(point.text, 'utf8').digest('hex')}`,
          messageOccurrence: point.occurrence,
        },
      },
    },
  }
}
