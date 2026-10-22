import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { describe, expect, it } from 'vitest'
import { remarkPlugins } from './remark'

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Streamdown, { mode: 'streaming', skipHtml: true, remarkPlugins }, markdown),
  )
}

// Claude Code's own `/usage` text, which claude-agent-acp forwards when its structured report
// times out.
const USAGE_TEXT = [
  'Current session: 12% used · resets Oct 22 at 2:19pm (America/Los_Angeles)',
  'Current week (all models): 3% used · resets Oct 29 at 7:59am (America/Los_Angeles)',
  '',
  'Last 24h · 3954 requests · 40 sessions',
  '  90% of your usage was at >150k context',
  '  50% of your usage came from subagent-heavy sessions',
].join('\n')

describe('remarkPlugins', () => {
  it('keeps every line of plain text on a line of its own', () => {
    const html = render(USAGE_TEXT)
    expect(html.match(/<br\s*\/?>/g)).toHaveLength(3)
    expect(html).not.toMatch(/\(America\/Los_Angeles\) Current week/)
  })

  it('breaks a line inside a list item', () => {
    expect(render('- **Title**\n  what it does')).toMatch(/Title<\/span><br\s*\/?>\s*what it does/)
  })

  it('leaves code blocks and paragraph breaks alone', () => {
    const html = render('one\n\ntwo\n\n```\na\nb\n```')
    expect(html).not.toMatch(/<br/)
  })
})
