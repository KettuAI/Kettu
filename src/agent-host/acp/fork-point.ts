// A fork point for `session/fork`, which ACP's request cannot carry: an agent that honours it reads
// one from `_meta.jetbrains.air.fork` and forks the session up to that message.

import { createHash } from 'node:crypto'
import type { ForkPoint } from '../connection'
import { compareVersions } from '../versions'

// The first version of each agent seen to honour it: the fake agent, in the adapters' old form.
const FORK_POINT_SINCE: ReadonlyMap<string, string> = new Map([['fake-agent', '0.1.0']])

/** Whether the agent `initialize` names forks at a fork point rather than ignoring it. */
export function forksAtMessage(
  info: { name: string; version: string } | null | undefined,
): boolean {
  if (!info) return false
  const since = FORK_POINT_SINCE.get(info.name)
  return since !== undefined && compareVersions(info.version, since) >= 0
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
