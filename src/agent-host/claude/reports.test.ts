import { describe, expect, it } from 'vitest'
import { compactTokens, mapAccount, mapAuthStatus } from './reports'

describe('the account a session runs under', () => {
  it('names the provider, then an API key, then the plan', () => {
    expect(mapAccount({ apiProvider: 'bedrock', subscriptionType: 'max' })).toEqual({
      kind: 'external',
      label: 'AWS Bedrock',
      email: null,
    })
    expect(mapAccount({ apiProvider: 'gateway' })).toMatchObject({ kind: 'gateway' })
    expect(
      mapAccount({
        apiProvider: 'firstParty',
        apiKeySource: 'ANTHROPIC_API_KEY',
        subscriptionType: 'max',
      }),
    ).toEqual({ kind: 'api_key', label: 'Anthropic API key', email: null })
    expect(mapAccount({ subscriptionType: 'Claude Pro', email: 'a@b.c' })).toEqual({
      kind: 'account',
      label: 'Claude Pro',
      email: 'a@b.c',
    })
  })

  it('reports nothing when Claude Code names no identity', () => {
    expect(mapAccount({ apiProvider: 'firstParty' })).toBeNull()
    expect(mapAccount({ apiProvider: 'firstParty', apiKeySource: 'none' })).toBeNull()
    expect(mapAccount(undefined)).toBeNull()
  })
})

describe("Claude Code's own sign-in status", () => {
  it('is signed out without a login, a key or another provider', () => {
    expect(
      mapAuthStatus('{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'),
    ).toEqual({
      kind: 'none',
      label: 'Not signed in',
      email: null,
    })
  })

  it('names a key, a provider or a plan as a session would', () => {
    expect(
      mapAuthStatus(
        '{"loggedIn": false, "apiKeySource": "apiKeyHelper", "apiProvider": "firstParty"}',
      ),
    ).toMatchObject({ kind: 'api_key' })
    expect(mapAuthStatus('{"loggedIn": false, "apiProvider": "vertex"}')).toMatchObject({
      kind: 'external',
      label: 'Google Vertex AI',
    })
    expect(
      mapAuthStatus(
        '{"loggedIn": true, "apiProvider": "firstParty", "email": "a@b.c", "subscriptionType": "max"}',
      ),
    ).toEqual({ kind: 'account', label: 'Claude Max', email: 'a@b.c' })
  })

  it('tells nothing from output it does not know', () => {
    expect(mapAuthStatus('not json')).toBeNull()
    expect(mapAuthStatus('{"authMethod": "none"}')).toBeNull()
    expect(mapAuthStatus('{"loggedIn": true, "apiProvider": "firstParty"}')).toBeNull()
  })
})

describe('compactTokens', () => {
  it('writes tokens as the context report does', () => {
    expect(compactTokens(671)).toBe('671')
    expect(compactTokens(32_100)).toBe('32.1k')
    expect(compactTokens(4000)).toBe('4k')
    expect(compactTokens(1_200_000)).toBe('1.2M')
  })
})
