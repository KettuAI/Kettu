import { describe, expect, it } from 'vitest'
import { parseMistralAccount } from './mistral-vibe'

describe('Mistral account reply', () => {
  it('maps the recorded monthly budget', () => {
    const result = parseMistralAccount(
      {
        account: {
          plan: { kind: 'CHAT', name: 'Pro' },
          budget: { usage_percentage: 23, reset_at: '2026-12-01T00:00:00Z' },
        },
      },
      10,
    )
    expect(result?.tier).toBe('Pro')
    expect(result?.limits[0].usedPercent).toBe(23)
  })
})
