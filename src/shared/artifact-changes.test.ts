import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  documentSections,
  type ComparedVersion,
  type ReadText,
} from './artifact-changes'

const canvas = (pages: { id: string; file: string }[]): string =>
  JSON.stringify({
    format: 1,
    canvases: [{ id: 'c1', name: 'Home' }],
    pages: pages.map((p, i) => ({
      ...p,
      canvas: 'c1',
      name: p.id.toUpperCase(),
      x: i * 400,
      y: 0,
      width: 390,
      height: 844,
      locked: false,
    })),
    notes: [],
  })

/** Versions of one artifact by number, each a map of paths to text, hashed by their text. */
function versions(
  by: Record<number, { type?: 'document' | 'slides'; files: Record<string, string> }>,
) {
  const of = (n: number): ComparedVersion => ({
    version: n,
    type: by[n]!.type ?? null,
    files: Object.entries(by[n]!.files).map(([path, text]) => ({ path, hash: `h:${text}` })),
  })
  const read: ReadText = async (n, path) => by[n]!.files[path]!
  return { of, read }
}

describe('the changes between two versions', () => {
  it("names a canvas's frames whose files changed, by their ids, in either direction", async () => {
    const doc = canvas([
      { id: 'pa', file: 'a.html' },
      { id: 'pb', file: 'b.html' },
      { id: 'pc', file: 'c.html' },
    ])
    const { of, read } = versions({
      1: { files: { 'canvas.json': doc, 'a.html': 'a', 'b.html': 'b', 'c.html': 'c' } },
      3: { files: { 'canvas.json': doc, 'a.html': 'a', 'b.html': 'B', 'c.html': 'C' } },
    })
    expect(await compareVersions(of(1), of(3), read)).toEqual({
      kind: 'frames',
      frames: [
        { id: 'pb', name: 'PB', file: 'b.html' },
        { id: 'pc', name: 'PC', file: 'c.html' },
      ],
    })
    // From a later version back to an earlier one, as history compares them.
    expect(await compareVersions(of(3), of(1), read)).toMatchObject({ kind: 'frames' })
  })

  it("names a web page's changed, added and removed files, and nothing for the same files", async () => {
    const { of, read } = versions({
      1: { files: { 'index.html': 'x', 'a.css': 'a', 'old.js': 'o' } },
      2: { files: { 'index.html': 'x', 'a.css': 'A', 'new.js': 'n' } },
      3: { files: { 'index.html': 'x', 'a.css': 'A', 'new.js': 'n' } },
    })
    expect(await compareVersions(of(1), of(2), read)).toEqual({
      kind: 'files',
      paths: ['a.css', 'new.js', 'old.js'],
    })
    expect(await compareVersions(of(2), of(3), read)).toBeNull()
  })

  it('tells nothing when a file comes without its hash, as from an older host', async () => {
    const before = { version: 1, type: null, files: [{ path: 'index.html' }] }
    const after = { version: 2, type: null, files: [{ path: 'index.html', hash: 'x' }] }
    expect(await compareVersions(before, after, async () => '')).toBeNull()
  })

  it("counts a document's changed passages block by block, by the section each is in", async () => {
    const before = '# Plan\n\nOne.\n\nTwo.\n\nThree.\n\n## Risks\n\nNone.\n\n## Old\n\nGone.\n'
    const after = '# Plan\n\nOne.\n\nTwo, changed.\n\nThree.\n\nAdded.\n\n## Risks\n\nNone.\n'
    const { of, read } = versions({
      1: { type: 'document', files: { 'document.md': before } },
      2: { type: 'document', files: { 'document.md': after } },
    })
    const changes = await compareVersions(of(1), of(2), read)
    expect(changes?.kind).toBe('sections')
    if (changes?.kind !== 'sections') return
    expect(changes.passages.map((p) => [p.change, p.section, after.slice(p.from, p.to)])).toEqual([
      ['changed', 'plan', 'Two, changed.'],
      ['added', 'plan', 'Added.'],
      ['removed', 'risks', ''],
      ['removed', 'risks', ''],
    ])
    // What each changed or removed passage was in the earlier version, for its old words.
    expect(
      changes.passages.map((p) => (p.before ? before.slice(p.before.from, p.before.to) : null)),
    ).toEqual(['Two.', null, '## Old', 'Gone.'])
    expect(changes.sections).toEqual([
      { heading: 'Plan', slug: 'plan', passages: 2 },
      { heading: 'Risks', slug: 'risks', passages: 2 },
      { heading: 'Old', slug: 'old', passages: 0 },
    ])
    expect(changes.headings).toEqual(['Plan', 'Risks', 'Old'])
  })

  it("names a deck's slides that differ at their place", async () => {
    const deck = (titles: string[]) =>
      JSON.stringify({ slides: titles.map((title) => ({ layout: 'title', title })) })
    const { of, read } = versions({
      1: { type: 'slides', files: { 'slides.json': deck(['A', 'B', 'C']) } },
      2: { type: 'slides', files: { 'slides.json': deck(['A', 'B2', 'C', 'D']) } },
    })
    expect(await compareVersions(of(1), of(2), read)).toEqual({
      kind: 'slides',
      slides: [
        { number: 2, title: 'B2' },
        { number: 4, title: 'D' },
      ],
    })
  })
})

describe("a document's sections", () => {
  it('get slugs unique in the document, in any script', () => {
    const sections = documentSections(
      'Intro.\n\n# 计划 A\n\n## Risks!\n\n## Risks\n\nSetext\n===\n',
    )
    expect(sections.map((s) => [s.heading, s.slug, s.level])).toEqual([
      [null, null, 0],
      ['计划 A', '计划-a', 1],
      ['Risks!', 'risks', 2],
      ['Risks', 'risks-1', 2],
      ['Setext', 'setext', 1],
    ])
  })
})
