import { describe, expect, it } from 'vitest'
import {
  applyOption,
  buildConfig,
  ConfigValueError,
  FAST_ID,
  fastTier,
  initialServiceTier,
  modelSpeedTiers,
  resolveServiceTier,
  SERVICE_TIER_ID,
  serviceTierParam,
  STANDARD_SERVICE_TIER,
  ultrafastTier,
  type Settings,
} from './config'
import type { Model } from './protocol'

const MULTI_TIER_MODEL: Model = {
  id: 'gpt-6.3-ultra',
  displayName: 'gpt-6.3-ultra',
  description: 'Model with both Fast and Ultrafast',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  serviceTiers: [
    { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest available responses' },
  ],
  isDefault: true,
}

const FAST_ONLY_MODEL: Model = {
  id: 'gpt-6.1-sol',
  displayName: 'gpt-6.1-sol',
  description: 'Model with only Fast',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
  isDefault: false,
}

const ULTRAFAST_ONLY_MODEL: Model = {
  id: 'gpt-6.3-sprint',
  displayName: 'gpt-6.3-sprint',
  description: 'Model with only Ultrafast',
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }],
  defaultReasoningEffort: 'low',
  serviceTiers: [
    { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest available responses' },
  ],
  isDefault: false,
}

const LEGACY_MULTI_MODEL: Model = {
  id: 'gpt-6.0-legacy',
  displayName: 'gpt-6.0-legacy',
  description: 'Legacy additionalSpeedTiers model',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  additionalSpeedTiers: ['fast', 'ultrafast'],
  isDefault: false,
}

const CUSTOM_TIER_MODEL: Model = {
  id: 'gpt-6.4-custom',
  displayName: 'gpt-6.4-custom',
  description: 'Model with custom tier',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
  defaultReasoningEffort: 'medium',
  serviceTiers: [
    { id: 'default', name: 'Standard', description: 'Should not duplicate standard' },
    { id: 'priority', name: 'Fast', description: '2x speed' },
    { id: 'priority', name: 'Fast dup', description: 'Duplicate ignored' },
    { id: 'turbo', name: 'Turbo', description: 'Custom tier description' },
  ],
  isDefault: false,
}

const NO_SPEED_MODEL: Model = {
  id: 'gpt-5.6-luna',
  displayName: 'gpt-5.6-luna',
  description: 'No speed tiers',
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }],
  defaultReasoningEffort: 'low',
  serviceTiers: [],
  additionalSpeedTiers: [],
  isDefault: false,
}

const MODELS: Model[] = [
  MULTI_TIER_MODEL,
  FAST_ONLY_MODEL,
  ULTRAFAST_ONLY_MODEL,
  LEGACY_MULTI_MODEL,
  CUSTOM_TIER_MODEL,
  NO_SPEED_MODEL,
]

function baseSettings(model: string, serviceTier: string | null = null): Settings {
  return {
    mode: 'agent',
    collaboration: 'default',
    model,
    effort: 'medium',
    serviceTier,
  }
}

describe('codex speed tiers config', () => {
  it('reads all non-standard speed tiers from serviceTiers and falls back to additionalSpeedTiers', () => {
    expect(modelSpeedTiers(MULTI_TIER_MODEL)).toEqual([
      { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
      { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest available responses' },
    ])
    expect(modelSpeedTiers(CUSTOM_TIER_MODEL)).toEqual([
      { id: 'priority', name: 'Fast', description: '2x speed' },
      { id: 'turbo', name: 'Turbo', description: 'Custom tier description' },
    ])
    expect(modelSpeedTiers(LEGACY_MULTI_MODEL).map((t) => t.id)).toEqual(['fast', 'ultrafast'])
    expect(modelSpeedTiers(NO_SPEED_MODEL)).toEqual([])
    expect(fastTier(MULTI_TIER_MODEL)).toBe('priority')
    expect(ultrafastTier(MULTI_TIER_MODEL)).toBe('ultrafast')
    expect(fastTier(ULTRAFAST_ONLY_MODEL)).toBeNull()
    expect(ultrafastTier(ULTRAFAST_ONLY_MODEL)).toBe('ultrafast')
  })

  it('normalizes fast/priority and ultrafast aliases against advertised tiers', () => {
    expect(resolveServiceTier('fast', MULTI_TIER_MODEL)).toBe('priority')
    expect(resolveServiceTier('PRIORITY', MULTI_TIER_MODEL)).toBe('priority')
    expect(resolveServiceTier('ultrafast', MULTI_TIER_MODEL)).toBe('ultrafast')
    expect(resolveServiceTier('ultra_fast', MULTI_TIER_MODEL)).toBe('ultrafast')
    expect(resolveServiceTier('ultra-fast', MULTI_TIER_MODEL)).toBe('ultrafast')
    expect(resolveServiceTier('default', MULTI_TIER_MODEL)).toBeNull()
    expect(resolveServiceTier('standard', MULTI_TIER_MODEL)).toBeNull()
    expect(resolveServiceTier('ultrafast', FAST_ONLY_MODEL)).toBeNull()
    expect(resolveServiceTier('priority', LEGACY_MULTI_MODEL)).toBe('fast')
    expect(resolveServiceTier('Turbo', CUSTOM_TIER_MODEL)).toBe('turbo')
    expect(initialServiceTier('default', MULTI_TIER_MODEL)).toBeNull()
    expect(initialServiceTier('ultra_fast', MULTI_TIER_MODEL)).toBe('ultrafast')
  })

  it('emits service-tier select for multi-tier and non-fast models, and fast-mode toggle for single-fast models', () => {
    const multi = buildConfig(baseSettings(MULTI_TIER_MODEL.id, 'ultrafast'), MODELS)
    expect(multi.find((o) => o.id === FAST_ID)).toBeUndefined()
    const speedOption = multi.find((o) => o.id === SERVICE_TIER_ID)
    expect(speedOption).toMatchObject({
      id: SERVICE_TIER_ID,
      category: 'model_config',
      type: 'select',
      value: 'ultrafast',
    })
    expect(speedOption?.choices?.map((c) => c.value)).toEqual([
      STANDARD_SERVICE_TIER,
      'priority',
      'ultrafast',
    ])
    expect(speedOption?.choices?.[1]?.description).toBe('2x speed, increased usage')
    expect(speedOption?.choices?.[2]?.description).toBe('Fastest available responses')

    const fastOnly = buildConfig(baseSettings(FAST_ONLY_MODEL.id, 'priority'), MODELS)
    expect(fastOnly.find((o) => o.id === SERVICE_TIER_ID)).toBeUndefined()
    expect(fastOnly.find((o) => o.id === FAST_ID)).toMatchObject({
      id: FAST_ID,
      category: 'model_config',
      type: 'boolean',
      value: true,
    })

    const ultraOnly = buildConfig(baseSettings(ULTRAFAST_ONLY_MODEL.id, null), MODELS)
    expect(ultraOnly.find((o) => o.id === FAST_ID)).toBeUndefined()
    expect(ultraOnly.find((o) => o.id === SERVICE_TIER_ID)?.choices?.map((c) => c.value)).toEqual([
      STANDARD_SERVICE_TIER,
      'ultrafast',
    ])

    const none = buildConfig(baseSettings(NO_SPEED_MODEL.id, 'ultrafast'), MODELS)
    expect(none.find((o) => o.id === FAST_ID)).toBeUndefined()
    expect(none.find((o) => o.id === SERVICE_TIER_ID)).toBeUndefined()
  })

  it('accepts both service-tier and legacy fast-mode in applyOption and rejects unsupported tiers', () => {
    let settings = baseSettings(MULTI_TIER_MODEL.id)
    settings = applyOption(settings, MODELS, SERVICE_TIER_ID, 'ultrafast')
    expect(settings.serviceTier).toBe('ultrafast')
    settings = applyOption(settings, MODELS, SERVICE_TIER_ID, 'fast')
    expect(settings.serviceTier).toBe('priority')
    settings = applyOption(settings, MODELS, SERVICE_TIER_ID, 'default')
    expect(settings.serviceTier).toBeNull()

    // Legacy fast-mode values still work on multi-tier models.
    settings = applyOption(settings, MODELS, FAST_ID, true)
    expect(settings.serviceTier).toBe('priority')
    settings = applyOption(settings, MODELS, FAST_ID, 'off')
    expect(settings.serviceTier).toBeNull()
    settings = applyOption(settings, MODELS, FAST_ID, 'on')
    expect(settings.serviceTier).toBe('priority')

    // Rejects unknown or unsupported tiers.
    expect(() => applyOption(settings, MODELS, SERVICE_TIER_ID, 'warp')).toThrow(ConfigValueError)
    expect(() =>
      applyOption(baseSettings(FAST_ONLY_MODEL.id), MODELS, SERVICE_TIER_ID, 'ultrafast'),
    ).toThrow(ConfigValueError)
    expect(() =>
      applyOption(baseSettings(NO_SPEED_MODEL.id), MODELS, SERVICE_TIER_ID, 'priority'),
    ).toThrow(ConfigValueError)
  })

  it('omits serviceTierParam when unsupported and sends default/exact tier when supported', () => {
    expect(serviceTierParam({ serviceTier: null }, NO_SPEED_MODEL)).toBeUndefined()
    expect(serviceTierParam({ serviceTier: 'priority' }, NO_SPEED_MODEL)).toBeUndefined()
    expect(serviceTierParam({ serviceTier: null }, MULTI_TIER_MODEL)).toBe('default')
    expect(serviceTierParam({ serviceTier: 'fast' }, MULTI_TIER_MODEL)).toBe('priority')
    expect(serviceTierParam({ serviceTier: 'ultrafast' }, MULTI_TIER_MODEL)).toBe('ultrafast')
    // Ultrafast is unsupported on a Fast-only model, so omit instead of sending an invalid tier.
    expect(serviceTierParam({ serviceTier: 'ultrafast' }, FAST_ONLY_MODEL)).toBeUndefined()
  })
})
