import { describe, expect, it } from 'vitest'
import { hiddenRemoval } from './hidden-sessions'

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
    expect(hiddenRemoval('antigravity', both, '1.4.3')).toBeNull()
  })
})
