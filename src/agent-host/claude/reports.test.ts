import { describe, expect, it } from 'vitest'
import { mapAuthStatus } from './reports'

const signedIn = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'me@example.com',
  subscriptionType: 'max',
}

const status = (fields: Record<string, unknown>): string => JSON.stringify(fields)

describe('mapAuthStatus', () => {
  it('reads when a stored subscription sign-in ends', () => {
    const account = mapAuthStatus(
      status({ ...signedIn, loginExpiresAt: '2026-12-02T13:46:01.033Z' }),
    )
    expect(account).toMatchObject({ kind: 'account', email: 'me@example.com' })
    expect(account?.signInEnds).toBe(Date.parse('2026-12-02T13:46:01.033Z'))
  })

  it('gives no end when the field is null, missing or not an instant', () => {
    for (const loginExpiresAt of [
      null,
      undefined,
      '',
      'soon',
      '2026-13-45T00:00:00Z',
      1764683161,
    ]) {
      const account = mapAuthStatus(status({ ...signedIn, loginExpiresAt }))
      expect(account?.kind).toBe('account')
      expect(account).not.toHaveProperty('signInEnds')
    }
  })

  it('gives no end to a sign-in other than a subscription', () => {
    const key = mapAuthStatus(
      status({
        loggedIn: true,
        authMethod: 'api_key',
        apiKeySource: 'ANTHROPIC_API_KEY',
        loginExpiresAt: '2026-12-02T13:46:01.033Z',
      }),
    )
    expect(key?.kind).toBe('api_key')
    expect(key).not.toHaveProperty('signInEnds')
    const out = mapAuthStatus(
      status({ loggedIn: false, authMethod: 'none', loginExpiresAt: '2026-12-02T13:46:01Z' }),
    )
    expect(out?.kind).toBe('none')
    expect(out).not.toHaveProperty('signInEnds')
  })

  it('keeps reading a status that is not JSON as unknown', () => {
    expect(mapAuthStatus('Not logged in')).toBeNull()
  })
})
