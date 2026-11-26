import { describe, expect, it } from 'vitest'
import type { AgentAccount } from './agent-host'
import { cacheExpiry, cacheHitOf, expiryOf, knownExpiry } from './prompt-cache'

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
