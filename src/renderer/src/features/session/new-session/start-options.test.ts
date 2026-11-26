import { describe, expect, it, vi } from 'vitest'
import type { AgentOptions } from '@shared/agent-host'
import type { ConfigOption } from '@shared/thread'
import { carryEffortPicks, preparedConfig, startConfig, startValues } from './start-options'

// The agents store reads the window's color scheme as it loads; these values never use it.
vi.mock('@renderer/stores/agents', () => ({}))

const select = (
  id: string,
  category: ConfigOption['category'],
  value: string,
  values: string[],
): ConfigOption => ({
  id,
  name: id,
  category,
  type: 'select',
  value,
  choices: values.map((v) => ({ value: v, name: v })),
})

const NEON = select('thought_level', 'thought_level', 'high', ['low', 'medium', 'high', 'xhigh'])
// Its default is not the level an xhigh pick carries to, so the two cannot be told apart by chance.
const CARBON = select('thought_level', 'thought_level', 'low', ['low', 'medium', 'high'])

const ENTRY: AgentOptions = {
  agentId: 'antigravity',
  config: [select('model', 'model', 'neon', ['neon', 'carbon', 'argon']), NEON],
  levels: { neon: NEON, carbon: CARBON },
  remembered: {},
  observedAt: 0,
}

const effortOf = (config: readonly ConfigOption[]) =>
  config.find((o) => o.category === 'thought_level')?.value

describe('the effort New session carries to a picked model', () => {
  it('keeps an effort the model offers, lowers one it lacks, and drops one it cannot tell', () => {
    const { config, levels } = ENTRY
    expect(carryEffortPicks(config, levels, { thought_level: 'medium' }, 'carbon')).toEqual({
      thought_level: 'medium',
    })
    expect(
      carryEffortPicks(config, levels, { mode: 'plan', thought_level: 'xhigh' }, 'carbon'),
    ).toEqual({ mode: 'plan', thought_level: 'high' })
    // Argon's levels are not known, so its own default applies.
    expect(carryEffortPicks(config, levels, { thought_level: 'xhigh' }, 'argon')).toEqual({})
  })

  it('starts on the nearest lower level when the effort chosen before is not offered', () => {
    const picks = { model: 'carbon', thought_level: 'xhigh' }
    expect(effortOf(startConfig(ENTRY, picks))).toBe('high')
    expect(startValues(ENTRY, picks)).toEqual({ model: 'carbon', thought_level: 'high' })
    const remembered = { ...ENTRY, remembered: { thought_level: 'xhigh' } }
    expect(effortOf(startConfig(remembered, { model: 'carbon' }))).toBe('high')
    expect(effortOf(preparedConfig(ENTRY.config, ENTRY.levels, picks))).toBe('high')
  })
})

describe('start values with a prepared session', () => {
  const MODE = select('mode', 'mode', 'default', [
    'default',
    'acceptEdits',
    'plan',
    'bypassPermissions',
  ])
  const CUSTOM = select('sandbox_net', 'other', 'off', ['off', 'on'])
  const CLAUDE_ENTRY: AgentOptions = {
    agentId: 'claude-code',
    config: [select('model', 'model', 'sonnet', ['sonnet', 'opus']), MODE, CUSTOM],
    levels: {},
    remembered: {},
    observedAt: 0,
  }

  it('preserves settled mode and non-remembered options from the prepared session', () => {
    const prepared = [
      select('model', 'model', 'sonnet', ['sonnet', 'opus']),
      select('mode', 'mode', 'bypassPermissions', [
        'default',
        'acceptEdits',
        'plan',
        'bypassPermissions',
      ]),
      select('sandbox_net', 'other', 'on', ['off', 'on']),
    ]
    expect(startValues(CLAUDE_ENTRY, {}, { startMode: true, prepared })).toEqual({
      mode: 'bypassPermissions',
      sandbox_net: 'on',
    })
  })

  it('keeps explicit mode even when it matches the cached agent default and overrides startMode', () => {
    const withStartMode: AgentOptions = { ...CLAUDE_ENTRY, startMode: 'acceptEdits' }
    const prepared = [
      select('model', 'model', 'sonnet', ['sonnet', 'opus']),
      select('mode', 'mode', 'default', ['default', 'acceptEdits', 'plan', 'bypassPermissions']),
      CUSTOM,
    ]
    expect(startValues(withStartMode, {}, { startMode: true, prepared })).toEqual({
      mode: 'default',
    })
  })

  it('keeps full access mode even if the cached config temporarily recorded full access', () => {
    const fullAccessDefault: AgentOptions = {
      ...CLAUDE_ENTRY,
      config: [
        select('model', 'model', 'sonnet', ['sonnet', 'opus']),
        select('mode', 'mode', 'bypassPermissions', [
          'default',
          'acceptEdits',
          'plan',
          'bypassPermissions',
        ]),
        CUSTOM,
      ],
    }
    expect(
      startValues(fullAccessDefault, {}, { startMode: true, prepared: fullAccessDefault.config }),
    ).toEqual({
      mode: 'bypassPermissions',
    })
  })

  it('gives unsettled in-flight picks precedence over the prepared session config', () => {
    const prepared = [
      select('model', 'model', 'sonnet', ['sonnet', 'opus']),
      select('mode', 'mode', 'bypassPermissions', [
        'default',
        'acceptEdits',
        'plan',
        'bypassPermissions',
      ]),
      select('sandbox_net', 'other', 'on', ['off', 'on']),
    ]
    expect(
      startValues(
        CLAUDE_ENTRY,
        { mode: 'plan', sandbox_net: 'off' },
        { startMode: true, prepared },
      ),
    ).toEqual({
      mode: 'plan',
    })
  })

  it('works when cached agent options are missing or provisional', () => {
    const prepared = [
      select('model', 'model', 'sonnet', ['sonnet', 'opus']),
      select('mode', 'mode', 'bypassPermissions', [
        'default',
        'acceptEdits',
        'plan',
        'bypassPermissions',
      ]),
      select('sandbox_net', 'other', 'on', ['off', 'on']),
    ]
    expect(startValues(undefined, {}, { startMode: true, prepared })).toEqual({
      model: 'sonnet',
      mode: 'bypassPermissions',
      sandbox_net: 'on',
    })
    const provisional: AgentOptions = {
      agentId: 'claude-code',
      config: [select('model', 'model', 'sonnet', ['sonnet', 'opus'])],
      levels: {},
      remembered: {},
      observedAt: 0,
      provisional: true,
    }
    expect(startValues(provisional, {}, { startMode: true, prepared })).toEqual({
      model: 'sonnet',
      mode: 'bypassPermissions',
      sandbox_net: 'on',
    })
  })

  it('uses the normal startMode when no prepared session is active and mode was not picked', () => {
    const withStartMode: AgentOptions = { ...CLAUDE_ENTRY, startMode: 'acceptEdits' }
    expect(startValues(withStartMode, {}, { startMode: true })).toEqual({
      mode: 'acceptEdits',
    })
  })

  it('sends a model reset back to the agent default when it differs from remembered', () => {
    const rememberedOpus: AgentOptions = {
      ...CLAUDE_ENTRY,
      remembered: { model: 'opus' },
    }
    expect(startValues(rememberedOpus, { model: 'sonnet' }, { startMode: true })).toEqual({
      model: 'sonnet',
    })
  })
})
