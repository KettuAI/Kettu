import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HARNESS_IDS } from '@shared/agents'
import { AgentMark } from './agent-mark'

describe('AgentMark', () => {
  it('draws an added agent with its harness mark', () => {
    const mark = (agent: 'codex' | 'codex~work') =>
      renderToStaticMarkup(createElement(AgentMark, { agent, mono: false }))
    expect(mark('codex~work')).toBe(mark('codex'))
  })

  it('draws a mark for every harness, in its colors and in one color', () => {
    for (const agent of HARNESS_IDS) {
      for (const mono of [false, true]) {
        const markup = renderToStaticMarkup(createElement(AgentMark, { agent, mono }))
        expect(markup.startsWith('<svg'), agent).toBe(true)
        expect(markup, agent).toContain('viewBox=')
        expect(markup, agent).toMatch(
          /<(path|rect|circle|line|text|polygon|polyline|ellipse|g)[\s>]/,
        )
        expect(markup.endsWith('</svg>'), agent).toBe(true)
      }
    }
  })
})
