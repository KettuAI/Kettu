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
