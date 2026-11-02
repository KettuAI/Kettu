import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HARNESS_IDS } from '@shared/agents'
import type { AddedAgent } from '@shared/settings'
import { AgentMark } from './agent-mark'

// Server rendering reads no store, so the test hands over this computer's added agents.
const added = vi.hoisted(() => ({ agents: [] as AddedAgent[] }))
vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: (select: (s: { settings: { addedAgents: AddedAgent[] } }) => unknown) =>
    select({ settings: { addedAgents: added.agents } }),
}))

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

  it("puts an added agent's dot on its mark, and none on a default agent's", () => {
    const work: AddedAgent = {
      id: 'codex~work',
      name: 'Work',
      configDir: '/tmp/work',
      created: true,
      color: 'rose',
    }
    added.agents = [work]
    try {
      const mark = (agent: 'codex' | 'codex~work', dot?: 'amber' | null) =>
        renderToStaticMarkup(createElement(AgentMark, { agent, mono: false, dot }))
      expect(mark('codex~work')).toContain('var(--agent-rose)')
      expect(mark('codex')).not.toContain('--agent-')
      // Another host's settings pass the dot in, and null draws none.
      expect(mark('codex~work', 'amber')).toContain('var(--agent-amber)')
      expect(mark('codex~work', null)).toBe(mark('codex'))
    } finally {
      added.agents = []
    }
  })
})
