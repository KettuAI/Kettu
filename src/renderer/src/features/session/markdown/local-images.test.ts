import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { describe, expect, it } from 'vitest'
import { localImageTarget } from './local-images'
import { remarkPlugins } from './remark'

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Streamdown, { mode: 'streaming', skipHtml: true, remarkPlugins }, markdown),
  )
}

/** The local paths of the images in the HTML, in order. */
function images(html: string): (string | null)[] {
  return [...html.matchAll(/<img[^>]*?src="([^"]*)"/g)].map((match) =>
    localImageTarget(match[1]!.replaceAll('&amp;', '&')),
  )
}

// What OpenCode wrote for a screenshot in a No project session, 2026-10-24.
const SCREENSHOT =
  '/Users/amigoer/Library/Application Support/OverBench Dev/scratch/scratch-2026-10-23-59534e/desktop-shot.png'

describe('localImages', () => {
  it('shows an image whose absolute path has spaces', () => {
    const html = render(`截好了：\n\n![桌面截图](${SCREENSHOT})\n\n从图里能看到：`)
    expect(images(html)).toEqual([SCREENSHOT])
    expect(html).not.toContain('![')
  })

  it('takes paths from the home folder, relative ones and two on a line', () => {
    const html = render('![a](~/Desktop/shot 1.png) and ![b](./out/chart b.svg)')
    expect(images(html)).toEqual(['~/Desktop/shot 1.png', './out/chart b.svg'])
  })

  it('carries paths CommonMark already parses, file URIs and Windows paths', () => {
    expect(images(render('![x](out/chart.png)'))).toEqual(['out/chart.png'])
    expect(images(render('![x](file:///tmp/a.png)'))).toEqual(['file:///tmp/a.png'])
    expect(images(render('![x](C:\\Users\\me\\a b.png)'))).toEqual(['C:\\Users\\me\\a b.png'])
  })

  it('keeps alt text', () => {
    expect(render(`![桌面截图](${SCREENSHOT})`)).toMatch(/alt="桌面截图"/)
  })

  it('leaves code, other files and remote images as they are', () => {
    expect(render('`![a](/x y/a.png)`')).not.toMatch(/<img/)
    expect(render('```\n![a](/x y/a.png)\n```')).not.toMatch(/<img/)
    expect(render('![a](/x y/notes.txt)')).not.toMatch(/<img/)
    const remote = render('![badge](https://example.com/b.png)')
    expect(remote).toMatch(/src="https:\/\/example\.com\/b\.png"/)
    expect(images(remote)).toEqual([null])
  })
})
