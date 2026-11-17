import { describe, expect, it } from 'vitest'
import { limitsForModel } from '@shared/plan-limits'
import type { ConfigOption } from '@shared/thread'
import {
  antigravityLimitsRead,
  antigravitySignIn,
  antigravitySignInMethod,
  antigravityTier,
  antigravityTierSignIn,
  parseAntigravityCredits,
  parseAntigravityUsage,
  replyError,
} from './antigravity'
import credits from './fixtures/agy-credits.json'
import usage from './fixtures/agy-usage.json'

const NOW = Date.UTC(2026, 10, 17, 3, 45)

describe('Google Antigravity plan', () => {
  it('reads the plan named in an answer', () => {
    expect(
      antigravityTier({
        antigravity: {
          tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: '' },
        },
      }),
    ).toBe('Google AI Pro')
  })

  it('gives null when the answer names no plan', () => {
    expect(antigravityTier(undefined)).toBeNull()
    expect(antigravityTier({ antigravity: { tier: { name: '', id: '' } } })).toBeNull()
    expect(antigravityTier({ antigravity: { enabledTools: ['run_command'] } })).toBeNull()
  })

  it('tells a personal Google plan from a business one by its id', () => {
    const plan = (id: unknown) => ({ antigravity: { tier: { name: 'A plan', id } } })
    // The ids agy 1.5.9 and the registry's server name: Google One's AI plans and the free tier
    // are personal; Gemini Enterprise, Google Cloud and pay-as-you-go ones are not.
    expect(antigravityTierSignIn(plan('g1-pro-tier'))).toBe('oauth-personal')
    expect(antigravityTierSignIn(plan('g1-ultra-tier'))).toBe('oauth-personal')
    expect(antigravityTierSignIn(plan('free-tier'))).toBe('oauth-personal')
    expect(antigravityTierSignIn(plan('gcp-ge-standard-tier'))).toBe('oauth-business')
    expect(antigravityTierSignIn(plan('gcp-ge-ultra-tier'))).toBe('oauth-business')
    expect(antigravityTierSignIn(plan('gcp-enterprise-tier'))).toBe('oauth-business')
    expect(antigravityTierSignIn(plan('business-paygo-tier'))).toBe('oauth-business')
    expect(antigravityTierSignIn(plan('some-new-tier'))).toBeNull()
    expect(antigravityTierSignIn(plan(7))).toBeNull()
    expect(antigravityTierSignIn(undefined)).toBeNull()
  })

  it('takes the sign-in from agy’s plan, then Kettu’s key, then agy’s auth state', () => {
    // agy names a plan only while signed in with Google, whatever signed it in before.
    expect(
      antigravitySignIn({ answered: 'oauth-personal', file: 'gemini-api-key', key: true }),
    ).toBe('oauth-personal')
    expect(antigravitySignIn({ answered: 'oauth-business', file: null, key: false })).toBe(
      'oauth-business',
    )
    // No plan shown: Kettu's key is the sign-in Kettu gives agy, whatever the file kept.
    expect(antigravitySignIn({ answered: null, file: 'oauth-personal', key: true })).toBe(
      'gemini-api-key',
    )
    // The file holds the last `authenticate` of any ACP client; a sign-in in agy's app or
    // terminal writes none.
    expect(antigravitySignIn({ answered: null, file: 'oauth-personal', key: false })).toBe(
      'oauth-personal',
    )
    expect(antigravitySignIn({ answered: null, file: 'agent-platform', key: false })).toBe(
      'agent-platform',
    )
    expect(antigravitySignIn({ answered: null, file: null, key: false })).toBeNull()
  })

  it('reads only the sign-in method from agy’s auth state', () => {
    expect(antigravitySignInMethod('{"methodId":"oauth-personal"}')).toBe('oauth-personal')
    expect(antigravitySignInMethod('{"methodId":"gemini-api-key","token":"x"}')).toBe(
      'gemini-api-key',
    )
    expect(antigravitySignInMethod('{"methodId":"Not a method"}')).toBeNull()
    expect(antigravitySignInMethod('not json')).toBeNull()
    expect(antigravitySignInMethod('')).toBeNull()
  })
})

describe('Google Antigravity plan limits', () => {
  // agy 1.5.9's `agy -p "/usage" --output-format json`, signed in with Google AI Pro.
  it('reads both windows of each model group', () => {
    expect(parseAntigravityUsage(usage, NOW)).toEqual({
      limits: [
        {
          window: 'seven_day_gemini_models',
          label: 'Weekly · Gemini Models',
          usedPercent: 100 - 0.9846937656402588 * 100,
          resetsAt: Date.UTC(2026, 10, 23, 17, 37, 8),
          state: 'ok',
          observedAt: NOW,
          models: ['Gemini 3.8 Flash'],
        },
        {
          window: 'five_hour_gemini_models',
          label: '5-hour · Gemini Models',
          usedPercent: 100 - 0.9820148944854736 * 100,
          resetsAt: Date.UTC(2026, 10, 17, 7, 35, 26),
          state: 'ok',
          observedAt: NOW,
          models: ['Gemini 3.8 Flash'],
        },
        {
          window: 'seven_day_claude_and_gpt_models',
          label: 'Weekly · Claude and GPT models',
          usedPercent: 0,
          resetsAt: Date.UTC(2026, 10, 24, 3, 42, 21),
          state: 'ok',
          observedAt: NOW,
          models: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'GPT-OSS 120B'],
        },
        {
          window: 'five_hour_claude_and_gpt_models',
          label: '5-hour · Claude and GPT models',
          usedPercent: 0,
          resetsAt: Date.UTC(2026, 10, 17, 8, 42, 21),
          state: 'ok',
          observedAt: NOW,
          models: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'GPT-OSS 120B'],
        },
      ],
      balances: [],
    })
  })

  it('reads a used-up window as reached, and skips a window or value it does not know', () => {
    const reply = {
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { window: '5h', remaining_fraction: 0, reset_time: '2026-11-17T07:35:26Z' },
                { window: 'monthly', remaining_fraction: 0.5 },
                { window: 'weekly', remaining_fraction: 'most' },
                { window: 'weekly', remaining_fraction: 1.5 },
                { window: 'weekly', remaining_fraction: 0.25 },
              ],
            },
          ],
        },
      },
    }
    expect(parseAntigravityUsage(reply, NOW)?.limits).toEqual([
      {
        window: 'five_hour_gemini_models',
        label: '5-hour · Gemini Models',
        usedPercent: 100,
        resetsAt: Date.UTC(2026, 10, 17, 7, 35, 26),
        state: 'reached',
        observedAt: NOW,
      },
      {
        window: 'seven_day_gemini_models',
        label: 'Weekly · Gemini Models',
        usedPercent: 75,
        resetsAt: null,
        state: 'ok',
        observedAt: NOW,
      },
    ])
  })

  it('reads no quota groups as no limits, and a failed or other reply as nothing', () => {
    const empty = { status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } }
    expect(parseAntigravityUsage(empty, NOW)).toEqual({ limits: [], balances: [] })
    // Signed out, agy answers so once its browser sign-in is stopped.
    const failed = {
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'authentication failed or timed out',
      num_turns: 0,
    }
    expect(parseAntigravityUsage(failed, NOW)).toBeNull()
    expect(replyError(failed)).toBe('authentication failed or timed out')
    expect(replyError(usage)).toBeNull()
    expect(parseAntigravityUsage(credits, NOW)).toBeNull()
    expect(parseAntigravityUsage({ status: 'SUCCESS', response: 'Quota' }, NOW)).toBeNull()
    expect(parseAntigravityUsage('not an object', NOW)).toBeNull()
  })

  it('reads the G1 credits left as a balance', () => {
    expect(parseAntigravityCredits(credits)).toEqual({
      label: 'G1 credits',
      amount: 0,
      currency: 'credits',
    })
    const some = {
      status: 'SUCCESS',
      command: { name: 'credits', data: { remaining_credits: 250 } },
    }
    expect(parseAntigravityCredits(some)?.amount).toBe(250)
    expect(parseAntigravityCredits(usage)).toBeNull()
    expect(parseAntigravityCredits({ status: 'ERROR', error: 'x' })).toBeNull()
  })

  it('counts a session only against its own model’s group', () => {
    const limits = parseAntigravityUsage(usage, NOW)!.limits
    const model = (value: string): ConfigOption => ({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      value,
      choices: [
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
        { value: 'gemini-4-preview', name: 'Gemini 4 Preview' },
      ],
    })
    const windows = (value: string) => limitsForModel(limits, model(value)).map((l) => l.window)
    expect(windows('gemini-3.8-flash')).toEqual([
      'seven_day_gemini_models',
      'five_hour_gemini_models',
    ])
    expect(windows('claude-sonnet-4-6')).toEqual([
      'seven_day_claude_and_gpt_models',
      'five_hour_claude_and_gpt_models',
    ])
    expect(windows('gpt-oss-120b-medium')).toHaveLength(2)
    // A model no group lists is held back by every window.
    expect(windows('gemini-4-preview')).toHaveLength(4)
  })

  it('runs agy only on a Google sign-in, since a signed-out agy opens a browser to sign in', () => {
    expect(antigravityLimitsRead('oauth-personal')).toBe('read')
    expect(antigravityLimitsRead('oauth-business')).toBe('read')
    // An API key or a cloud project has its usage in Google AI Studio or Google Cloud.
    expect(antigravityLimitsRead('gemini-api-key')).toBe('none')
    expect(antigravityLimitsRead('agent-platform')).toBe('none')
    // Unknown: Kettu asks agy for its plan first, and never runs `/usage` blind.
    expect(antigravityLimitsRead(null)).toBe('unknown')
  })
})
