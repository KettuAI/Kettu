import { describe, expect, it } from 'vitest'
import { hiddenRemoval, promptsHidden } from './hidden-sessions'

const both = { closeSession: true, deleteSession: true }

describe('hidden session removal', () => {
  it("deletes Junie's hidden sessions only on the build that was checked", () => {
    expect(hiddenRemoval('junie', both, '26.10.27 (3893.5)')).toBe('delete')
    expect(hiddenRemoval('junie', both, '26.11.13 (4020.10)')).toBeNull()
    expect(hiddenRemoval('junie', both, null)).toBeNull()
    expect(
      hiddenRemoval('junie', { ...both, deleteSession: false }, '26.10.27 (3893.5)'),
    ).toBeNull()
  })

  it('opens none for an agent whose removal was not checked', () => {
    expect(hiddenRemoval('gemini', both, '0.40.0')).toBeNull()
  })

  it("closes agy's hidden sessions from 1.5.9 on, and never lets them be prompted", () => {
    expect(hiddenRemoval('antigravity', both, '1.5.9')).toBe('close-unprompted')
    expect(hiddenRemoval('antigravity', both, '1.6.0')).toBe('close-unprompted')
    expect(hiddenRemoval('antigravity', both, '1.4.3')).toBeNull()
    expect(hiddenRemoval('antigravity', both, null)).toBeNull()
    expect(hiddenRemoval('antigravity', { ...both, closeSession: false }, '1.5.9')).toBeNull()
    expect(promptsHidden('close-unprompted')).toBe(false)
    expect(promptsHidden('delete')).toBe(true)
    expect(promptsHidden(null)).toBe(false)
  })
})
