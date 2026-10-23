import { describe, expect, it } from 'vitest'
import { ARTIFACT_ID } from '@shared/artifacts'
import { newArtifactId, ulid } from './ids'

describe('artifact ids', () => {
  it('encodes the time in ten characters and 80 random bits in sixteen', () => {
    // The specification's example time.
    expect(ulid(1469918176385, new Uint8Array(10)).slice(0, 10)).toBe('01ARYZ6S41')
    expect(ulid(0, new Uint8Array(10))).toBe('0'.repeat(26))
    expect(ulid(2 ** 48 - 1, new Uint8Array(10).fill(255))).toBe('7' + 'Z'.repeat(25))
    expect(() => ulid(2 ** 48)).toThrow()
    expect(() => ulid(1, new Uint8Array(9))).toThrow()
  })

  it('makes ids of the art_ form that sort by time', () => {
    const earlier = newArtifactId(1_700_000_000_000)
    const later = newArtifactId(1_700_000_000_001)
    expect(earlier).toMatch(ARTIFACT_ID)
    expect(later).toMatch(ARTIFACT_ID)
    expect(earlier < later).toBe(true)
    expect(newArtifactId()).not.toBe(newArtifactId())
  })
})
