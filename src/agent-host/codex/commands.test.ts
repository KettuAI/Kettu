import { describe, expect, it } from 'vitest'
import { commandList, parseCommand } from './commands'
import type { Model, SkillMetadata } from './protocol'

const NO_SPEED_MODEL: Model = {
  id: 'gpt-5.6-luna',
  displayName: 'gpt-5.6-luna',
  description: 'Model without speed tiers',
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }],
  defaultReasoningEffort: 'low',
  serviceTiers: [],
  isDefault: false,
}

const STANDARD_ONLY_MODEL: Model = {
  id: 'gpt-5.7-standard',
  displayName: 'gpt-5.7-standard',
  description: 'Model advertising only standard tier',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  serviceTiers: [{ id: 'default', name: 'Standard', description: 'Standard speed' }],
  isDefault: false,
}

const FAST_ONLY_MODEL: Model = {
  id: 'gpt-6.1-sol',
  displayName: 'gpt-6.1-sol',
  description: 'Model advertising only Fast',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
  isDefault: true,
}

const MULTI_TIER_MODEL: Model = {
  id: 'gpt-6.3-ultra',
  displayName: 'gpt-6.3-ultra',
  description: 'Model advertising both Fast and Ultrafast',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  serviceTiers: [
    { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest available responses' },
  ],
  isDefault: false,
}

const ULTRAFAST_ONLY_MODEL: Model = {
  id: 'gpt-6.3-sprint',
  displayName: 'gpt-6.3-sprint',
  description: 'Model advertising only Ultrafast',
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }],
  defaultReasoningEffort: 'low',
  serviceTiers: [
    { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest available responses' },
  ],
  isDefault: false,
}

const LEGACY_FAST_MODEL: Model = {
  id: 'gpt-6.0-legacy-fast',
  displayName: 'gpt-6.0-legacy-fast',
  description: 'Legacy additionalSpeedTiers model with fast only',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  additionalSpeedTiers: ['fast'],
  isDefault: false,
}

const LEGACY_MULTI_MODEL: Model = {
  id: 'gpt-6.0-legacy-multi',
  displayName: 'gpt-6.0-legacy-multi',
  description: 'Legacy additionalSpeedTiers model with fast and ultrafast',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  additionalSpeedTiers: ['fast', 'ultrafast'],
  isDefault: false,
}

const CUSTOM_TIER_MODEL: Model = {
  id: 'gpt-6.4-custom',
  displayName: 'gpt-6.4-custom',
  description: 'Model with Fast and a custom non-ultrafast tier',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  serviceTiers: [
    { id: 'priority', name: 'Fast', description: '2x speed' },
    { id: 'turbo', name: 'Turbo', description: 'Custom tier' },
  ],
  isDefault: false,
}

const SKILLS: SkillMetadata[] = [
  {
    name: 'build',
    description: 'Run project build checks',
    shortDescription: 'Build checks',
    path: '/skills/build/SKILL.md',
    enabled: true,
  },
]

const namesOf = (skills: readonly SkillMetadata[], model?: Model): string[] =>
  commandList(skills, model).map((command) => command.name)

describe('codex commandList speed command visibility', () => {
  it('omits both /fast and /ultrafast when the model advertises no speed tiers or is unknown', () => {
    for (const model of [undefined, NO_SPEED_MODEL, STANDARD_ONLY_MODEL]) {
      const names = namesOf(SKILLS, model)
      expect(names).not.toContain('fast')
      expect(names).not.toContain('ultrafast')
      expect(names).toContain('plan')
      expect(names).toContain('compact')
      expect(names).toContain('$build')
    }
  })

  it('includes /fast and omits /ultrafast for models advertising only Fast', () => {
    for (const model of [FAST_ONLY_MODEL, LEGACY_FAST_MODEL, CUSTOM_TIER_MODEL]) {
      const names = namesOf(SKILLS, model)
      expect(names).toContain('fast')
      expect(names).not.toContain('ultrafast')
      expect(names).toContain('$build')
    }
  })

  it('includes both /fast and /ultrafast for models advertising both tiers', () => {
    for (const model of [MULTI_TIER_MODEL, LEGACY_MULTI_MODEL]) {
      const list = commandList(SKILLS, model)
      const names = list.map((command) => command.name)
      expect(names).toContain('fast')
      expect(names).toContain('ultrafast')
      expect(list.find((command) => command.name === 'fast')?.inputHint).toBeTruthy()
      expect(list.find((command) => command.name === 'ultrafast')?.inputHint).toBeTruthy()
    }
  })

  it('includes /ultrafast and omits /fast for models advertising only Ultrafast', () => {
    const names = namesOf(SKILLS, ULTRAFAST_ONLY_MODEL)
    expect(names).not.toContain('fast')
    expect(names).toContain('ultrafast')
  })

  it('still parses manual /fast and /ultrafast prompts so unsupported models can reply cleanly', () => {
    expect(parseCommand([{ type: 'text', text: '/fast on' }])).toEqual({
      name: 'fast',
      rest: 'on',
    })
    expect(parseCommand([{ type: 'text', text: '/ultrafast status' }])).toEqual({
      name: 'ultrafast',
      rest: 'status',
    })
  })
})
