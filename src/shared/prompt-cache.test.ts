import { describe, expect, it } from 'vitest'
import type { AgentAccount } from './agent-host'
import {
  CACHE_DROP_MIN_INPUT_TOKENS,
  cacheExpiry,
  cacheHitOf,
  cacheSampleOf,
  detectCacheDrop,
  estimateCacheDropExtraCost,
  expiryOf,
  knownExpiry,
  type CachePrice,
  type CacheSample,
} from './prompt-cache'

const MINUTE = 60_000
const AT = 1_700_000_000_000

const account = (kind: AgentAccount['kind']): AgentAccount => ({
  kind,
  label: kind,
  email: null,
})

describe('prompt cache expiry', () => {
  it('uses the agent-reported TTL without marking it an estimate', () => {
    const expiry = expiryOf(
      'claude-code',
      { lastRequestAt: AT, ttl: 60 * MINUTE },
      'claude-opus-5-5',
      account('account'),
    )
    expect(expiry).toEqual({
      lastRequestAt: AT,
      ttl: 60 * MINUTE,
      expiresAt: AT + 60 * MINUTE,
      estimate: false,
    })
  })

  it('estimates a 5-minute TTL for Claude models on Antigravity', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'anthropic/claude-sonnet-4-6']) {
      const expiry = expiryOf('antigravity', { lastRequestAt: AT, ttl: null }, model, null)
      expect(expiry).toEqual({
        lastRequestAt: AT,
        ttl: 5 * MINUTE,
        expiresAt: AT + 5 * MINUTE,
        estimate: true,
      })
      expect(knownExpiry(expiry)).not.toBeNull()
    }
  })

  it('returns no fixed TTL for Gemini or unknown models on Antigravity', () => {
    for (const model of ['gemini-4-neon', 'gemini-4-neon-xhigh', 'gemini-3.8-flash', null]) {
      const expiry = expiryOf('antigravity', { lastRequestAt: AT, ttl: null }, model, null)
      expect(expiry).toEqual({
        lastRequestAt: AT,
        ttl: null,
        expiresAt: null,
        estimate: false,
      })
      expect(knownExpiry(expiry)).toBeNull()
    }
  })

  it('matches added multi-account agents by harness', () => {
    expect(
      expiryOf('codex~work', { lastRequestAt: AT, ttl: null }, 'gpt-5.5', account('account')),
    ).toEqual({
      lastRequestAt: AT,
      ttl: 30 * MINUTE,
      expiresAt: AT + 30 * MINUTE,
      estimate: true,
    })
    expect(
      expiryOf('codex~work', { lastRequestAt: AT, ttl: null }, 'gpt-5.4', account('api_key')),
    ).toEqual({
      lastRequestAt: AT,
      ttl: 5 * MINUTE,
      expiresAt: AT + 5 * MINUTE,
      estimate: true,
    })
    expect(
      expiryOf('codex~work', { lastRequestAt: AT, ttl: null }, 'gpt-5.5', account('gateway')),
    ).toEqual({
      lastRequestAt: AT,
      ttl: null,
      expiresAt: null,
      estimate: false,
    })
    expect(
      expiryOf(
        'opencode~work',
        { lastRequestAt: AT, ttl: null },
        'anthropic/claude-sonnet-5-5',
        null,
      ),
    ).toEqual({
      lastRequestAt: AT,
      ttl: 5 * MINUTE,
      expiresAt: AT + 5 * MINUTE,
      estimate: true,
    })
    expect(
      expiryOf('opencode~work', { lastRequestAt: AT, ttl: null }, 'openai/gpt-5.6-sol/high', null),
    ).toEqual({
      lastRequestAt: AT,
      ttl: 30 * MINUTE,
      expiresAt: AT + 30 * MINUTE,
      estimate: true,
    })
    expect(
      expiryOf('antigravity~work', { lastRequestAt: AT, ttl: null }, 'claude-opus-5-5', null),
    ).toEqual({
      lastRequestAt: AT,
      ttl: 5 * MINUTE,
      expiresAt: AT + 5 * MINUTE,
      estimate: true,
    })
    expect(
      expiryOf('antigravity~work', { lastRequestAt: AT, ttl: null }, 'gemini-4-neon', null),
    ).toEqual({
      lastRequestAt: AT,
      ttl: null,
      expiresAt: null,
      estimate: false,
    })
  })

  it('reads the model option from a session view in cacheExpiry', () => {
    const expiry = cacheExpiry(
      {
        agentId: 'antigravity~work',
        config: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            value: 'claude-sonnet-5-5',
          },
        ],
        usage: {
          used: 40_000,
          size: 200_000,
          cost: null,
          tokens: null,
          cache: { lastRequestAt: AT, ttl: null },
        },
      },
      null,
    )
    expect(expiry).toEqual({
      lastRequestAt: AT,
      ttl: 5 * MINUTE,
      expiresAt: AT + 5 * MINUTE,
      estimate: true,
    })
  })
})

describe('cacheHitOf', () => {
  it('computes hit share and token counts for completed requests', () => {
    expect(
      cacheHitOf({
        at: AT,
        input: 800,
        cacheRead: 39_200,
        cacheWrite: null,
        output: 350,
        ms: 2_400,
      }),
    ).toEqual({
      at: AT,
      cacheRead: 39_200,
      cacheWrite: null,
      uncachedInput: 800,
      totalInput: 40_000,
      share: 0.98,
    })

    // Cold cache (0% hit) is still reported when input tokens are present.
    expect(
      cacheHitOf({
        at: AT,
        input: 12_000,
        cacheRead: 0,
        cacheWrite: null,
        output: 200,
        ms: 1_500,
      }),
    ).toEqual({
      at: AT,
      cacheRead: 0,
      cacheWrite: null,
      uncachedInput: 12_000,
      totalInput: 12_000,
      share: 0,
    })

    // Includes cacheWrite in total input when reported.
    expect(
      cacheHitOf({
        at: AT,
        input: 1_000,
        cacheRead: 7_000,
        cacheWrite: 2_000,
        output: 100,
        ms: 1_000,
      }),
    ).toEqual({
      at: AT,
      cacheRead: 7_000,
      cacheWrite: 2_000,
      uncachedInput: 1_000,
      totalInput: 10_000,
      share: 0.7,
    })
  })

  it('returns null when request data is incomplete or empty', () => {
    expect(cacheHitOf(null)).toBeNull()
    expect(cacheHitOf(undefined)).toBeNull()
    // In-flight request (output is null) is skipped.
    expect(
      cacheHitOf({
        at: AT,
        input: 1_000,
        cacheRead: 9_000,
        cacheWrite: null,
        output: null,
        ms: null,
      }),
    ).toBeNull()
    // Missing cacheRead or input is skipped.
    expect(
      cacheHitOf({
        at: AT,
        input: 1_000,
        cacheRead: null,
        cacheWrite: null,
        output: 100,
        ms: 500,
      }),
    ).toBeNull()
    expect(
      cacheHitOf({
        at: AT,
        input: null,
        cacheRead: 1_000,
        cacheWrite: null,
        output: 100,
        ms: 500,
      }),
    ).toBeNull()
    // Zero total input is skipped.
    expect(
      cacheHitOf({
        at: AT,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 100,
        ms: 500,
      }),
    ).toBeNull()
  })
})

const SONNET_PRICE: CachePrice = {
  input: 0.000003,
  cacheRead: 0.0000003,
  cacheWrite: 0.00000375,
  cacheWrite1h: 0.000006,
}

const GPT_PRICE: CachePrice = {
  input: 0.0000025,
  cacheRead: 0.00000025,
  cacheWrite: 0,
}

function sample(
  overrides: Partial<{
    input: number
    cacheRead: number
    cacheWrite: number | null
    model: string | null
    at: number
  }> = {},
): CacheSample {
  return cacheSampleOf({
    input: overrides.input ?? 1_000,
    cacheRead: overrides.cacheRead ?? 36_000,
    cacheWrite: 'cacheWrite' in overrides ? overrides.cacheWrite : 3_000,
    model: 'model' in overrides ? overrides.model! : 'claude-sonnet-4-6',
    at: overrides.at ?? AT,
  })!
}

describe('cacheSampleOf', () => {
  it('computes hit share and total input from reliable token counts', () => {
    expect(
      cacheSampleOf({
        input: 1_000,
        cacheRead: 36_000,
        cacheWrite: 3_000,
        model: 'claude-sonnet-4-6',
        at: AT,
      }),
    ).toEqual({
      input: 1_000,
      cacheRead: 36_000,
      cacheWrite: 3_000,
      totalInput: 40_000,
      share: 0.9,
      model: 'claude-sonnet-4-6',
      at: AT,
    })

    // Cold cache (0 cacheRead) is valid when cacheRead is explicitly reported as 0.
    expect(
      cacheSampleOf({
        input: 40_000,
        cacheRead: 0,
        cacheWrite: null,
        model: 'gpt-5.4',
        at: AT,
      }),
    ).toEqual({
      input: 40_000,
      cacheRead: 0,
      cacheWrite: null,
      totalInput: 40_000,
      share: 0,
      model: 'gpt-5.4',
      at: AT,
    })
  })

  it('returns null when cacheRead or input is missing, negative, or total input is zero', () => {
    expect(
      cacheSampleOf({ input: 25_000, cacheRead: null, cacheWrite: null, model: null, at: AT }),
    ).toBeNull()
    expect(
      cacheSampleOf({ input: null, cacheRead: 25_000, cacheWrite: null, model: null, at: AT }),
    ).toBeNull()
    expect(
      cacheSampleOf({ input: -1, cacheRead: 25_000, cacheWrite: 0, model: null, at: AT }),
    ).toBeNull()
    expect(
      cacheSampleOf({ input: 100, cacheRead: 25_000, cacheWrite: -5, model: null, at: AT }),
    ).toBeNull()
    expect(cacheSampleOf({ input: 0, cacheRead: 0, cacheWrite: 0, model: null, at: AT })).toBeNull()
  })
})

describe('estimateCacheDropExtraCost', () => {
  it('computes API-priced extra cost for 5m cache writes, 1h cache writes, and OpenAI-style pricing', () => {
    // 50K total input, 90% baseline -> 0% current (all cacheWrite): 45K * ($3.75 - $0.30) / 1M = $0.15525
    const coldAnthropic = sample({ input: 0, cacheRead: 0, cacheWrite: 50_000 })
    expect(
      estimateCacheDropExtraCost({
        baselineShare: 0.9,
        current: coldAnthropic,
        price: SONNET_PRICE,
        cacheTtlMs: 5 * MINUTE,
      }),
    ).toBeCloseTo(0.1553, 4)

    // 1h cache write uses cacheWrite1h ($6/M): 45K * ($6.00 - $0.30) / 1M = $0.2565
    expect(
      estimateCacheDropExtraCost({
        baselineShare: 0.9,
        current: coldAnthropic,
        price: SONNET_PRICE,
        cacheTtlMs: 60 * MINUTE,
      }),
    ).toBeCloseTo(0.2565, 4)

    // OpenAI-style pricing (cacheWrite = 0, uncached input = $2.50/M, cacheRead = $0.25/M):
    // 50K total, 90% -> 10% => 40K lost * $2.25/M = $0.09
    const coldGpt = sample({ input: 45_000, cacheRead: 5_000, cacheWrite: 0, model: 'gpt-5.4' })
    expect(
      estimateCacheDropExtraCost({
        baselineShare: 0.9,
        current: coldGpt,
        price: GPT_PRICE,
        cacheTtlMs: 30 * MINUTE,
      }),
    ).toBeCloseTo(0.09, 4)
  })

  it('returns null when unpriced, lacking cache discount, or below the $0.01 threshold', () => {
    const cold = sample({ input: 40_000, cacheRead: 0, cacheWrite: 0 })
    expect(
      estimateCacheDropExtraCost({
        baselineShare: 0.9,
        current: cold,
        price: null,
        cacheTtlMs: null,
      }),
    ).toBeNull()
    expect(
      estimateCacheDropExtraCost({
        baselineShare: 0.9,
        current: cold,
        price: { input: 0.000003, cacheRead: 0, cacheWrite: 0 },
        cacheTtlMs: null,
      }),
    ).toBeNull()
    expect(
      estimateCacheDropExtraCost({
        baselineShare: 0.9,
        current: cold,
        price: { input: 0.0000001, cacheRead: 0.00000009, cacheWrite: 0 },
        cacheTtlMs: null,
      }),
    ).toBeNull()
  })
})

describe('detectCacheDrop', () => {
  it('returns null without a baseline, with missing cache data, or on small contexts', () => {
    const high = sample({ input: 1_000, cacheRead: 36_000, cacheWrite: 3_000 })
    const low = sample({ input: 38_000, cacheRead: 2_000, cacheWrite: 0, at: AT + 10_000 })
    const baseArgs = {
      knownExpiredBeforeSend: false,
      compacted: false,
      expiredMidTurn: false,
      requestCount: 1,
      price: SONNET_PRICE,
      cacheTtlMs: 5 * MINUTE,
    }

    // Cold first turn (no baseline)
    expect(detectCacheDrop({ ...baseArgs, baseline: null, current: low })).toBeNull()
    // Missing current measurement
    expect(detectCacheDrop({ ...baseArgs, baseline: high, current: null })).toBeNull()
    // Below minimum input token floor
    const smallBaseline = sample({
      input: 500,
      cacheRead: CACHE_DROP_MIN_INPUT_TOKENS - 1_000,
      cacheWrite: 0,
    })
    expect(detectCacheDrop({ ...baseArgs, baseline: smallBaseline, current: low })).toBeNull()
    const smallCurrent = sample({
      input: CACHE_DROP_MIN_INPUT_TOKENS - 1_000,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(detectCacheDrop({ ...baseArgs, baseline: high, current: smallCurrent })).toBeNull()
  })

  it('does not trigger for normal high hit rates, modest dips, low baselines, or large new-input dilution', () => {
    const high = sample({ input: 1_000, cacheRead: 36_000, cacheWrite: 3_000 }) // 90% of 40K
    const baseArgs = {
      knownExpiredBeforeSend: false,
      compacted: false,
      expiredMidTurn: false,
      requestCount: 1,
      price: SONNET_PRICE,
      cacheTtlMs: 5 * MINUTE,
    }

    // Normal high cache hit (92%)
    const stillHigh = sample({ input: 800, cacheRead: 36_800, cacheWrite: 2_400 })
    expect(detectCacheDrop({ ...baseArgs, baseline: high, current: stillHigh })).toBeNull()

    // Modest 15pp dip (90% -> 75%)
    const modestDip = sample({ input: 5_000, cacheRead: 30_000, cacheWrite: 5_000 })
    expect(detectCacheDrop({ ...baseArgs, baseline: high, current: modestDip })).toBeNull()

    // Low baseline (40% -> 5%) never established reliable caching
    const lowBaseline = sample({ input: 24_000, cacheRead: 16_000, cacheWrite: 0 })
    const cold = sample({ input: 38_000, cacheRead: 2_000, cacheWrite: 0 })
    expect(detectCacheDrop({ ...baseArgs, baseline: lowBaseline, current: cold })).toBeNull()

    // Single-request turn that kept the entire prior 40K context cached while pasting 50K new input:
    // 40K / 90K = 44.4% share, but zero cached context was lost.
    const diluted = sample({ input: 10_000, cacheRead: 40_000, cacheWrite: 40_000 })
    expect(detectCacheDrop({ ...baseArgs, baseline: high, current: diluted })).toBeNull()
  })

  it('deduplicates against pre-send known expiry', () => {
    const high = sample({ input: 1_000, cacheRead: 36_000, cacheWrite: 3_000 })
    const cold = sample({ input: 2_000, cacheRead: 0, cacheWrite: 38_000, at: AT + 10 * MINUTE })
    expect(
      detectCacheDrop({
        baseline: high,
        current: cold,
        knownExpiredBeforeSend: true,
        compacted: false,
        expiredMidTurn: false,
        requestCount: 1,
        price: SONNET_PRICE,
        cacheTtlMs: 5 * MINUTE,
      }),
    ).toBeNull()
  })

  it('reports real drops with measured figures, verifiable reasons only, and optional extra cost', () => {
    const high = sample({
      input: 1_000,
      cacheRead: 36_000,
      cacheWrite: 3_000,
      model: 'claude-sonnet-4-6',
    })
    const cold = sample({
      input: 2_000,
      cacheRead: 2_000,
      cacheWrite: 36_000,
      model: 'claude-sonnet-4-6',
      at: AT + 30_000,
    })

    // Unexplained drop (no verifiable cause, unpriced model): reason and extraCostUsd stay null
    expect(
      detectCacheDrop({
        baseline: high,
        current: cold,
        knownExpiredBeforeSend: false,
        compacted: false,
        expiredMidTurn: false,
        requestCount: 1,
        price: null,
        cacheTtlMs: null,
      }),
    ).toEqual({
      at: AT + 30_000,
      baselineShare: 0.9,
      currentShare: 0.05,
      baselineCacheRead: 36_000,
      currentCacheRead: 2_000,
      currentTotalInput: 40_000,
      missedTokens: 38_000,
      reason: null,
      extraCostUsd: null,
    })

    // Confirmed model change + confirmed API pricing
    const switchedModel = sample({
      input: 0,
      cacheRead: 0,
      cacheWrite: 40_000,
      model: 'claude-opus-4-6',
      at: AT + 60_000,
    })
    const modelDrop = detectCacheDrop({
      baseline: high,
      current: switchedModel,
      knownExpiredBeforeSend: false,
      compacted: false,
      expiredMidTurn: false,
      requestCount: 1,
      price: SONNET_PRICE,
      cacheTtlMs: 5 * MINUTE,
    })
    expect(modelDrop).toMatchObject({
      reason: 'model_changed',
      baselineShare: 0.9,
      currentShare: 0,
      currentCacheRead: 0,
      currentTotalInput: 40_000,
      missedTokens: 40_000,
    })
    expect(modelDrop?.extraCostUsd).toBeCloseTo(0.1242, 4)

    // Confirmed compaction
    expect(
      detectCacheDrop({
        baseline: high,
        current: cold,
        knownExpiredBeforeSend: false,
        compacted: true,
        expiredMidTurn: false,
        requestCount: 1,
        price: null,
        cacheTtlMs: null,
      })?.reason,
    ).toBe('compacted')

    // Confirmed mid-turn TTL expiry
    expect(
      detectCacheDrop({
        baseline: high,
        current: cold,
        knownExpiredBeforeSend: false,
        compacted: false,
        expiredMidTurn: true,
        requestCount: 2,
        price: null,
        cacheTtlMs: 5 * MINUTE,
      })?.reason,
    ).toBe('expired')
  })
})
