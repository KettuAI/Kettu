import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, session: {} }))

const { parseLayout, parsePage, pageDocument, thumbnailDocument } = await import('./thumbnails')

const ORIGIN = 'kettu-artifact://0123456789abcdef0123456789/'

describe('thumbnail layouts from the renderer', () => {
  const page = { group: 0, index: 1, x: 0, y: 0, width: 1280, height: 800 }

  it("take a canvas document's page by its HTML file, escaped into the frame's address", () => {
    const layout = parseLayout([
      { ...page, file: 'pages/a b.html' },
      { ...page, index: 2, x: 1400 },
    ])!
    expect(layout[0]!.file).toBe('pages/a b.html')
    const doc = thumbnailDocument(ORIGIN, 3, layout)
    expect(doc).toContain(
      'src="kettu-artifact://0123456789abcdef0123456789/_kettu/v/3/pages/a%20b.html"',
    )
    expect(doc).toContain('/_kettu/v/3/index.html?page=0.2"')
  })

  it('refuse a page file that is no HTML file of the artifact or would leave the attribute', () => {
    for (const file of ['../x.html', '/a.html', 'a.js', 'a".html', '_kettu/x.html', 42]) {
      expect(() => parseLayout([{ ...page, file }])).toThrow()
      expect(() => parsePage({ group: 0, index: 1, file })).toThrow()
    }
  })

  it("render one page's image from its own file", () => {
    const one = parsePage({ group: 0, index: 1, file: 'general.html' })
    expect(pageDocument(ORIGIN, 2, one, { width: 400, height: 300 })).toContain(
      '/_kettu/v/2/general.html"',
    )
  })
})
