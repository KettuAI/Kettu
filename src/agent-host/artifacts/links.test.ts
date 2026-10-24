import { describe, expect, it } from 'vitest'
import { artifactLink, callsTool } from './links'

const ID = 'art_01JB2QZ8X4K7M9N3P5R6S8T0VW'
const ok = (structuredContent: Record<string, unknown>) => ({ content: [], structuredContent })
const titled = (title: string | null) => () => Promise.resolve(title)

describe('callsTool', () => {
  it("knows the service's tools by each adapter's title", () => {
    expect(callsTool('mcp__overbench__create_artifact', 'create_artifact')).toBe(true)
    expect(callsTool('mcp.overbench.update_artifact', 'update_artifact')).toBe(true)
    expect(callsTool('overbench_read_artifact', 'read_artifact')).toBe(true)
  })

  it('refuses another server or tool', () => {
    expect(callsTool('mcp__other__create_artifact', 'create_artifact')).toBe(false)
    expect(callsTool('mcp__overbench__create_artifact', 'update_artifact')).toBe(false)
    expect(callsTool('mcp__overbench__create_artifact_now', 'create_artifact')).toBe(false)
    expect(callsTool('Write index.html', 'create_artifact')).toBe(false)
  })
})

describe('artifactLink', () => {
  it('takes the title from the call or its result', async () => {
    expect(
      await artifactLink(
        'create_artifact',
        { title: 'Deck', html: '' },
        ok({ id: ID, version: 1 }),
        titled(null),
      ),
    ).toEqual({ id: ID, title: 'Deck', action: 'create', version: 1 })
    expect(
      await artifactLink(
        'read_artifact',
        { id: ID },
        ok({ id: ID, title: 'Deck', version: 3 }),
        titled(null),
      ),
    ).toEqual({ id: ID, title: 'Deck', action: 'read', version: 3 })
  })

  it('looks the title up otherwise, and a delete has no version', async () => {
    expect(
      await artifactLink(
        'update_artifact',
        { id: ID, html: '' },
        ok({ id: ID, version: 2 }),
        titled('Deck'),
      ),
    ).toEqual({ id: ID, title: 'Deck', action: 'update', version: 2 })
    expect(
      await artifactLink('delete_artifact', { id: ID }, ok({ id: ID }), titled('Deck')),
    ).toEqual({ id: ID, title: 'Deck', action: 'delete', version: null })
  })

  it('makes none for a failed call, a list, or an artifact it cannot name', async () => {
    const failed = { ...ok({ code: 'conflict', message: '' }), isError: true }
    expect(await artifactLink('update_artifact', {}, failed, titled('Deck'))).toBeNull()
    expect(await artifactLink('list_artifacts', {}, ok({ artifacts: [] }), titled(null))).toBeNull()
    expect(await artifactLink('update_artifact', {}, ok({ id: ID }), titled(null))).toBeNull()
  })
})
