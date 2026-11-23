import { describe, expect, it } from 'vitest'
import type { ArtifactChanges } from '@shared/artifact-changes'
import {
  landingPlace,
  markVersions,
  startAt,
  stepFrom,
  walkPlaces,
  walkRange,
  type WalkInput,
} from './change-walk'

const base: WalkInput = {
  head: 19,
  openedAt: 19,
  seenAtOpen: 19,
  asked: null,
  arrived: null,
  arrivedOwn: false,
}

const frames = (...ids: string[]): ArtifactChanges => ({
  kind: 'frames',
  frames: ids.map((id) => ({ id, name: id, file: `${id}.html` })),
})

describe('walkRange', () => {
  it('counts from the version the user last saw', () => {
    expect(walkRange({ ...base, seenAtOpen: 17 })).toEqual({ from: 17, to: 19, since: true })
    expect(walkRange({ ...base, seenAtOpen: 18 })).toEqual({ from: 18, to: 19, since: false })
  })

  it('shows nothing once the newest version was seen, never seen, or not recorded', () => {
    expect(walkRange(base)).toBeNull()
    expect(walkRange({ ...base, seenAtOpen: null })).toBeNull()
    expect(walkRange({ ...base, seenAtOpen: undefined })).toBeNull()
  })

  it('takes what the card that opened it compared', () => {
    expect(walkRange({ ...base, asked: { from: 18, to: 19 }, seenAtOpen: 12 })).toEqual({
      from: 18,
      to: 19,
      since: false,
    })
  })

  it('ignores a card of an earlier version than the newest', () => {
    expect(walkRange({ ...base, asked: { from: 16, to: 17 }, seenAtOpen: 19 })).toBeNull()
  })

  it('takes a version that arrived while viewing over everything else', () => {
    const arrived = { ...base, head: 20, arrived: { from: 19, to: 20 }, seenAtOpen: 12 }
    expect(walkRange({ ...arrived, asked: { from: 18, to: 19 } })).toEqual({
      from: 19,
      to: 20,
      since: false,
    })
  })

  it('shows no pill for a version the user wrote', () => {
    expect(
      walkRange({ ...base, head: 20, arrived: { from: 19, to: 20 }, arrivedOwn: true }),
    ).toBeNull()
  })
})

describe('walkPlaces', () => {
  it('walks frames, slides and passages in order, and lists a page files', () => {
    expect(walkPlaces(frames('a', 'b')).map((p) => p.key)).toEqual(['a', 'b'])
    expect(
      walkPlaces({ kind: 'slides', slides: [{ number: 3, title: null }] }).map((p) => p.key),
    ).toEqual(['3'])
    expect(
      walkPlaces({
        kind: 'sections',
        headings: ['A'],
        sections: [{ heading: 'A', slug: 'a', passages: 2 }],
        passages: [
          { change: 'added', section: 'a', from: 10, to: 20 },
          { change: 'changed', section: 'a', from: 30, to: 40 },
        ],
      }).map((p) => p.kind === 'passage' && p.at),
    ).toEqual([10, 30])
    expect(walkPlaces({ kind: 'files', paths: ['index.html'] })[0]).toMatchObject({
      kind: 'file',
      path: 'index.html',
    })
  })
})

describe('markVersions', () => {
  it('marks each place with the version that last changed it', () => {
    const marks = markVersions({ to: 19 }, frames('a', 'b', 'c'), [frames('a', 'b'), frames('b')])
    expect([...marks]).toEqual([
      ['a', 18],
      ['b', 19],
      ['c', 19],
    ])
  })

  it('marks everything with the last version without the steps', () => {
    expect([...markVersions({ to: 19 }, frames('a'), null)]).toEqual([['a', 19]])
  })

  it('marks a document by its sections', () => {
    const doc = (slugs: string[]): ArtifactChanges => ({
      kind: 'sections',
      headings: slugs,
      sections: slugs.map((slug) => ({ heading: slug, slug, passages: 1 })),
      passages: [],
    })
    expect([...markVersions({ to: 4 }, doc(['a', 'b']), [doc(['a']), null])]).toEqual([
      ['a', 3],
      ['b', 4],
    ])
  })
})

describe('startAt and stepFrom', () => {
  it('starts at the place asked for, else the first', () => {
    const places = walkPlaces(frames('a', 'b', 'c'))
    expect(startAt(places, 'b')).toBe(1)
    expect(startAt(places, 'x')).toBe(0)
    expect(startAt(places, null)).toBe(0)
  })

  it('steps round', () => {
    expect(stepFrom(2, 3, 1)).toBe(0)
    expect(stepFrom(0, 3, -1)).toBe(2)
  })
})

describe('landingPlace', () => {
  const outline = {
    slides: [
      { number: 1, title: 'Intro' },
      { number: 2, title: 'Results' },
      { number: 3, title: 'Plan' },
      { number: 6, title: 'Results' },
    ],
  }
  it('finds a moved slide by its slug', () => {
    expect(landingPlace({ kind: 'slide', number: 2, slug: 'plan' }, outline)).toEqual({
      kind: 'slide',
      number: 3,
      slug: 'plan',
    })
  })
  it('takes the match nearest the number', () => {
    expect(landingPlace({ kind: 'slide', number: 5, slug: 'results' }, outline)).toMatchObject({
      number: 6,
    })
    expect(landingPlace({ kind: 'slide', number: 1, slug: 'results' }, outline)).toMatchObject({
      number: 2,
    })
  })
  it('falls back to the number', () => {
    expect(landingPlace({ kind: 'slide', number: 4, slug: 'gone' }, outline)).toMatchObject({
      number: 4,
    })
    expect(landingPlace({ kind: 'slide', number: 3, slug: null }, outline)).toMatchObject({
      number: 3,
    })
    expect(landingPlace({ kind: 'slide', number: 3, slug: 'plan' }, null)).toMatchObject({
      number: 3,
    })
  })
})
