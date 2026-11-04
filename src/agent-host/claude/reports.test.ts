import { describe, expect, it } from 'vitest'
import { mapAccount } from './reports'

describe('mapAccount', () => {
  it('reads a subscription sign-in as an account', () => {
    expect(
      mapAccount({ subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' }),
    ).toMatchObject({ kind: 'account', label: 'Claude Max' })
  })

  it('keeps a subscription token from CLAUDE_CODE_OAUTH_TOKEN an account', () => {
    expect(
      mapAccount({ subscriptionType: 'pro', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }),
    ).toMatchObject({ kind: 'account', label: 'Claude Pro' })
  })

  it('reads an API key as an API key', () => {
    expect(mapAccount({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })).toEqual({
      kind: 'api_key',
      label: 'Anthropic API key',
      email: null,
    })
  })

  // Claude Code names only the token's source for a bearer token, such as a key for another
  // provider's address, and the stored sign-in must not stand in for it.
  it('reads ANTHROPIC_AUTH_TOKEN as a gateway, not as the stored subscription', () => {
    expect(mapAccount({ tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' })).toEqual({
      kind: 'gateway',
      label: 'Custom model gateway',
      email: null,
    })
  })

  it('lets ANTHROPIC_AUTH_TOKEN win over a subscription the same answer names', () => {
    expect(
      mapAccount({ subscriptionType: 'max', tokenSource: 'ANTHROPIC_AUTH_TOKEN' }),
    ).toMatchObject({ kind: 'gateway' })
  })
})
