import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { ArtifactOrigins, artifactHost, artifactUrl, originId } from './origins'

const ID = 'art_01JB2QZ8X4K7M9N3P5R6S8T0VW'

describe('originId', () => {
  it("is the first 26 hex characters of the SHA-256 of the artifact's id", () => {
    const hash = createHash('sha256').update(ID).digest('hex')
    expect(originId(ID)).toBe(hash.slice(0, 26))
    expect(artifactUrl(ID)).toBe(`kettu-artifact://${hash.slice(0, 26)}/`)
  })

  it('gives two artifacts two origins', () => {
    expect(originId(ID)).not.toBe(originId('art_01JB2QZ8X4K7M9N3P5R6S8T0VX'))
  })
})

describe('artifactHost', () => {
  const host = originId(ID)

  it('reads the origin id of an artifact URL or origin', () => {
    expect(artifactHost(`kettu-artifact://${host}/?v=2`)).toBe(host)
    expect(artifactHost(`kettu-artifact://${host}`)).toBe(host)
  })

  it.each([
    undefined,
    null,
    '',
    'null',
    'file://',
    `https://${host}/`,
    'kettu-artifact://not-an-origin/',
    `kettu-artifact://${host.toUpperCase()}/`,
    `kettu-artifact://${host}x/`,
  ])('is null for %s', (value) => {
    expect(artifactHost(value)).toBeNull()
  })
})

describe('ArtifactOrigins', () => {
  const windowA = {} as WebContents
  const windowB = {} as WebContents

  it('serves an opened artifact for the rest of the run and lets only that window frame it', () => {
    const origins = new ArtifactOrigins()
    expect(origins.artifactOf(originId(ID))).toBeUndefined()
    const url = origins.open(windowA, ID)
    expect(origins.artifactOf(originId(ID))).toBe(ID)
    expect(origins.isOpenedIn(windowA, `${url}?page=1.1`)).toBe(true)
    expect(origins.isOpenedIn(windowB, url)).toBe(false)
    origins.close(windowA, url)
    expect(origins.isOpenedIn(windowA, url)).toBe(false)
    expect(origins.artifactOf(originId(ID))).toBe(ID)
  })

  it('counts every open, so a second view keeps the origin open after the first closes', () => {
    const origins = new ArtifactOrigins()
    const url = origins.open(windowA, ID)
    origins.open(windowA, ID)
    origins.close(windowA, url)
    expect(origins.isOpenedIn(windowA, url)).toBe(true)
    origins.close(windowA, url)
    origins.close(windowA, url)
    expect(origins.isOpenedIn(windowA, url)).toBe(false)
    origins.open(windowA, ID)
    expect(origins.isOpenedIn(windowA, url)).toBe(true)
  })

  it("forgets a window's origins when its page loads again, and only that window's", () => {
    const origins = new ArtifactOrigins()
    const window = new EventEmitter() as unknown as WebContents
    origins.watch(window)
    const url = origins.open(window, ID)
    origins.open(windowA, ID)
    window.emit('did-navigate', {}, 'http://localhost:5173/', 200, 'OK')
    expect(origins.isOpenedIn(window, url)).toBe(false)
    expect(origins.isOpenedIn(windowA, url)).toBe(true)
    expect(origins.artifactOf(originId(ID))).toBe(ID)
  })

  it('ignores closing what was never opened', () => {
    const origins = new ArtifactOrigins()
    origins.close(windowA, 'https://example.com/')
    origins.close(windowA, artifactUrl(ID))
    expect(origins.isOpenedIn(windowA, artifactUrl(ID))).toBe(false)
  })
})
