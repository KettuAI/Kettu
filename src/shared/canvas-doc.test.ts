import { describe, expect, it } from 'vitest'
import {
  applyCanvasOps,
  CanvasError,
  parseCanvasDoc,
  parseCanvasOps,
  sectionBox,
  stringifyCanvasDoc,
  PAGE_GAP,
} from './canvas-doc'
import { isLegacyCanvas, splitLegacyCanvas } from './canvas-legacy'
import { elementEnd, eachStartTag, type StartTag } from './artifact-source'

const doc = (value: unknown): string => JSON.stringify(value)

describe('the canvas document', () => {
  it('fills in the one canvas and places pages written without a place', () => {
    const parsed = parseCanvasDoc(
      doc({
        sections: [{ id: 'settings', title: 'Settings' }],
        pages: [
          {
            id: 'a',
            name: 'Account',
            file: 'pages/a.html',
            section: 'settings',
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
          },
          { id: 'b', name: 'General', file: 'pages/b.html', section: 'settings' },
          { id: 'c', name: 'Loose', file: 'c.html' },
        ],
      }),
    )
    expect(parsed.canvases).toEqual([{ id: 'canvas-1', name: 'Canvas 1' }])
    const [a, b, c] = parsed.pages
    expect(a!.canvas).toBe('canvas-1')
    expect(b).toMatchObject({ x: 1440 + PAGE_GAP, y: 0, width: 1280, height: 800 })
    expect(c!.x).toBe(b!.x + b!.width + PAGE_GAP)
    expect(sectionBox(parsed, 'settings')).toMatchObject({ x: -40, y: -56 })
  })

  it('refuses what a stored document must not hold, saying what is wrong', () => {
    const bad = [
      [{ pages: [{ id: 'a', name: 'A', file: '../x.html' }] }, /relative path/],
      [{ pages: [{ id: 'a', name: 'A', file: 'x.js' }] }, /\.html file/],
      [
        {
          pages: [
            { id: 'a', name: 'A', file: 'a.html' },
            { id: 'a', name: 'B', file: 'b.html' },
          ],
        },
        /used more than once/,
      ],
      [{ pages: [{ id: 'a', name: 'A', file: 'a.html', section: 'nope' }] }, /names no section/],
      [{ pages: [{ id: 'a', name: 'A', file: 'a.html', width: 10 }] }, /from 64 to 8000/],
      [
        { notes: [{ id: 'n', kind: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, to: 'missing' }] },
        /joins no page/,
      ],
      [{ pages: [], extra: 1 }, /unknown property "extra"/],
      [
        {
          canvases: [
            { id: 'one', name: 'One' },
            { id: 'two', name: 'Two' },
          ],
          pages: [{ id: 'a', name: 'A', file: 'a.html' }],
        },
        /canvas must be/,
      ],
    ] as const
    for (const [value, message] of bad) {
      expect(() => parseCanvasDoc(doc(value))).toThrow(message)
    }
    expect(() => parseCanvasDoc('{')).toThrow(CanvasError)
  })

  it('stores the same document it reads', () => {
    const parsed = parseCanvasDoc(
      doc({
        pages: [{ id: 'a', name: 'A', file: 'a.html', x: 10, y: 20 }],
        notes: [
          { id: 'n1', kind: 'sticky', x: 1, y: 2, text: 'Too tight' },
          { id: 'n2', kind: 'pen', points: [0, 0, 0.5, 10, 10, 0.5] },
        ],
      }),
    )
    expect(parseCanvasDoc(stringifyCanvasDoc(parsed))).toEqual(parsed)
  })
})

describe('canvas operations', () => {
  const start = parseCanvasDoc(
    doc({
      sections: [{ id: 's', title: 'S' }],
      pages: [
        { id: 'a', name: 'A', file: 'a.html', section: 's', x: 0, y: 0 },
        { id: 'b', name: 'B', file: 'b.html', section: 's', x: 2000, y: 0 },
      ],
      notes: [{ id: 'arrow', kind: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, from: 'a', to: 'b' }],
    }),
  )

  it('applies in order, the last set of a property winning', () => {
    const ops = parseCanvasOps([
      { op: 'set', id: 'a', key: 'x', value: 100 },
      { op: 'set', id: 'a', key: 'x', value: 300 },
      { op: 'set', id: 's', key: 'title', value: 'Settings' },
      { op: 'add', object: { type: 'note', id: 'n', kind: 'sticky', x: 5, y: 5, text: 'Hi' } },
      { op: 'order', id: 'n', index: 0 },
    ])
    const next = applyCanvasOps(start, ops)
    expect(next.pages[0]!.x).toBe(300)
    expect(next.sections[0]!.title).toBe('Settings')
    expect(next.notes.map((n) => n.id)).toEqual(['n', 'arrow'])
    expect(start.pages[0]!.x).toBe(0)
  })

  it('removes what hangs off a removed object and skips operations on what is gone', () => {
    const next = applyCanvasOps(
      start,
      parseCanvasOps([
        { op: 'remove', id: 'a' },
        { op: 'set', id: 'a', key: 'x', value: 5 },
        { op: 'remove', id: 's' },
      ]),
    )
    expect(next.pages.map((p) => p.id)).toEqual(['b'])
    expect(next.pages[0]!.section).toBeNull()
    expect(next.notes[0]).toMatchObject({ from: null, to: 'b' })
  })

  it('refuses an operation that would break the document, applying none', () => {
    expect(() =>
      applyCanvasOps(start, parseCanvasOps([{ op: 'set', id: 'a', key: 'file', value: 'x.css' }])),
    ).toThrow(/\.html file/)
    expect(() =>
      applyCanvasOps(
        start,
        parseCanvasOps([{ op: 'set', id: 'a', key: 'canvas', value: 'other' }]),
      ),
    ).toThrow(/cannot set "canvas"/)
    expect(() => applyCanvasOps(start, parseCanvasOps([{ op: 'remove', id: 'canvas-1' }]))).toThrow(
      /at least one canvas/,
    )
    expect(() => parseCanvasOps([{ op: 'move', id: 'a' }])).toThrow(/add, set, remove or order/)
  })
})

describe('old canvases', () => {
  const old = `<!DOCTYPE html><html lang="en"><head><title>Old</title><style>section{padding:8px}</style></head>
<body class="b">
  <section data-page="Sign in" data-page-size="390x844"><h1>Sign in</h1><section><p>inner</p></section></section>
  <div data-page-group="Settings">
    <section data-page="Account"><!-- </section> --><p>a</p></section>
    <section data-page="">General</section>
  </div>
  <script>window.x = '</section>'</script>
</body></html>`

  it('finds where an element ends past nested ones, comments and scripts', () => {
    const tags: StartTag[] = []
    eachStartTag(old, (t) => {
      tags.push(t)
    })
    const first = tags.find((t) => t.attributes.some((a) => a.name === 'data-page'))!
    expect(old.slice(first.start, elementEnd(old, first)!)).toBe(
      '<section data-page="Sign in" data-page-size="390x844"><h1>Sign in</h1><section><p>inner</p></section></section>',
    )
  })

  it('splits into a file per page with the head and the body scripts, laid out as shown', () => {
    expect(isLegacyCanvas(old)).toBe(true)
    const split = splitLegacyCanvas(old, new Set(['index.html', 'account.html']))!
    expect([...split.files.keys()]).toEqual([
      'sign-in.html',
      'account-2.html',
      'page-3.html',
    ])
    const account = split.files.get('account-2.html')!
    expect(account).toContain('<title>Old</title>')
    expect(account).toContain('<body class="b">')
    expect(account).toContain('<section data-page="Account"><!-- </section> --><p>a</p></section>')
    expect(account).toContain(`window.x = '</section>'`)
    expect(account).not.toContain('Sign in')
    expect(split.doc.sections).toEqual([{ id: 's1', canvas: 'canvas-1', title: 'Settings' }])
    expect(split.doc.pages.map((p) => [p.name, p.section, p.width])).toEqual([
      ['Sign in', null, 390],
      ['Account', 's1', 1280],
      ['Page 3', 's1', 1280],
    ])
    expect(split.doc.pages[1]!.y).toBeGreaterThan(844)
    expect(parseCanvasDoc(stringifyCanvasDoc(split.doc))).toEqual(split.doc)
  })

  it('leaves a single page alone', () => {
    expect(isLegacyCanvas('<html><body><section data-page="Only">x</section></body></html>')).toBe(
      false,
    )
  })
})
