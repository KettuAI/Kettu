import { describe, expect, it } from 'vitest'
import { coverBoxOffset } from './above-box'

describe('coverBoxOffset', () => {
  it('lands the popup on the bottom of the input, covering it', () => {
    // The trigger sits in the control row, 8 px under the input.
    expect(coverBoxOffset(408, 400, 6)).toBe(8)
  })

  it('leaves no gap when the trigger already starts at the input bottom', () => {
    expect(coverBoxOffset(400, 400, 6)).toBe(0)
  })

  it('keeps the fallback gap when the trigger is not below the input', () => {
    expect(coverBoxOffset(390, 400, 6)).toBe(6)
  })
})
