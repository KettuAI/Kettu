import { describe, expect, it } from 'vitest'
import { hunkHeader } from './hunk-header'

const counts = { deletionStart: 1, deletionCount: 8, additionStart: 1, additionCount: 9 }

describe('hunkHeader', () => {
  it('keeps the ranges and drops the function name git adds', () => {
    expect(
      hunkHeader({ ...counts, hunkSpecs: '@@ -1,8 +1,9 @@ export function dayKey(ts) {' }),
    ).toBe('@@ -1,8 +1,9 @@')
    expect(hunkHeader({ ...counts, hunkSpecs: '@@ -3 +3 @@' })).toBe('@@ -3 +3 @@')
  })

  it('builds the header from the counts when the patch gave none', () => {
    expect(hunkHeader({ ...counts, hunkSpecs: undefined })).toBe('@@ -1,8 +1,9 @@')
  })
})
