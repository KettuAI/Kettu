import { describe, expect, it } from 'vitest'
import { compactTokens, mapAccount } from './reports'

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

describe('compactTokens', () => {
  it('writes tokens as the context report does', () => {
    expect(compactTokens(671)).toBe('671')
    expect(compactTokens(32_100)).toBe('32.1k')
    expect(compactTokens(4000)).toBe('4k')
    expect(compactTokens(1_200_000)).toBe('1.2M')
  })
})
