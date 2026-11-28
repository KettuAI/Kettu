import { describe, expect, it } from 'vitest'
import {
  antigravitySignIn,
  antigravitySignInMethod,
  antigravityTier,
  antigravityTierMultiple,
  antigravityTierSignIn,
} from './antigravity'

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

  it('extracts Ultra 5x and 20x tier multipliers from answer metadata', () => {
    expect(
      antigravityTierMultiple({
        antigravity: { tier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } },
      }),
    ).toBe('20x')
    expect(
      antigravityTierMultiple({
        antigravity: { tier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } },
      }),
    ).toBe('5x')
    expect(
      antigravityTierMultiple({
        antigravity: { tier: { id: 'g1-pro-tier', name: 'Google AI Pro' } },
      }),
    ).toBeNull()
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
