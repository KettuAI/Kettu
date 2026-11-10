// What a command block shows of a shell's output.

import type { HarnessId } from '@shared/agents'
import type { ToolEntry } from '@shared/thread'

/** A shell block shows this many of the output's last lines until opened. */
export const SHELL_TAIL = 12

/** The output's last lines, and how many come before them. */
export function shellTail(output: string): { shown: string; earlier: number } {
  const lines = output.replace(/\n$/, '').split('\n')
  if (lines.length <= SHELL_TAIL) return { shown: lines.join('\n'), earlier: 0 }
  return { shown: lines.slice(-SHELL_TAIL).join('\n'), earlier: lines.length - SHELL_TAIL }
}

// Claude Code's Bash puts a failed command's code on the result's first line.
const EXIT_LINE = /^(?:Error: )?Exit code (\d+)\r?\n?/

/**
 * The command's exit code and its output without the line that reported it. Only what is known
 * counts: a code the output states, or 0 for a command that completed under Claude Code or Codex,
 * which both fail a command that exits with any other code.
 */
export function exitOf(
  output: string | null,
  status: ToolEntry['status'],
  harness: HarnessId | null,
): { code: number | null; output: string | null } {
  const stated = output === null ? null : EXIT_LINE.exec(output)
  if (stated) return { code: Number(stated[1]), output: output!.slice(stated[0].length) }
  const strict = harness === 'claude-code' || harness === 'codex'
  return { code: status === 'completed' && strict ? 0 : null, output }
}

/** A run of output in one of the colors a shell block keeps. */
export interface AnsiRun {
  text: string
  tone: 'red' | 'green' | 'dim' | 'bold' | null
}

// Every escape sequence a terminal reads: CSI (colors, cursor moves), OSC (titles, links) and the
// two-character ones.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b(?:\[([0-9;?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/**
 * The output split by color, keeping only red, green, dim and bold, the colors that carry
 * meaning in test and build output; every other escape sequence is dropped.
 */
export function ansiRuns(text: string): AnsiRun[] {
  const runs: AnsiRun[] = []
  let tone: AnsiRun['tone'] = null
  let at = 0
  const push = (part: string) => {
    if (!part) return
    const last = runs[runs.length - 1]
    if (last && last.tone === tone) last.text += part
    else runs.push({ text: part, tone })
  }
  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(at, match.index))
    at = match.index + match[0].length
    if (match[2] !== 'm') continue
    const codes = (match[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      // A foreground, background or underline color by index (5;n) or by value (2;r;g;b).
      if (code === 38 || code === 48 || code === 58) {
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0
        continue
      }
      if (code === 0 || code === 39 || code === 22) tone = null
      else if (code === 31 || code === 91) tone = 'red'
      else if (code === 32 || code === 92) tone = 'green'
      else if (code === 2 || code === 90) tone = 'dim'
      else if (code === 1) tone = tone ?? 'bold'
    }
  }
  push(text.slice(at))
  return runs
}
