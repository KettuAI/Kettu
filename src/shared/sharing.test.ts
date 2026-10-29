import { describe, expect, it } from 'vitest'
import { CLOUDFLARE_TOKENS_URL } from './sharing'

describe('CLOUDFLARE_TOKENS_URL', () => {
  it('is Cloudflare form for a token with Workers Scripts Edit and the name filled in', () => {
    const url = new URL(CLOUDFLARE_TOKENS_URL)

    expect(`${url.origin}${url.pathname}`).toBe('https://dash.cloudflare.com/profile/api-tokens')
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys') ?? 'null')).toEqual([
      { key: 'workers_scripts', type: 'edit' },
    ])
    expect(url.searchParams.get('accountId')).toBe('*')
    expect(url.searchParams.get('zoneId')).toBe('all')
    expect(url.searchParams.get('name')).toBe('Kettu')
  })
})
