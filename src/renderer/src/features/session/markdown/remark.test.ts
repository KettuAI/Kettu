import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { describe, expect, it } from 'vitest'
import { cjkPlugin, defaultRemarkPluginsNoSingleTilde } from './cjk-plugin'
import { remarkPlugins } from './remark'

function renderMarkdown(markdown: string, plugins: typeof remarkPlugins = remarkPlugins): string {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: 'streaming',
        parseIncompleteMarkdown: false,
        plugins: { cjk: cjkPlugin },
        remarkPlugins: plugins,
        linkSafety: { enabled: false },
        controls: false,
      },
      markdown,
    ),
  )
}

describe('markdown remark & cjkPlugin single-tilde strikethrough handling', () => {
  it('does not strike through single-tilde shell prompts across lines', () => {
    const paste = [
      'root@VM-0-2-ubuntu:~# curl -fsSL https://relay.kettu.sh/v1/nodes/install.sh | sudo bash -s -- token',
      'kettu-relay: no relay node release is published yet',
      'root@VM-0-2-ubuntu:~#',
    ].join('\n')
    const html = renderMarkdown(paste)
    expect(html).not.toContain('<del')
    expect(html.match(/VM-0-2-ubuntu:~#/g)).toHaveLength(2)
  })

  it('does not strike through home paths or approximate numeric ranges', () => {
    const paths = renderMarkdown('Compare ~/a and ~/b before merging.')
    expect(paths).not.toContain('<del')
    expect(paths).toContain('~/a and ~/b')

    const range = renderMarkdown('Latency stays ~10ms to ~20ms under load.')
    expect(range).not.toContain('<del')
    expect(range).toContain('~10ms to ~20ms')
  })

  it('keeps explicit double-tilde strikethrough for Latin and CJK text', () => {
    const latin = renderMarkdown('Keep ~~explicit double tilde~~ struck through.')
    expect(latin).toContain('<del')
    expect(latin).toContain('explicit double tilde')

    const cjk = renderMarkdown('这是~~中文删除线~~。还有~~删除线（括号）~~文本')
    expect(cjk).toContain('<del')
    expect(cjk).toContain('中文删除线')
    expect(cjk).toContain('删除线（括号）')
  })

  it('preserves CJK emphasis and CJK autolink boundary splitting', () => {
    const emphasis = renderMarkdown('这是**重要（提示）**内容')
    expect(emphasis).toContain('data-streamdown="strong"')
    expect(emphasis).toContain('重要（提示）')

    const autolink = renderMarkdown('访问 https://example.com/docs。然后继续')
    expect(autolink).toContain('href="https://example.com/docs"')
    expect(autolink).not.toContain('href="https://example.com/docs。')
  })

  it('also disables single-tilde strikethrough in defaultRemarkPluginsNoSingleTilde', () => {
    const html = renderMarkdown(
      'Check ~/a and ~/b, and ~~中文删除线~~。',
      defaultRemarkPluginsNoSingleTilde,
    )
    expect(html).toContain('~/a and ~/b')
    expect(html).toContain('<del')
    expect(html).toContain('中文删除线')
    expect(html).not.toContain('<del>/a and ')
  })
})
