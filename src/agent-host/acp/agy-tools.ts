// agy's tool calls in the shape the ACP mapper reads every agent's. agy 1.5.9 sends a command's
// input as `{ CommandLine, toolSummary }` and its output under a header of times and the exit code.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import { fenced } from '../codex/mapper'
import { toLf } from '../session-updates'

const RESULT = /^Created At: [^\n]*\nCompleted At: [^\n]*\nCommand exited with code (-?\d+)\.\n\n/
const OUTPUT = 'Command output:\n'
const NO_OUTPUT = 'No output from the command.'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** What a finished command printed, and its exit code; null for a result of another shape. */
function commandResult(text: string): { output: string; exitCode: number } | null {
  const match = RESULT.exec(toLf(text))
  if (!match) return null
  const rest = toLf(text).slice(match[0].length)
  const output = rest.startsWith(OUTPUT)
    ? rest.slice(OUTPUT.length)
    : rest === NO_OUTPUT
      ? ''
      : null
  if (output === null) return null
  return { output: output.replace(/\n+$/, ''), exitCode: Number(match[1]) }
}

/** A command's call: its command line with what it says it does, and what it printed. */
function command(update: acp.ToolCallUpdate, line: string, summary: unknown): acp.ToolCallUpdate {
  const shaped: acp.ToolCallUpdate = {
    ...update,
    rawInput:
      typeof summary === 'string' ? { command: line, description: summary } : { command: line },
  }
  const block = update.content?.length === 1 ? update.content[0] : undefined
  if (block?.type !== 'content' || block.content.type !== 'text') return shaped
  const result = commandResult(block.content.text)
  if (!result) return shaped
  shaped.content = result.output
    ? [{ type: 'content', content: { type: 'text', text: fenced(result.output) } }]
    : []
  // agy reports a command that exited non-zero as completed; Claude Code and Codex fail it.
  if (update.status === 'completed' && result.exitCode !== 0) shaped.status = 'failed'
  return shaped
}

/** An agy tool call as the mapper reads it. */
export function fromAgy<T extends acp.ToolCallUpdate>(update: T): T {
  const input = record(update.rawInput)
  if (typeof input?.CommandLine === 'string') {
    return command(update, input.CommandLine, input.toolSummary) as T
  }
  return update
}
