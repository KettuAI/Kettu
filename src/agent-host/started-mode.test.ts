import { describe, expect, it } from 'vitest'
import { isFullAccessMode } from '@shared/agents'
import {
  defaultMode,
  FULL_ACCESS_RANK,
  inheritedMode,
  modeRank,
  resolveStartedScope,
  startableModes,
  startedCeiling,
  startedMode,
  starterRank,
  type ModeRank,
  type RankedHarness,
  type StartedScope,
} from './started-mode'

// The mode a started session gets when the starter asks for none:
// - In cross-scope (the default), its agent's start mode or own value, held to the ceiling.
// - In same-scope with a ranked starter, the parent's current effective permission tier directly.
function started(
  starter: { harness: RankedHarness; mode: string; planning?: boolean },
  agent: { harness: RankedHarness; mode: string | null },
  wanted?: string,
  scope: StartedScope = 'cross-scope',
): string {
  const rank = starterRank(starter.harness, starter.mode, starter.planning ?? false)
  const ceiling = startedCeiling(rank, agent.harness, agent.mode, scope)
  const fallback =
    scope === 'same-scope' && rank !== null
      ? inheritedMode(agent.harness, ceiling)
      : (agent.mode ?? defaultMode(agent.harness))
  return startedMode(agent.harness, wanted ?? fallback, ceiling)
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

  it('uses each ranked harness built-in default when agentMode is null instead of widening to 3', () => {
    expect(defaultMode('claude-code')).toBe('default')
    expect(defaultMode('codex')).toBe('agent')
    expect(defaultMode('deepseek')).toBe('workspace-write')
    expect(defaultMode('antigravity')).toBe('default')

    // With no explicit Settings > Agents start mode or resolved override, null falls back to each
    // harness's own built-in default so list_agents never promises wider modes than start_session.
    expect(startedCeiling(4, 'claude-code', null)).toBe(1)
    expect(startedCeiling(3, 'claude-code', null)).toBe(1)
    expect(startedCeiling(4, 'antigravity', null)).toBe(1)
    expect(startedCeiling(4, 'deepseek', null)).toBe(2)
    expect(startedCeiling(4, 'codex', null)).toBe(3)
    expect(startedCeiling(2, 'codex', null)).toBe(2)

    // Explicit resolved defaults (such as Claude Code permissions.defaultMode) raise the ceiling
    // up to STARTED_MAX (never full access), while staying bounded by the starter's rank.
    expect(startedCeiling(3, 'claude-code', 'acceptEdits')).toBe(2)
    expect(startedCeiling(3, 'claude-code', 'auto')).toBe(3)
    expect(startedCeiling(4, 'claude-code', 'bypassPermissions')).toBe(3)
    expect(startedCeiling(2, 'claude-code', 'auto')).toBe(2)
    expect(startedCeiling(3, 'claude-code', 'plan')).toBe(1)
    expect(startedCeiling(3, 'claude-code', 'dontAsk')).toBe(1)
  })

  it('keeps unranked harnesses uncapped as starters while ranking all four ranked harnesses consistently', () => {
    for (const harness of ['opencode', 'pi', 'gemini', 'cursor'] as const) {
      expect(starterRank(harness, 'default', false)).toBeNull()
    }
    expect(startedMode('claude-code', 'auto', startedCeiling(3, 'claude-code', null))).toBe(
      'default',
    )
    expect(
      startedMode('claude-code', 'acceptEdits', startedCeiling(3, 'claude-code', 'acceptEdits')),
    ).toBe('acceptEdits')
    expect(startedMode('deepseek', 'danger-full-access', startedCeiling(4, 'deepseek', null))).toBe(
      'workspace-write',
    )
  })

  it('inherits the parent effective permission rank (including Full access) under same-scope across harnesses', () => {
    // Full access parent -> every ranked target harness inherits Full access by default even when
    // the target agent's own default or Settings > Agents start mode is narrower.
    expect(
      started(
        { harness: 'claude-code', mode: 'bypassPermissions' },
        { harness: 'claude-code', mode: 'default' },
        undefined,
        'same-scope',
      ),
    ).toBe('bypassPermissions')
    expect(
      started(
        { harness: 'claude-code', mode: 'bypassPermissions' },
        { harness: 'codex', mode: 'read-only' },
        undefined,
        'same-scope',
      ),
    ).toBe('agent-full-access')
    expect(
      started(
        { harness: 'claude-code', mode: 'bypassPermissions' },
        { harness: 'antigravity', mode: 'default' },
        undefined,
        'same-scope',
      ),
    ).toBe('dangerously-skip-permissions')
    expect(
      started(
        { harness: 'claude-code', mode: 'bypassPermissions' },
        { harness: 'deepseek', mode: 'read-only' },
        undefined,
        'same-scope',
      ),
    ).toBe('danger-full-access')

    // Reverse cross-harness: Antigravity Full access parent -> Claude Code & Codex Full access.
    expect(
      started(
        { harness: 'antigravity', mode: 'dangerously-skip-permissions' },
        { harness: 'claude-code', mode: null },
        undefined,
        'same-scope',
      ),
    ).toBe('bypassPermissions')
    expect(
      started(
        { harness: 'codex', mode: 'agent-full-access' },
        { harness: 'antigravity', mode: null },
        undefined,
        'same-scope',
      ),
    ).toBe('dangerously-skip-permissions')

    // Lower parent modes map cleanly without escalating, and explicit narrower choices are honored.
    expect(
      started(
        { harness: 'claude-code', mode: 'auto' },
        { harness: 'deepseek', mode: null },
        undefined,
        'same-scope',
      ),
    ).toBe('workspace-write')
    expect(
      started(
        { harness: 'claude-code', mode: 'acceptEdits' },
        { harness: 'codex', mode: 'agent-full-access' },
        'agent-full-access',
        'same-scope',
      ),
    ).toBe('workspace-write')
    expect(
      started(
        { harness: 'claude-code', mode: 'bypassPermissions' },
        { harness: 'codex', mode: 'agent' },
        'read-only',
        'same-scope',
      ),
    ).toBe('read-only')
    expect(
      started(
        { harness: 'claude-code', mode: 'bypassPermissions' },
        { harness: 'antigravity', mode: 'default' },
        'auto',
        'same-scope',
      ),
    ).toBe('auto')
  })

  it('never grants Full access for unranked starters or when allowFullAccess is false', () => {
    expect(startedCeiling(null, 'claude-code', 'bypassPermissions', 'same-scope')).toBe(3)
    expect(startedCeiling(null, 'codex', 'agent-full-access', 'same-scope')).toBe(3)
    expect(startableModes('claude-code', FULL_ACCESS_RANK, { allowFullAccess: false })).toEqual([
      'default',
      'acceptEdits',
      'auto',
    ])
    expect(
      startedMode('claude-code', 'bypassPermissions', FULL_ACCESS_RANK, { allowFullAccess: false }),
    ).toBe('auto')
    expect(inheritedMode('antigravity', FULL_ACCESS_RANK, { allowFullAccess: false })).toBe('auto')
  })

  it('resolves same-scope only when parent, host, and project identities all verify and match', () => {
    const same = (a: string, b: string) => a === b
    expect(
      resolveStartedScope(
        {
          verifiedParent: true,
          parentHostId: 'host-a',
          targetHostId: 'host-a',
          parentProject: '/repo',
          targetProject: '/repo',
        },
        same,
      ),
    ).toBe('same-scope')
    // Cross-project fails closed.
    expect(
      resolveStartedScope(
        {
          verifiedParent: true,
          parentHostId: 'host-a',
          targetHostId: 'host-a',
          parentProject: '/repo',
          targetProject: '/other-repo',
        },
        same,
      ),
    ).toBe('cross-scope')
    // Cross-host fails closed even for identical path strings.
    expect(
      resolveStartedScope(
        {
          verifiedParent: true,
          parentHostId: 'host-a',
          targetHostId: 'host-b',
          parentProject: '/repo',
          targetProject: '/repo',
        },
        same,
      ),
    ).toBe('cross-scope')
    // Unverified parent or missing identities fail closed.
    expect(
      resolveStartedScope(
        {
          verifiedParent: false,
          parentHostId: 'host-a',
          targetHostId: 'host-a',
          parentProject: '/repo',
          targetProject: '/repo',
        },
        same,
      ),
    ).toBe('cross-scope')
    expect(
      resolveStartedScope(
        {
          verifiedParent: true,
          parentHostId: null,
          targetHostId: 'host-a',
          parentProject: '/repo',
          targetProject: '/repo',
        },
        same,
      ),
    ).toBe('cross-scope')
  })
})
