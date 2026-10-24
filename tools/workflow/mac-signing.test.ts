import { describe, expect, it } from 'vitest'
import { decide, readPresence, SECRETS, summary } from './mac-signing.mjs'

const CERTIFICATE = ['CSC_LINK', 'CSC_KEY_PASSWORD']
const API_KEY = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
const APPLE_ID = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

const failure = (present: string[]) => {
  const decision = decide(present)
  if (!('failure' in decision))
    throw new Error(`expected a failure, got ${JSON.stringify(decision)}`)
  return decision.failure
}

describe('decide', () => {
  it('keeps ad-hoc signing when no secret is set', () => {
    expect(decide([])).toEqual({ signed: false })
  })

  it('signs and notarizes with the API key', () => {
    expect(decide([...CERTIFICATE, ...API_KEY])).toEqual({
      signed: true,
      notarize: 'api-key',
      unused: [],
    })
  })

  it('signs and notarizes with the Apple ID', () => {
    expect(decide([...CERTIFICATE, ...APPLE_ID])).toEqual({
      signed: true,
      notarize: 'apple-id',
      unused: [],
    })
  })

  it('prefers the API key when both are set', () => {
    expect(decide(SECRETS)).toEqual({ signed: true, notarize: 'api-key', unused: ['apple-id'] })
  })

  it('fails on a certificate without its password, and the reverse', () => {
    expect(failure(['CSC_LINK', ...API_KEY])).toBe(
      'macOS signing is half configured: CSC_LINK is set, but CSC_KEY_PASSWORD is not. Set all of the certificate (CSC_LINK and CSC_KEY_PASSWORD), or none of it.',
    )
    expect(failure(['CSC_KEY_PASSWORD'])).toContain('CSC_KEY_PASSWORD is set, but CSC_LINK is not')
  })

  it('fails on a certificate with nothing to notarize with', () => {
    expect(failure(CERTIFICATE)).toBe(
      'macOS signing is half configured: the certificate (CSC_LINK and CSC_KEY_PASSWORD) is set, but nothing to notarize with. Set the App Store Connect API key (APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER) or the Apple ID (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID).',
    )
  })

  it('fails on notarization credentials without the certificate', () => {
    expect(failure(API_KEY)).toContain(
      'notarization credentials are set, but the certificate (CSC_LINK and CSC_KEY_PASSWORD) is not',
    )
    expect(failure(APPLE_ID)).toContain('the certificate (CSC_LINK and CSC_KEY_PASSWORD) is not')
  })

  it('fails on any part of a notarization set', () => {
    for (const set of [API_KEY, APPLE_ID]) {
      for (const name of set) {
        const partial = set.filter((other) => other !== name)
        expect(failure([...CERTIFICATE, ...partial])).toContain(`${name} is not`)
        expect(failure([...CERTIFICATE, name])).toContain(`${name} is set`)
      }
    }
  })

  it('fails on a partial Apple ID even when the API key is complete', () => {
    expect(failure([...CERTIFICATE, ...API_KEY, 'APPLE_TEAM_ID'])).toContain(
      'APPLE_TEAM_ID is set, but APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD are not',
    )
  })
})

describe('summary', () => {
  it('names the path and the credentials', () => {
    expect(summary({ signed: false })).toBe(
      'macOS: no signing secrets are set, so the builds are ad-hoc signed and updates link to the release (Link mode).',
    )
    expect(summary({ signed: true, notarize: 'apple-id', unused: [] })).toBe(
      'macOS: signed with the Developer ID from the certificate (CSC_LINK and CSC_KEY_PASSWORD) and notarized with the Apple ID (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID), so updates install in place (Install mode).',
    )
    expect(summary({ signed: true, notarize: 'api-key', unused: ['apple-id'] })).toContain(
      'notarized with the App Store Connect API key (APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER), so updates install in place (Install mode). The Apple ID (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID) is set too and is not used.',
    )
  })
})

describe('readPresence', () => {
  const all = (value: string) =>
    Object.fromEntries(SECRETS.map((name) => [`HAS_${name}`, value])) as Record<string, string>

  it('reads true and false for every secret', () => {
    expect(readPresence(all('false'))).toEqual({ present: [], problems: [] })
    expect(readPresence({ ...all('false'), HAS_CSC_LINK: 'true' })).toEqual({
      present: ['CSC_LINK'],
      problems: [],
    })
  })

  it('refuses a missing or unexpected value instead of reading it as unset', () => {
    const env: Record<string, string | undefined> = { ...all('false'), HAS_CSC_LINK: '' }
    delete env.HAS_APPLE_TEAM_ID
    expect(readPresence(env).problems).toEqual([
      'HAS_CSC_LINK must be true or false.',
      'HAS_APPLE_TEAM_ID must be true or false.',
    ])
  })
})
