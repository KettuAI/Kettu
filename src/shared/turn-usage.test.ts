import { describe, expect, it } from 'vitest'
import {
  isSubscriptionAccount,
  isTurnModelUsage,
  isTurnUsage,
  summarizeTurnUsage,
  turnModelCacheHitRate,
  turnModelTotalInput,
  turnModelTotalTokens,
  type TurnModelUsage,
  type TurnUsage,
} from './turn-usage'

describe('turn-usage validation', () => {
  const validModel: TurnModelUsage = {
    model: 'claude-sonnet-4-6',
    input: 1200,
    output: 400,
    cacheRead: 8000,
    cacheWrite: 800,
    costUsd: 0.015,
  }

  it('accepts valid TurnModelUsage and TurnUsage payloads', () => {
    expect(isTurnModelUsage(validModel)).toBe(true)
    expect(isTurnModelUsage({ ...validModel, reasoning: 250, costUsd: null })).toBe(true)
    expect(
      isTurnUsage({
        models: [validModel],
        costUsd: 0.015,
        subscription: true,
        pricesAsOf: '2026-11-25',
      }),
    ).toBe(true)
    expect(
      isTurnUsage({
        models: [{ ...validModel, costUsd: null }],
        costUsd: null,
      }),
    ).toBe(true)
    expect(
      isTurnUsage({
        models: [validModel, { ...validModel, model: 'custom-model', costUsd: null }],
        costUsd: 0.015,
        partialCost: true,
      }),
    ).toBe(true)
  })

  it('rejects malformed payloads and negative or non-finite numbers', () => {
    expect(isTurnUsage(null)).toBe(false)
    expect(isTurnUsage({ models: [], costUsd: null })).toBe(false)
    expect(isTurnUsage({ models: [{ ...validModel, input: -1 }], costUsd: 0.01 })).toBe(false)
    expect(isTurnUsage({ models: [validModel], costUsd: Number.NaN })).toBe(false)
    expect(isTurnUsage({ models: [validModel], costUsd: -0.01 })).toBe(false)
    expect(isTurnUsage({ models: [validModel], costUsd: 0.01, partialCost: false })).toBe(false)
    expect(isTurnUsage({ models: [validModel], costUsd: 0.01, subscription: 'yes' })).toBe(false)
    expect(isTurnUsage({ models: [{ ...validModel, reasoning: -5 }], costUsd: 0.01 })).toBe(false)
  })
})

describe('turn-usage aggregation and cache hit rate', () => {
  it('computes per-model totals and cache hit rate matching Kettu usage formula', () => {
    const model: TurnModelUsage = {
      model: 'claude-sonnet-4-6',
      input: 1000,
      output: 500,
      cacheRead: 8000,
      cacheWrite: 1000,
      costUsd: 0.02,
    }
    expect(turnModelTotalInput(model)).toBe(10_000)
    expect(turnModelTotalTokens(model)).toBe(10_500)
    expect(turnModelCacheHitRate(model)).toBeCloseTo(0.8, 6)
  })

  it('handles zero-input and zero-cache edge cases safely without NaN', () => {
    const outputOnly: TurnModelUsage = {
      model: 'gpt-5.4',
      input: 0,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.002,
    }
    expect(turnModelTotalInput(outputOnly)).toBe(0)
    expect(turnModelCacheHitRate(outputOnly)).toBeNull()

    const noCacheRead: TurnModelUsage = {
      model: 'gpt-5.4',
      input: 2000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 500,
      costUsd: 0.005,
    }
    expect(turnModelCacheHitRate(noCacheRead)).toBe(0)
  })

  it('summarizes multi-model turns including separate reasoning tokens', () => {
    const usage: TurnUsage = {
      models: [
        {
          model: 'claude-opus-4-6',
          input: 1000,
          output: 600,
          reasoning: 200,
          cacheRead: 9000,
          cacheWrite: 0,
          costUsd: 0.05,
        },
        {
          model: 'claude-haiku-4-5',
          input: 500,
          output: 300,
          cacheRead: 3500,
          cacheWrite: 1000,
          costUsd: 0.004,
        },
      ],
      costUsd: 0.054,
    }
    const summary = summarizeTurnUsage(usage)
    expect(summary.input).toBe(1500)
    expect(summary.output).toBe(900)
    expect(summary.reasoning).toBe(200)
    expect(summary.cacheRead).toBe(12_500)
    expect(summary.cacheWrite).toBe(1000)
    expect(summary.totalInput).toBe(15_000)
    expect(summary.totalTokens).toBe(16_100)
    expect(summary.cacheHitRate).toBeCloseTo(12_500 / 15_000, 6)
  })
})

describe('isSubscriptionAccount', () => {
  it('identifies subscription plans versus pay-per-use billing accounts', () => {
    expect(isSubscriptionAccount('claude-code', { kind: 'account' })).toBe(true)
    expect(isSubscriptionAccount('codex', { kind: 'account' })).toBe(true)
    expect(isSubscriptionAccount('antigravity', { kind: 'account' })).toBe(true)
    expect(isSubscriptionAccount('claude-code~work', { kind: 'account' })).toBe(true)

    // DeepSeek platform account is a pay-as-you-go balance, not a flat subscription.
    expect(isSubscriptionAccount('deepseek', { kind: 'account' })).toBe(false)
    expect(isSubscriptionAccount('deepseek~work', { kind: 'account' })).toBe(false)

    // API keys, gateways, and external cloud providers are pay-per-use.
    expect(isSubscriptionAccount('claude-code', { kind: 'api_key' })).toBe(false)
    expect(isSubscriptionAccount('codex', { kind: 'gateway' })).toBe(false)
    expect(isSubscriptionAccount('claude-code', { kind: 'external' })).toBe(false)

    // Falls back to plan limits when account info is missing or none.
    expect(isSubscriptionAccount('claude-code', null, [{ window: 'five_hour' }])).toBe(true)
    expect(isSubscriptionAccount('claude-code', { kind: 'none' }, [{ window: 'seven_day' }])).toBe(
      true,
    )
    expect(isSubscriptionAccount('opencode', null, [])).toBeUndefined()
  })
})
