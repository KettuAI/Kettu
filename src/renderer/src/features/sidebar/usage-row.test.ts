import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@renderer/lib/i18n'
import { costText } from './usage-row'

afterEach(() => i18n.changeLanguage('en'))

describe('costText', () => {
  it("writes today's cost in dollars", () => {
    expect(costText(4.2)).toBe('$4.20')
    expect(costText(1234)).toBe('$1,234')
  })

  it('has nothing to show while the cost is zero or without a price', () => {
    expect(costText(0)).toBeNull()
    expect(costText(null)).toBeNull()
  })
})
