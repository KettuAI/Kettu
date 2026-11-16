import { describe, expect, it } from 'vitest'
import { antigravityTier } from './antigravity'

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
})
