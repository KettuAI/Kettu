import { describe, expect, it } from 'vitest'
import { isFullAccessMode } from '@shared/agents'
import {
  defaultMode,
  modeRank,
  startableModes,
  startedCeiling,
  startedMode,
  starterRank,
  type ModeRank,
  type RankedHarness,
} from './started-mode'

// The mode a started session gets when the starter asks for none: its agent's start mode or own
// value, held to the ceiling.
function started(
  starter: { harness: RankedHarness; mode: string; planning?: boolean },
  agent: { harness: RankedHarness; mode: string | null },
  wanted?: string,
): string {
  const rank = starterRank(starter.harness, starter.mode, starter.planning ?? false)
  const ceiling = startedCeiling(rank, agent.harness, agent.mode)
  return startedMode(agent.harness, wanted ?? agent.mode ?? 'default', ceiling)
}

describe('the mode of a started session', () => {
  it('follows a Claude Code starter down for a Codex session in Auto review', () => {
    const codex = { harness: 'codex', mode: 'agent' } as const
    expect(started({ harness: 'claude-code', mode: 'auto' }, codex)).toBe('agent')
    expect(started({ harness: 'claude-code', mode: 'acceptEdits' }, codex)).toBe('workspace-write')
    expect(started({ harness: 'claude-code', mode: 'default' }, codex)).toBe('read-only')
  })

  it('holds a session to its agent start mode however wide the starter is', () => {
    const codex = { harness: 'codex', mode: 'read-only' } as const
    expect(started({ harness: 'claude-code', mode: 'auto' }, codex)).toBe('read-only')
    expect(started({ harness: 'claude-code', mode: 'auto' }, codex, 'agent')).toBe('read-only')
  })

  it('never gives full access, even when the agent and the starter have it', () => {
    const claude = { harness: 'claude-code', mode: 'bypassPermissions' } as const
    expect(started({ harness: 'claude-code', mode: 'bypassPermissions' }, claude)).toBe('auto')
    const codex = { harness: 'codex', mode: 'agent' } as const
    expect(started({ harness: 'codex', mode: 'agent-full-access' }, codex)).toBe('agent')
    expect(started({ harness: 'claude-code', mode: 'auto' }, codex, 'agent-full-access')).toBe(
      'agent',
    )
    const dsh = { harness: 'deepseek', mode: 'danger-full-access' } as const
    expect(started({ harness: 'claude-code', mode: 'auto' }, dsh)).toBe('workspace-write')
    const agy = { harness: 'antigravity', mode: 'auto' } as const
    expect(started({ harness: 'antigravity', mode: 'dangerously-skip-permissions' }, agy)).toBe(
      'auto',
    )
    expect(
      started({ harness: 'claude-code', mode: 'auto' }, agy, 'dangerously-skip-permissions'),
    ).toBe('auto')
  })

  it("ranks agy's modes, with Kettu's full access over agy's flag as the widest", () => {
    expect(isFullAccessMode('dangerously-skip-permissions')).toBe(true)
    const ranks = ['default', 'plan', 'accept-edits', 'auto', 'dangerously-skip-permissions'].map(
      (mode) => modeRank('antigravity', mode),
    )
    expect(ranks).toEqual([1, 1, 2, 3, 4])
    expect(defaultMode('antigravity')).toBe('default')
    expect(startableModes('antigravity', 3)).toEqual(['default', 'accept-edits', 'auto'])
    // agy starts in Default, so a session it is given starts there whatever the starter's mode.
    const agy = { harness: 'antigravity', mode: 'default' } as const
    expect(started({ harness: 'claude-code', mode: 'auto' }, agy)).toBe('default')
    const codex = { harness: 'codex', mode: 'agent' } as const
    expect(started({ harness: 'antigravity', mode: 'accept-edits' }, codex)).toBe('workspace-write')
    expect(started({ harness: 'antigravity', mode: 'plan' }, codex)).toBe('read-only')
  })

  it('counts planning and modes it does not know as asking', () => {
    const codex = { harness: 'codex', mode: 'agent' } as const
    expect(started({ harness: 'claude-code', mode: 'plan' }, codex)).toBe('read-only')
    expect(started({ harness: 'codex', mode: 'agent', planning: true }, codex)).toBe('read-only')
    expect(started({ harness: 'claude-code', mode: 'someNewMode' }, codex)).toBe('read-only')
    const claude = { harness: 'claude-code', mode: 'someNewMode' } as const
    expect(started({ harness: 'claude-code', mode: 'auto' }, claude)).toBe('default')
  })

  it('never picks a plan mode', () => {
    const claude = { harness: 'claude-code', mode: 'plan' } as const
    expect(started({ harness: 'claude-code', mode: 'auto' }, claude)).toBe('default')
    const dsh = { harness: 'deepseek', mode: 'workspace-write' } as const
    expect(started({ harness: 'claude-code', mode: 'auto' }, dsh, 'plan')).toBe('read-only')
    for (const harness of ['claude-code', 'codex', 'deepseek', 'antigravity'] as const) {
      for (const ceiling of [1, 2, 3] as ModeRank[]) {
        expect(startableModes(harness, ceiling)).not.toContain('plan')
      }
    }
  })

  it('gives a narrower mode the starter asks for and lowers a wider one', () => {
    const codex = { harness: 'codex', mode: 'agent' } as const
    expect(started({ harness: 'claude-code', mode: 'auto' }, codex, 'read-only')).toBe('read-only')
    expect(started({ harness: 'claude-code', mode: 'acceptEdits' }, codex, 'agent')).toBe(
      'workspace-write',
    )
  })

  it('leaves agents whose modes it cannot rank uncapped', () => {
    expect(starterRank('opencode', 'build', false)).toBeNull()
    const codex = { harness: 'codex', mode: 'agent' } as const
    expect(startedCeiling(null, codex.harness, codex.mode)).toBe(3)
  })

  it('offers no mode above the ceiling and none with full access', () => {
    expect(startableModes('claude-code', 3)).toEqual(['default', 'acceptEdits', 'auto'])
    expect(startableModes('codex', 2)).toEqual(['read-only', 'workspace-write'])
    expect(startableModes('deepseek', 3)).toEqual(['read-only', 'workspace-write'])
  })
})
