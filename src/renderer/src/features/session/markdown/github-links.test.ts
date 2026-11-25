import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown, type Components } from 'streamdown'
import { describe, expect, it } from 'vitest'
import { localTarget } from './local-links'
import { remarkPlugins } from './remark'

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return ''
}

// Links as `[text](href)` and local paths as `[text](local:path)`, as the link component reads them.
const components: Components = {
  a: ({ href, children }) => {
    const local = localTarget(href ?? '')
    return `[${text(children)}](${local === null ? href : `local:${local}`})`
  },
}

function render(markdown: string): string {
  const html = renderToStaticMarkup(
    createElement(
      Streamdown,
      { mode: 'static', remarkPlugins, components, controls: false },
      markdown,
    ),
  )
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .trim()
}

describe('GitHub links without https:// in a reply', () => {
  it('links an issue or pull request written in prose to its full address', () => {
    expect(render('See github.com/o/r/issues/123.')).toBe(
      'See [github.com/o/r/issues/123](https://github.com/o/r/issues/123).',
    )
    expect(render('看一下github.com/o/r/pull/45，然后合并')).toBe(
      '看一下[github.com/o/r/pull/45](https://github.com/o/r/pull/45)，然后合并',
    )
  })

  it('opens a www. address over https, as the full link does', () => {
    expect(render('www.github.com/o/r/pull/45/files')).toBe(
      '[www.github.com/o/r/pull/45/files](https://www.github.com/o/r/pull/45/files)',
    )
  })

  it('takes a Markdown link to one for the web link, not a local path', () => {
    expect(render('[the issue](github.com/o/r/issues/123)')).toBe(
      '[the issue](https://github.com/o/r/issues/123)',
    )
    expect(render('[the fix](www.github.com/o/r/pull/45)')).toBe(
      '[the fix](https://www.github.com/o/r/pull/45)',
    )
  })

  it('keeps code, paths, other hosts and other links as they are', () => {
    expect(render('Run `open github.com/o/r/issues/1` now')).toBe(
      'Run open github.com/o/r/issues/1 now',
    )
    expect(render('```\ngithub.com/o/r/issues/1\n```')).not.toContain('](')
    expect(render('Read src/github.com/o/r/issues/1 and gist.github.com/o/r/issues/1')).toBe(
      'Read src/github.com/o/r/issues/1 and gist.github.com/o/r/issues/1',
    )
    expect(render('github.com.evil.com/o/r/issues/1')).toBe('github.com.evil.com/o/r/issues/1')
    expect(render('[notes](docs/github.com/o/r/issues/1)')).toBe(
      '[notes](local:docs/github.com/o/r/issues/1)',
    )
    expect(render('[x](https://example.com/?next=github.com/o/r/pull/1)')).toBe(
      '[x](https://example.com/?next=github.com/o/r/pull/1)',
    )
  })
})
