import { describe, expect, it } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import { isSleepMcpTool, isSleepToolEntry, isSleepToolName } from './interruptible-wait'

function toolEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: 't:1',
    title: 'clock.sleep',
    toolKind: 'other',
    status: 'in_progress',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...overrides,
  }
}

describe('interruptible wait detection', () => {
  it('recognizes standalone sleep tool names across harnesses and MCP formats', () => {
    for (const name of [
      'sleep',
      'Sleep',
      'clock.sleep',
      'CLOCK.SLEEP',
      'clock: sleep',
      'clock：sleep',
      'clock/sleep',
      'mcp__clock__sleep',
      'mcp__timer_tools__sleep',
      'timer: sleep',
    ]) {
      expect(isSleepToolName(name), name).toBe(true)
    }
  })

  it('rejects shell commands and non-sleep tools', () => {
    for (const name of [
      '',
      'Bash',
      'sleep 30',
      'sleep 60 && npm test',
      'Read sleep.ts',
      'Edit clock.ts',
      'kettu: report_step',
      'clock: now',
      'mcp__clock__sleep_mode',
      'timer: sleep_until',
    ]) {
      expect(isSleepToolName(name), name).toBe(false)
    }
  })

  it('matches sleep MCP server/tool pairs without matching unrelated tools', () => {
    expect(isSleepMcpTool('clock', 'sleep')).toBe(true)
    expect(isSleepMcpTool('clock', 'clock.sleep')).toBe(true)
    expect(isSleepMcpTool('My Clock', 'Sleep')).toBe(true)
    expect(isSleepMcpTool('clock', 'now')).toBe(false)
    expect(isSleepMcpTool('kettu', 'report_step')).toBe(false)
    expect(isSleepMcpTool('github', 'get_issue')).toBe(false)
  })

  it('matches only active non-shell sleep tool entries', () => {
    expect(isSleepToolEntry(toolEntry({ title: 'clock.sleep', status: 'in_progress' }))).toBe(true)
    expect(isSleepToolEntry(toolEntry({ title: 'clock: sleep', status: 'pending' }))).toBe(true)
    expect(isSleepToolEntry(toolEntry({ title: 'Sleep', status: 'in_progress' }))).toBe(true)

    expect(isSleepToolEntry(toolEntry({ title: 'clock.sleep', status: 'completed' }))).toBe(false)
    expect(isSleepToolEntry(toolEntry({ title: 'clock.sleep', status: 'failed' }))).toBe(false)
    expect(isSleepToolEntry(toolEntry({ title: 'sleep', toolKind: 'execute' }))).toBe(false)
    expect(isSleepToolEntry(toolEntry({ title: 'kettu: report_step' }))).toBe(false)
  })
})
