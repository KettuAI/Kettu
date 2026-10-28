import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AGENT_IDS } from '@shared/thread'
import { AgentMark } from './agent-mark'

describe('AgentMark', () => {
  it('draws a mark for every agent, in its colors and in one color', () => {
    for (const agent of AGENT_IDS) {
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
