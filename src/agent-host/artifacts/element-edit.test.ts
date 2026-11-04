import { describe, expect, it } from 'vitest'
import { editElement, styleWith } from './element-edit'

const PAGE =
  '<!doctype html><html><head><style>.b{color:red}</style></head><body>' +
  '<!-- <button>old</button> --><section data-page="General">' +
  '<button class="b" style="color: #000000; margin: 4px">Save changes</button>' +
  '<div id="row"><span>Send</span></div>' +
  '<script>const tpl = "<button>x</button>"</script></section></body></html>'

const at = (needle: string): number => PAGE.indexOf(needle)

describe('a direct edit', () => {
  it("changes only that element's style, keeping its other declarations and attributes", () => {
    const button = at('<button class')
    const edited = editElement(PAGE, button, {
      style: { color: '#ffffff', 'background-color': '#f2581b', 'border-radius': '7px' },
      text: null,
    })
    const before = PAGE.slice(0, button)
    expect(edited.startsWith(before)).toBe(true)
    expect(edited.slice(button)).toMatch(
      /^<button class="b" style="margin: 4px; color: #ffffff; background-color: #f2581b; border-radius: 7px">Save changes<\/button>/,
    )
    expect(edited.endsWith(PAGE.slice(PAGE.indexOf('>Save changes')))).toBe(true)
  })

  it('adds a style to a start tag without one, after its name', () => {
    const div = at('<div id')
    const edited = editElement(PAGE, div, { style: { padding: '0px 14px' }, text: null })
    expect(edited).toBe(
      PAGE.slice(0, div) + '<div style="padding: 0px 14px" id="row">' + PAGE.slice(div + 14),
    )
  })

  it('replaces the text of an element that holds text alone, as text', () => {
    const span = at('<span>')
    const edited = editElement(PAGE, span, { style: null, text: 'Send <now> & then' })
    expect(edited).toBe(
      PAGE.replace('<span>Send</span>', '<span>Send &lt;now&gt; &amp; then</span>'),
    )
  })

  it('refuses the text of an element with elements in it', () => {
    expect(() => editElement(PAGE, at('<div id'), { style: null, text: 'x' })).toThrow(
      /more than text/,
    )
    expect(() => editElement(PAGE, at('<section'), { style: null, text: 'x' })).toThrow()
  })

  it.each([
    ['in a comment', () => at('<button>old')],
    ['in a script', () => at('<button>x')],
    ['inside a start tag', () => at('class="b"')],
    ['at an end tag', () => at('</button>')],
    ['past the end', () => PAGE.length + 5],
  ])('refuses an offset %s', (_, offset) => {
    expect(() => editElement(PAGE, offset(), { style: { color: '#ffffff' }, text: null })).toThrow(
      /No element/,
    )
  })

  it.each([
    { color: 'red;background:url(x)' },
    { color: '#fff" onclick="x' },
    { 'font-size': '12px; position: fixed' },
    { position: 'fixed' },
    { padding: '1px 2px 3px 4px 5px' },
  ])('refuses a style it may not write: %o', (style) => {
    expect(() => editElement(PAGE, at('<button class'), { style, text: null } as never)).toThrow(
      /may not write/,
    )
  })

  it('keeps a style value with a semicolon inside quotes, escaped in the attribute', () => {
    expect(styleWith('font-family: "a;b"; color: red', { color: '#000000' })).toBe(
      'font-family: "a;b"; color: #000000',
    )
    const page = `<p style='content: "x"'>Hi</p>`
    expect(editElement(page, 0, { style: { color: '#000000' }, text: null })).toBe(
      '<p style="content: &quot;x&quot;; color: #000000">Hi</p>',
    )
  })
})
