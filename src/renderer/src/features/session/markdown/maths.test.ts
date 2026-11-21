import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown, type Components } from 'streamdown'
import { describe, expect, it } from 'vitest'
import { fenceBracketMath } from './maths'
import { remarkPlugins } from './remark'

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return ''
}

// Formulas as `[i:tex]` and `[d:tex]`, so each case reads as the text a reader sees.
const components: Components = {
  inlineCode: ({ className, children }) =>
    className?.includes('language-math')
      ? `[i:${text(children)}]`
      : createElement('code', null, children),
  code: ({ className, children }) =>
    className?.includes('language-math')
      ? `[d:${text(children).replace(/\n$/, '')}]`
      : createElement('code', null, children),
}

/** What the reply shows: its text with formulas marked, as the renderer parses it. */
function render(markdown: string, live = false): string {
  const html = renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: 'streaming',
        parseIncompleteMarkdown: live,
        remarkPlugins,
        components,
        controls: false,
      },
      fenceBracketMath(markdown, live),
    ),
  )
  return html
    .replace(/<br\/?>/g, '\n')
    .replace(/<\/t[dh]><t[dh][^>]*>/g, ' ')
    .replace(/<\/(p|li|tr)>/g, '$&\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\n{2,}/g, '\n')
    .trim()
}

describe('reply maths', () => {
  it('keeps $$ as a block on lines of its own and inline in a sentence', () => {
    expect(render('$$\nx^2\n$$')).toBe('[d:x^2]')
    expect(render('so $$x^2$$ holds')).toBe('so [i:x^2] holds')
  })

  it('reads a single $ as inline maths', () => {
    expect(render('where $f(x)$ is smooth')).toBe('where [i:f(x)] is smooth')
    expect(render('$x_0$ and $n$')).toBe('[i:x_0] and [i:n]')
    expect(render('$a + b$')).toBe('[i:a + b]')
  })

  it('reads inline maths in CJK text without spaces', () => {
    expect(render('设函数$f(x)$在点$x_0$处有$n$阶导数')).toBe(
      '设函数[i:f(x)]在点[i:x_0]处有[i:n]阶导数',
    )
  })

  it('keeps prices and other single $ as text', () => {
    expect(render('$5 to $10')).toBe('$5 to $10')
    expect(render('It costs $660.')).toBe('It costs $660.')
    expect(render('costs $5, or $8 with tax')).toBe('costs $5, or $8 with tax')
    expect(render('$ x$ and $x $')).toBe('$ x$ and $x $')
    expect(render('$x$5')).toBe('$x$5')
    expect(render('from $5/$10 a month')).toBe('from $5/$10 a month')
  })

  it('keeps an escaped dollar a dollar sign', () => {
    expect(render('\\$x\\$')).toBe('$x$')
    expect(render('\\$5 and $y$')).toBe('$5 and [i:y]')
  })

  it('reads \\( \\) as inline maths', () => {
    expect(render('the function \\(f(x)\\) at \\( x_0 \\)')).toBe(
      'the function [i:f(x)] at [i: x_0 ]',
    )
    expect(render('设\\(f(x)\\)在点')).toBe('设[i:f(x)]在点')
    expect(render('\\(not closed')).toBe('(not closed')
  })

  it('reads \\[ \\] on lines of their own as a block', () => {
    expect(render('\\[\nf(x) = \\sum_{k=0}^{n} a_k\n\\]')).toBe('[d:f(x) = \\sum_{k=0}^{n} a_k]')
    expect(render('Taylor:\n\\[\nR_n(x) = x\n\\]\nwhere')).toBe('Taylor:\n[d:R_n(x) = x]\nwhere')
    expect(render('\\[ x^2 + 1 \\]')).toBe('[d: x^2 + 1 ]')
    expect(render('\\[ a\n+ b \\]')).toBe('[d: a\n+ b ]')
    expect(render('> \\[\n> x\n> \\]')).toBe('[d:x]')
    expect(render('1. sum:\n   \\[\n   x\n   \\]')).toBe('sum:\n[d:x]')
  })

  it('reads \\[ \\] within a line as inline maths', () => {
    expect(render('so \\[x^2\\] holds')).toBe('so [i:x^2] holds')
  })

  it('reads maths in table cells', () => {
    const table = [
      '| term | value |',
      '| --- | --- |',
      '| $R_n(x)$ | \\(x^2\\) |',
      '| $$y$$ | \\[z\\] |',
      '| price | $5 |',
    ].join('\n')
    expect(render(table)).toBe(
      ['term value', '[i:R_n(x)] [i:x^2]', '[i:y] [i:z]', 'price $5'].join('\n'),
    )
  })

  it('leaves code spans and code blocks as written', () => {
    expect(render('`$x$` and `\\(y\\)`')).toBe('$x$ and \\(y\\)')
    expect(render('costs $5. Use `$HOME` here')).toBe('costs $5. Use $HOME here')
    expect(render('\\(a `\\)` b')).toBe('(a \\) b')
    expect(render('```\n$x$\n\\[\ny\n\\]\n```')).toBe('$x$\n\\[\ny\n\\]')
    expect(render('~~~tex\n\\[\ny\n\\]\n~~~')).toBe('\\[\ny\n\\]')
    expect(render('text\n\n    \\[\n    y\n    \\]')).toBe('text\n\\[\ny\n\\]')
  })

  it('shows a formula still being written as its source', () => {
    expect(render('where $f(x', true)).toBe('where $f(x')
    expect(render('so $a*b$ and $x_1$ or $y_2', true)).toBe('so [i:a*b] and [i:x_1] or $y_2')
    expect(render('where:\n\\[\nf(x) = ', true)).toBe('where:\n[d:f(x) = ]')
    expect(fenceBracketMath('\\[\nf(x)', false)).toBe('\\[\nf(x)')
  })
})
