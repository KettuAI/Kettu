import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HARNESS_IDS } from '@shared/agents'
import type { AgentColor } from '@shared/settings'
import { AgentMark, AgentTile } from './agent-mark'
import { AgentMarkHost } from './agent-mark-host'

// Server rendering reads no store, so the test hands over the statuses each host reports.
type Statuses = { byId: Record<string, { color?: AgentColor }> }
const stores = vi.hoisted(() => ({
  local: { byId: {} } as Statuses,
  hosts: {} as Record<string, Statuses>,
}))
vi.mock('@renderer/stores/agents', () => ({
  useAgentsStore: (select: (s: unknown) => unknown) => select(stores),
  agentsOn: (s: typeof stores, hostId: string | null) =>
    hostId === null ? s.local : (s.hosts[hostId] ?? { byId: {} }),
}))

describe('agent avatars', () => {
  it.each([14, 18, 30, 40])('keeps the color dot proportional at %d px', (size) => {
    const html = renderToStaticMarkup(
      createElement(AgentMark, { agent: 'codex~work', size, dot: 'rose' }),
    )
    const dot = html.match(/<span[^>]*style="([^"]*--agent-rose[^"]*)"/)?.[1] ?? ''
    const width = Number.parseFloat(dot.match(/(?:^|;)width:([\d.]+)px/)?.[1] ?? '')
    const ring = Number.parseFloat(dot.match(/box-shadow:0 0 0 ([\d.]+)px/)?.[1] ?? '')
    expect(width).toBeGreaterThanOrEqual(3)
    expect(width).toBeLessThanOrEqual(size / 3)
    expect(ring).toBeGreaterThan(0)
    expect(ring).toBeLessThanOrEqual(width / 3)
  })

  it.each([18, 30, 40])('draws a flat avatar with a readable mark at %d px', (size) => {
    const html = renderToStaticMarkup(
      createElement(AgentTile, { agent: 'codex~work', size, dot: 'rose' }),
    )
    const root = html.slice(0, html.indexOf('>'))
    const glyph = Number(html.match(/<svg width="(\d+)"/)?.[1])
    expect(root).not.toMatch(/\b(?:bg-|shadow-|border-)/)
    expect(glyph).toBeGreaterThanOrEqual(size * 0.7)
    expect(glyph).toBeLessThanOrEqual(size * 0.8)
    expect(html.match(/var\(--agent-rose\)/g)).toHaveLength(1)
  })
})

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
      // Inside Settings showing another host, the marks are that host's.
      const inStudio = renderToStaticMarkup(
        createElement(
          AgentMarkHost.Provider,
          { value: 'studio' },
          createElement(AgentMark, { agent: 'codex~work' }),
        ),
      )
      expect(inStudio).toContain('var(--agent-amber)')
      expect(mark('codex~work', { hostId: 'gone' })).toBe(mark('codex'))
      expect(mark('codex~work', { dot: 'green' })).toContain('var(--agent-green)')
      expect(mark('codex~work', { dot: null })).toBe(mark('codex'))
    } finally {
      stores.local = { byId: {} }
      stores.hosts = {}
    }
  })
})
