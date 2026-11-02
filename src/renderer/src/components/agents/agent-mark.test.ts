import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HARNESS_IDS } from '@shared/agents'
import type { AgentColor } from '@shared/settings'
import { AgentMark } from './agent-mark'

// Server rendering reads no store, so the test hands over the statuses each host reports.
type Statuses = { byId: Record<string, { color?: AgentColor }> }
const stores = vi.hoisted(() => ({
  local: { byId: {} } as Statuses,
  hosts: {} as Record<string, Statuses>,
}))
vi.mock('@renderer/stores/host-scope', () => ({
  useHostScope: () => ({
    useAgentsStore: (select: (s: Statuses) => unknown) => select(stores.local),
  }),
}))
vi.mock('@renderer/stores/agents', () => ({
  useAgentsStore: (select: (s: unknown) => unknown) => select(stores),
  agentsOn: (s: typeof stores, hostId: string | null) =>
    hostId === null ? s.local : (s.hosts[hostId] ?? { byId: {} }),
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
    stores.local = { byId: { 'codex~work': { color: 'rose' }, codex: {} } }
    stores.hosts = { studio: { byId: { 'codex~work': { color: 'amber' } } } }
    try {
      const mark = (agent: 'codex' | 'codex~work', extra: object = {}) =>
        renderToStaticMarkup(createElement(AgentMark, { agent, mono: false, ...extra }))
      expect(mark('codex~work')).toContain('var(--agent-rose)')
      expect(mark('codex')).not.toContain('--agent-')
      // A session of another host takes that host's color for the agent of the same id.
      expect(mark('codex~work', { hostId: 'studio' })).toContain('var(--agent-amber)')
      expect(mark('codex~work', { hostId: 'gone' })).toBe(mark('codex'))
      expect(mark('codex~work', { dot: 'green' })).toContain('var(--agent-green)')
      expect(mark('codex~work', { dot: null })).toBe(mark('codex'))
    } finally {
      stores.local = { byId: {} }
      stores.hosts = {}
    }
  })
})
