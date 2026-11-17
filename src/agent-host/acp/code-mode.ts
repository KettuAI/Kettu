// Code Mode's `execute` calls in the shape the ACP mapper reads every agent's. OpenCode 2.0.32 ends
// a script that threw as completed, with `metadata.error` set and the error as its content.

import type * as acp from '@agentclientprotocol/sdk/unstable'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A script's call, failed when it threw, as other agents' failed calls are. */
export function fromCodeMode<T extends acp.ToolCallUpdate>(update: T): T {
  if (update.status !== 'completed') return update
  const threw = record(record(update.rawOutput)?.metadata)?.error === true
  return threw ? { ...update, status: 'failed' } : update
}
