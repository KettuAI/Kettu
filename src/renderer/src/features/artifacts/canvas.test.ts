import { describe, expect, it } from 'vitest'
import { fitThumbnail, THUMBNAIL_HEIGHT, THUMBNAIL_INSET, THUMBNAIL_WIDTH } from '@shared/artifacts'
import {
  canvasRows,
  layoutCanvas,
  PAGE_GAP,
  ROW_GAP,
  thumbnailLayout,
  type MarkupElement,
} from './canvas'

/** An element as the format reads it: its attributes and children. */
function el(
  attributes: Record<string, string> = {},
  children: MarkupElement[] = [],
): MarkupElement {
  return {
    children,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
  }
}

const page = (name: string, size?: string) =>
  el(size === undefined ? { 'data-page': name } : { 'data-page': name, 'data-page-size': size })

describe('canvasRows', () => {
  it('finds groups and runs of loose pages, numbered as the protocol counts them', () => {
    const body = el({}, [
      page('Intro', '1440x900'),
      el({ 'data-page-group': 'Sign in' }, [page('A', '390x844'), el(), page('B', '390x844')]),
      el({}, [page('Nested, not a page')]),
      page('Loose'),
      el({ 'data-page-group': 'Empty' }),
      el({ 'data-page-group': 'Dashboard' }, [page('')]),
    ])
    expect(canvasRows(body)).toEqual([
      {
        title: null,
        pages: [{ name: 'Intro', number: 1, group: 0, index: 1, width: 1440, height: 900 }],
      },
      {
        title: 'Sign in',
        pages: [
          { name: 'A', number: 2, group: 1, index: 1, width: 390, height: 844 },
          { name: 'B', number: 3, group: 1, index: 2, width: 390, height: 844 },
        ],
      },
      {
        title: null,
        pages: [{ name: 'Loose', number: 4, group: 0, index: 2, width: 1280, height: 800 }],
      },
      {
        title: 'Dashboard',
        pages: [{ name: null, number: 5, group: 3, index: 1, width: 1280, height: 800 }],
      },
    ])
  })

  it('keeps loose pages together across other elements, and splits them at a group', () => {
    const body = el({}, [
      page('One'),
      el(),
      page('Two'),
      el({ 'data-page-group': 'G' }, [page('Three')]),
      page('Four'),
    ])
    expect(canvasRows(body).map((row) => row.pages.map((p) => p.name))).toEqual([
      ['One', 'Two'],
      ['Three'],
      ['Four'],
    ])
  })

  it('reads sizes within 64 and 8,000 px, and the default without a valid one', () => {
    const sizes = canvasRows(
      el({}, [page('a', '10x20000'), page('b', ' 390 × 844 '), page('c', 'wide'), page('d', '')]),
    )[0]!.pages.map((p) => [p.width, p.height])
    expect(sizes).toEqual([
      [64, 8000],
      [390, 844],
      [1280, 800],
      [1280, 800],
    ])
  })
})

describe('layoutCanvas', () => {
  it('places pages 48 px apart and rows 220 px apart, wrapping after six', () => {
    const rows = canvasRows(
      el({}, [
        el({ 'data-page-group': 'Phones' }, [page('A', '390x844'), page('B', '390x844')]),
        el(
          { 'data-page-group': 'Many' },
          Array.from({ length: 7 }, (_, i) => page(String(i), '100x100')),
        ),
      ]),
    )
    const { pages, width, height } = layoutCanvas(rows)
    expect(pages.slice(0, 2).map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [390 + PAGE_GAP, 0],
    ])
    const many = pages.slice(2)
    expect(many[5]).toMatchObject({ x: 5 * (100 + PAGE_GAP), y: 844 + ROW_GAP })
    expect(many[6]).toMatchObject({ x: 0, y: 844 + ROW_GAP + 100 + ROW_GAP })
    expect(width).toBe(6 * 100 + 5 * PAGE_GAP)
    expect(height).toBe(844 + ROW_GAP + 100 + ROW_GAP + 100)
  })
})

describe('thumbnailLayout', () => {
  it('is null for fewer than two pages', () => {
    expect(thumbnailLayout(canvasRows(el({}, [page('Only')])))).toBeNull()
    expect(thumbnailLayout([])).toBeNull()
  })

  it("names each page by the protocol's numbers and keeps at most 500", () => {
    const rows = canvasRows(
      el(
        {},
        Array.from({ length: 600 }, (_, i) => page(String(i), '64x64')),
      ),
    )
    const layout = thumbnailLayout(rows)!
    expect(layout).toHaveLength(500)
    expect(layout[0]).toEqual({ group: 0, index: 1, x: 0, y: 0, width: 64, height: 64 })
    expect(layout[499]!.index).toBe(500)
  })

  it('fits inside the inset, centred', () => {
    const layout = thumbnailLayout(
      canvasRows(el({}, [page('A', '1280x800'), page('B', '1280x800')])),
    )!
    const fit = fitThumbnail(layout)
    const width = (2 * 1280 + PAGE_GAP) * fit.scale
    expect(width).toBeCloseTo(THUMBNAIL_WIDTH - 2 * THUMBNAIL_INSET)
    expect(fit.x).toBeCloseTo((THUMBNAIL_WIDTH - width) / 2)
    expect(fit.y).toBeCloseTo((THUMBNAIL_HEIGHT - 800 * fit.scale) / 2)
  })
})
