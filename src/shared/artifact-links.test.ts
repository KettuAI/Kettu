import { describe, expect, it } from 'vitest'
import {
  artifactLink,
  headingSlug,
  parseArtifactLink,
  resolvePlace,
  slidePlace,
  type ArtifactPlace,
} from './artifact-links'

const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

describe('links to a place in an artifact', () => {
  it.each<[ArtifactPlace | null, string]>([
    [null, `kettu://artifact/${ID}`],
    [{ kind: 'frame', id: 'p_ab12' }, `kettu://artifact/${ID}/frame/p_ab12`],
    [{ kind: 'section', slug: 'risks' }, `kettu://artifact/${ID}/section/risks`],
    [{ kind: 'section', slug: '计划-a' }, `kettu://artifact/${ID}/section/%E8%AE%A1%E5%88%92-a`],
    [slidePlace(3, 'The Road ahead'), `kettu://artifact/${ID}/slide/3-the-road-ahead`],
    [slidePlace(4, null), `kettu://artifact/${ID}/slide/4`],
  ])('read back as they were written: %j', (place, link) => {
    expect(artifactLink(ID, place)).toBe(link)
    expect(parseArtifactLink(link)).toEqual({ artifactId: ID, place })
  })

  it.each([
    'https://example.com',
    'kettu://artifact/art_nope',
    `kettu://artifact/${ID}/frame`,
    `kettu://artifact/${ID}/frame/a/b`,
    `kettu://artifact/${ID}/frame/%3Cb%3E`,
    `kettu://artifact/${ID}/section/a%20b`,
    `kettu://artifact/${ID}/section/%E0%A4`,
    `kettu://artifact/${ID}/slide/0`,
    `kettu://artifact/${ID}/slide/x`,
    `kettu://artifact/${ID}/page/1`,
  ])('refuse anything else: %s', (link) => {
    expect(parseArtifactLink(link)).toBeNull()
  })

  it('find their place again in a later version', () => {
    const outline = {
      frames: [{ id: 'p1', name: 'Card' }],
      sections: [{ slug: 'risks', heading: 'Risks' }],
      slides: [
        { number: 1, title: 'Intro' },
        { number: 2, title: 'New' },
        { number: 3, title: 'The road ahead' },
      ],
    }
    expect(resolvePlace({ kind: 'frame', id: 'p1' }, outline)).toEqual({
      kind: 'frame',
      id: 'p1',
      name: 'Card',
    })
    expect(resolvePlace({ kind: 'frame', id: 'gone' }, outline)).toBeNull()
    expect(resolvePlace({ kind: 'section', slug: 'risks' }, outline)).toMatchObject({
      heading: 'Risks',
    })
    // A slide that moved is found by its title, one retitled by its number.
    expect(resolvePlace(slidePlace(2, 'The road ahead'), outline)).toMatchObject({ number: 3 })
    expect(resolvePlace(slidePlace(1, 'Old title'), outline)).toMatchObject({ number: 1 })
    expect(resolvePlace(slidePlace(9, null), outline)).toBeNull()
    expect(headingSlug('  ?! ')).toBe('section')
  })
})
