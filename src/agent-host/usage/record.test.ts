import { describe, expect, it } from 'vitest'
import { estimateRowCost, priceFor, PRICES } from './model'
import { buildTurnUsage, parseTurnEntryId, recordRows } from './record'

describe('parseTurnEntryId', () => {
  it('extracts entry ids containing colons cleanly using the stored model column', () => {
    expect(
      parseTurnEntryId('ob:sess-1:e:42:claude-sonnet-4-6', 'sess-1', 'claude-sonnet-4-6'),
    ).toBe('e:42')
    expect(parseTurnEntryId('ob:sess-1:e:7:', 'sess-1', '')).toBe('e:7')
    expect(parseTurnEntryId('ob:sess-1:e:9:provider:model-v1', 'sess-1', 'provider:model-v1')).toBe(
      'e:9',
    )
    expect(parseTurnEntryId('ob:other:e:1:gpt-5.4', 'sess-1', 'gpt-5.4')).toBeNull()
    expect(parseTurnEntryId('ob:sess-1::gpt-5.4', 'sess-1', 'gpt-5.4')).toBeNull()
  })
})

describe('estimateRowCost', () => {
  it('computes API-priced cost for known models including 5m and 1h cache writes', () => {
    const model = Object.keys(PRICES.models).find(
      (name) => PRICES.models[name]!.cacheWrite1h !== undefined,
    )!
    const price = priceFor(model)!
    const result = estimateRowCost({
      model,
      input: 1000,
      output: 500,
      reasoning: 100,
      cacheRead: 4000,
      cacheWrite: 1500,
      cacheWrite1h: 500,
    })
    const expected =
      1000 * price.input +
      600 * price.output +
      4000 * price.cacheRead +
      1000 * price.cacheWrite +
      500 * price.cacheWrite1h!
    expect(result.fromPriceList).toBe(true)
    expect(result.costUsd).toBeCloseTo(expected, 10)
  })

  it('prefers confirmed reported cost over table estimation and returns null for unknown models', () => {
    expect(
      estimateRowCost({
        model: 'unknown-local-model-xyz',
        input: 5000,
        output: 1000,
        reasoning: null,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
      }),
    ).toEqual({ costUsd: null, fromPriceList: false })

    expect(
      estimateRowCost({
        model: 'unknown-local-model-xyz',
        input: 5000,
        output: 1000,
        reasoning: null,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        cost: 0.032,
      }),
    ).toEqual({ costUsd: 0.032, fromPriceList: false })
  })
})

describe('buildTurnUsage', () => {
  it('groups multi-model turns from recordRows and computes per-model and total API costs', () => {
    const pricedModels = Object.keys(PRICES.models).filter(
      (name) => PRICES.models[name]!.input > 0 && PRICES.models[name]!.output > 0,
    )
    const primary = pricedModels[0]!
    const secondary = pricedModels[1]!
    const rows = recordRows({
      sessionId: 's1',
      acpSessionId: 'acp1',
      agentId: 'claude-code',
      project: '/repo',
      turnEntryId: 'e:4',
      at: 1_700_000_000_000,
      tokens: null,
      models: [
        {
          model: `${primary}-20260101`,
          tokens: {
            total: 10_500,
            input: 1000,
            output: 500,
            thought: null,
            cacheRead: 8000,
            cacheWrite: 1000,
          },
        },
        {
          model: `${primary}[1m]`,
          tokens: {
            total: 2500,
            input: 500,
            output: 200,
            thought: null,
            cacheRead: 1800,
            cacheWrite: 0,
          },
        },
        {
          model: secondary,
          tokens: {
            total: 600,
            input: 200,
            output: 100,
            thought: null,
            cacheRead: 300,
            cacheWrite: 0,
          },
        },
      ],
      model: primary,
    })

    const usage = buildTurnUsage(rows, { subscription: true })
    expect(usage).not.toBeNull()
    expect(usage!.subscription).toBe(true)
    expect(usage!.pricesAsOf).toBe(PRICES.asOf)
    expect(usage!.partialCost).toBeUndefined()
    expect(usage!.models).toHaveLength(2)

    const primaryEntry = usage!.models.find((m) => m.model === primary)!
    expect(primaryEntry.input).toBe(1500)
    expect(primaryEntry.output).toBe(700)
    expect(primaryEntry.cacheRead).toBe(9800)
    expect(primaryEntry.cacheWrite).toBe(1000)
    expect(primaryEntry.costUsd).toBeGreaterThan(0)

    const secondaryEntry = usage!.models.find((m) => m.model === secondary)!
    expect(secondaryEntry.input).toBe(200)
    expect(secondaryEntry.output).toBe(100)
    expect(secondaryEntry.cacheRead).toBe(300)
    expect(secondaryEntry.cacheWrite).toBe(0)
    expect(secondaryEntry.costUsd).toBeGreaterThan(0)

    expect(usage!.costUsd).toBeCloseTo(primaryEntry.costUsd! + secondaryEntry.costUsd!, 10)
  })

  it('never fabricates $0.00 for unpriced models and marks mixed turns as partialCost', () => {
    const priced = Object.keys(PRICES.models).find((name) => PRICES.models[name]!.input > 0)!
    const unpricedOnly = buildTurnUsage([
      {
        model: 'custom-unpriced-model',
        input: 1000,
        output: 400,
        reasoning: null,
        cacheRead: 2000,
        cacheWrite: 0,
        cacheWrite1h: 0,
      },
    ])
    expect(unpricedOnly).toEqual({
      models: [
        {
          model: 'custom-unpriced-model',
          input: 1000,
          output: 400,
          cacheRead: 2000,
          cacheWrite: 0,
          costUsd: null,
        },
      ],
      costUsd: null,
    })

    const mixed = buildTurnUsage([
      {
        model: priced,
        input: 1000,
        output: 300,
        reasoning: null,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
      },
      {
        model: 'custom-unpriced-model',
        input: 2000,
        output: 500,
        reasoning: null,
        cacheRead: 1000,
        cacheWrite: 0,
        cacheWrite1h: 0,
      },
    ])
    expect(mixed).not.toBeNull()
    expect(mixed!.costUsd).toBeGreaterThan(0)
    expect(mixed!.partialCost).toBe(true)
    expect(mixed!.models[0]!.model).toBe(priced)
    expect(mixed!.models[1]!.costUsd).toBeNull()
  })

  it('preserves separate reasoning tokens for OpenCode turns and returns null for empty turns', () => {
    const rows = recordRows({
      sessionId: 's1',
      acpSessionId: 'acp1',
      agentId: 'opencode',
      project: '/repo',
      turnEntryId: 'e:9',
      at: 1_700_000_000_000,
      tokens: {
        total: 1700,
        input: 800,
        output: 500,
        thought: 400,
        cacheRead: 0,
        cacheWrite: 0,
      },
      models: [],
      model: 'custom-opencode-model',
    })
    const usage = buildTurnUsage(rows, { subscription: false })
    expect(usage).toEqual({
      models: [
        {
          model: 'custom-opencode-model',
          input: 800,
          output: 500,
          reasoning: 400,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: null,
        },
      ],
      costUsd: null,
      subscription: false,
    })

    expect(buildTurnUsage([])).toBeNull()
    expect(
      buildTurnUsage([
        {
          model: 'gpt-5.4',
          input: 0,
          output: 0,
          reasoning: null,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
        },
      ]),
    ).toBeNull()
  })
})
