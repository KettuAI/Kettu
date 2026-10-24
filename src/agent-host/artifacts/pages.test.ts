import { describe, expect, it } from 'vitest'
import { countPages, PAGE_SCAN_BYTES } from './pages'

describe('counting pages', () => {
  it('counts the tags that carry data-page, in groups or not', () => {
    const html = `<!doctype html><html><body>
      <div data-page-group="Sign in">
        <section data-page="A · Dusk" data-page-size="390x844">A</section>
        <section data-page='B · Paper' data-page-size=390x844>B</section>
      </div>
      <SECTION DATA-PAGE>Third</SECTION>
      <article data-page=""></article>
    </body></html>`
    expect(countPages(html)).toBe(4)
  })

  it('is no canvas without markers', () => {
    expect(countPages('<p>Just a report</p>')).toBe(0)
    expect(countPages('')).toBe(0)
    expect(countPages('<section data-page="Only">x</section>')).toBe(1)
  })

  it('does not take other data-page attributes for pages', () => {
    const html =
      '<div data-page-group="G" data-pages="2"></div><div data-page-size="1x1"></div>' +
      '<div data-pagex="1"></div><div title="data-page"></div><div aria-label=data-page></div>'
    expect(countPages(html)).toBe(0)
  })

  it('skips comments, scripts, styles, titles and text areas', () => {
    const html = [
      '<title><section data-page="t"></title>',
      '<!-- <section data-page="hidden"></section> -->',
      '<script>document.body.innerHTML = "<section data-page=\\"js\\">"</script>',
      '<SCRIPT type="module">const a = "<div data-page>"</Script>',
      '<style>/* <div data-page> */</style>',
      '<textarea><div data-page></textarea>',
      '<section data-page="real"></section>',
    ].join('\n')
    expect(countPages(html)).toBe(1)
  })

  it('reads a quoted value that holds a ">" as part of the tag', () => {
    expect(countPages('<div title="a > b" data-page="x"></div>')).toBe(1)
    expect(countPages("<div title='<section data-page>'></div>")).toBe(0)
  })

  it('ignores end tags, doctypes and stray angle brackets', () => {
    expect(countPages('</section data-page><!DOCTYPE data-page><?x data-page?> 1 < 2 <3')).toBe(0)
  })

  it('stops at the end of an unfinished tag, comment or script', () => {
    expect(countPages('<section data-page="a"></section><div data-page="b')).toBe(1)
    expect(countPages('<section data-page></section><!-- <div data-page>')).toBe(1)
    expect(countPages('<section data-page></section><script><div data-page>')).toBe(1)
  })

  it('reads only the first 2 MiB', () => {
    const page = '<section data-page="p"></section>'
    const filler = 'x'.repeat(PAGE_SCAN_BYTES - page.length)
    expect(countPages(page + filler + page)).toBe(1)
    // Multibyte text counts in bytes of UTF-8, not in characters.
    const wide = '中'.repeat(Math.ceil(PAGE_SCAN_BYTES / 3))
    expect(countPages(page + wide + page)).toBe(1)
    expect(countPages(page + 'x'.repeat(1000) + page)).toBe(2)
  })
})
