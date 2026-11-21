import { describe, expect, it } from 'vitest'
import { brewVersion } from './agent-updates'

describe("Homebrew's version of a formula or cask", () => {
  it("reads a formula's stable version and a cask's version without its build", () => {
    const formula = { formulae: [{ name: 'opencode-v2', versions: { stable: '2.0.40' } }] }
    expect(brewVersion(JSON.stringify(formula), false)).toBe('2.0.40')
    const cask = { casks: [{ token: 'codex', version: '0.170.0,abc123' }] }
    expect(brewVersion(JSON.stringify(cask), true)).toBe('0.170.0')
  })

  it('names none for an answer without a version', () => {
    expect(brewVersion('{"formulae":[]}', false)).toBeNull()
    expect(brewVersion(JSON.stringify({ casks: [{ version: 'latest' }] }), true)).toBeNull()
    expect(brewVersion('Error: No available formula', false)).toBeNull()
  })
})
