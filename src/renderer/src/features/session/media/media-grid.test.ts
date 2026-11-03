import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MediaGrid } from './media-grid'

describe('MediaGrid', () => {
  it('shows its pictures by name where no session can read them', () => {
    const html = renderToStaticMarkup(
      createElement(MediaGrid, { paths: ['out/a.png', 'out/b.png', 'out/c.png', 'out/d.png'] }),
    )
    expect(html).not.toContain('data-slot="skeleton"')
    expect(html).toContain('title="out/a.png"')
    expect(html).toContain('>a.png<')
    expect(html).toContain('>c.png +1<')
  })
})
