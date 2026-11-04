import { describe, expect, it } from 'vitest'
import { parseDeck } from '@shared/artifact-slides'
import { ArtifactTypes, ContentError, type ContentDraft, type TypePackage } from './registry'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
  0, 0, 0, 2,
])
const GIF = Buffer.from('GIF89a\x04\x00\x02\x00', 'latin1')

const types = new ArtifactTypes()

function draft(files: Record<string, string | Uint8Array>, entry?: string | null): ContentDraft {
  const changed = new Map<string, Uint8Array>()
  for (const [path, value] of Object.entries(files)) {
    changed.set(path, typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
  }
  const text = Object.entries(files).find(
    ([path]) => path.endsWith('.md') || path.endsWith('.json'),
  )
  return {
    paths: new Set(Object.keys(files)),
    entry: entry === undefined ? (typeof text?.[1] === 'string' ? text[1] : null) : entry,
    changed,
  }
}

function problems(type: 'document' | 'slides', d: ContentDraft): string[] {
  try {
    types.check({ name: type, format: 1 }, d)
    return []
  } catch (error) {
    expect(error).toBeInstanceOf(ContentError)
    return [...(error as ContentError).problems]
  }
}

const deck = (slides: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ title: 'Deck', slides, ...extra })

describe('the document format', () => {
  it('takes Markdown whose pictures are files of the version', () => {
    const text =
      '# Report\n\n![Chart](images/chart.png)\n\n![Ref][logo]\n\n[logo]: ./images/logo.gif\n'
    expect(
      problems(
        'document',
        draft({ 'document.md': text, 'images/chart.png': PNG, 'images/logo.gif': GIF }),
      ),
    ).toEqual([])
  })

  it('names each picture that is not a file of the version, by its line', () => {
    const text = '# Report\n\n![a](https://example.com/a.png)\n\n![b](images/missing.png)\n'
    const found = problems('document', draft({ 'document.md': text }))
    expect(found).toHaveLength(2)
    expect(found[0]).toMatch(/line 3 shows https:\/\/example\.com\/a\.png/)
    expect(found[1]).toMatch(/line 5 shows images\/missing\.png, which the version does not have/)
  })

  it('refuses files a document does not hold, and pictures that are not what they say', () => {
    const found = problems(
      'document',
      draft({
        'document.md': '# A',
        'index.html': '<p>',
        'images/fake.png': Buffer.from('not a picture'),
        'images/real.jpg': PNG,
      }),
    )
    expect(found.join(' ')).toMatch(/holds only document\.md .*remove index\.html/)
    expect(found.join(' ')).toMatch(/images\/fake\.png is not a PNG picture/)
    expect(found.join(' ')).toMatch(/images\/real\.jpg is not a JPEG picture but a PNG/)
  })

  it('refuses SVG pictures, which could run script on the viewer’s origin', () => {
    const found = problems('document', draft({ 'document.md': '# A', 'images/a.svg': '<svg/>' }))
    expect(found.join(' ')).toMatch(/remove images\/a\.svg/)
  })

  it('needs its content file, as UTF-8', () => {
    expect(problems('document', draft({ 'images/a.png': PNG }, null))).toEqual([
      'document.md is missing; give it in files.',
    ])
    expect(problems('document', draft({ 'document.md': Buffer.from([0xff, 0xfe]) }, null))).toEqual(
      ['document.md is not UTF-8 text.'],
    )
  })
})

describe('the slides format', () => {
  it('takes a deck of every layout', () => {
    const text = deck(
      [
        { layout: 'title', title: 'Kettu', subtitle: 'Q3' },
        { layout: 'section', title: 'Results' },
        { layout: 'bullets', title: 'Why', bullets: ['a', { text: 'b', bullets: ['c'] }] },
        { layout: 'bullets', title: 'With', bullets: ['a'], image: 'images/a.png', alt: 'A' },
        { layout: 'two-column', left: { heading: 'L', text: 'x' }, right: { bullets: ['y'] } },
        { layout: 'image', title: 'Pic', image: 'images/a.png', alt: 'A', caption: 'c' },
        { layout: 'quote', quote: 'It works.', attribution: 'Someone', notes: 'Say it slowly' },
        { layout: 'stats', stats: [{ value: '42%', label: 'faster' }] },
        { layout: 'table', title: 'T', columns: ['a', 'b'], rows: [['1', '2']] },
      ],
      { theme: 'dark', aspect: '4:3' },
    )
    expect(problems('slides', draft({ 'slides.json': text, 'images/a.png': PNG }))).toEqual([])
  })

  it('names each field that is wrong', () => {
    const text = deck([
      { layout: 'grid', title: 'x' },
      { layout: 'bullets', bullets: [] },
      { layout: 'title', title: 'x', body: 'y' },
      { layout: 'image', image: 'images/none.png', alt: 'x' },
      { layout: 'table', columns: ['a', 'b'], rows: [['1']] },
      { layout: 'bullets', title: 't', bullets: Array.from({ length: 13 }, () => 'p') },
    ])
    const found = problems('slides', draft({ 'slides.json': text }))
    expect(found).toEqual([
      'slides[0].layout must be one of title, section, bullets, two-column, image, quote, stats, table.',
      'slides[1].title is missing; give it as text.',
      'slides[1].bullets must be a list of 1 to 12 points.',
      'slides[2] (title) has an unknown field "body"; it takes layout, title, subtitle, notes.',
      'slides[3].image names images/none.png, which is not a file of the artifact; add it in files.',
      'slides[4].rows[0] must be a list of 2 cells.',
      'slides[5].bullets has 13 points; a slide holds at most 12.',
    ])
  })

  it('says when slides.json is not JSON or holds no slides', () => {
    expect(problems('slides', draft({ 'slides.json': '{' }))[0]).toMatch(/not valid JSON/)
    expect(problems('slides', draft({ 'slides.json': deck([]) }))).toEqual([
      'slides must be a list of 1 to 200 slides.',
    ])
  })

  it('parses a deck without checking pictures for the viewer', () => {
    const parsed = parseDeck(deck([{ layout: 'image', image: 'images/x.png', alt: 'x' }]))
    expect('deck' in parsed && parsed.deck.slides).toHaveLength(1)
  })
})

describe('format versions', () => {
  const versioned: TypePackage = {
    name: 'document',
    title: 'Document',
    summary: '',
    formats: {
      1: { check: () => [] },
      2: {
        check: (d) => (d.entry?.startsWith('v2') ? [] : ['not v2']),
        migrate: (files) => {
          const text = Buffer.from(files.get('document.md')!).toString('utf8')
          if (text.includes('stuck')) throw new Error('Cannot move it')
          return new Map([...files, ['document.md', Buffer.from(`v2 ${text}`)]])
        },
      },
    },
    guidance: '',
    references: {},
    capabilities: ['content'],
    exports: ['md'],
  }
  const registry = new ArtifactTypes([versioned])

  it('writes new content in the newest format and moves old content to it', () => {
    expect(registry.current('document')).toBe(2)
    const moved = registry.migrate(
      { name: 'document', format: 1 },
      new Map([['document.md', Buffer.from('# A')]]),
    )
    expect(moved.format).toBe(2)
    expect(Buffer.from(moved.files.get('document.md')!).toString()).toBe('v2 # A')
  })

  it('throws when content cannot be moved, so the old format stays', () => {
    expect(() =>
      registry.migrate(
        { name: 'document', format: 1 },
        new Map([['document.md', Buffer.from('stuck')]]),
      ),
    ).toThrow('Cannot move it')
  })
})
