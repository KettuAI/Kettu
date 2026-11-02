import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { ArtifactSummary } from '@shared/artifacts'

vi.stubGlobal('window', { kettu: { perf: false, platform: 'darwin', client: 'desktop' } })

const { placeAgo, placeTitle } = await import('./place-title')
const { useSessionsStore } = await import('@renderer/stores/sessions')
const { useArtifactsStore } = await import('@renderer/stores/artifacts')

const MINUTE = 60_000

describe('placeTitle', () => {
  it("names a session by its title, and Settings' pages by section and item", () => {
    useSessionsStore.setState({
      byId: { s1: { id: 's1', title: 'Add a usage heatmap' } as SessionSummary },
    })
    expect(placeTitle({ kind: 'session', sessionId: 's1' })).toBe('Add a usage heatmap')
    expect(placeTitle({ kind: 'settings', section: 'agents', item: null })).toBe(
      'Settings › Agents',
    )
    expect(placeTitle({ kind: 'settings', section: 'usage', item: null })).toBe('Settings › Usage')
    expect(placeTitle({ kind: 'settings', section: 'mcp', item: 'github' })).toBe(
      'Settings › MCP servers › github',
    )
  })

  it("names the pages, and an artifact by its title once it's known", () => {
    expect(placeTitle({ kind: 'usage' })).toBe('Usage')
    expect(placeTitle({ kind: 'routine', routineId: null })).toBe('New routine')
    expect(placeTitle({ kind: 'artifacts', deleted: true })).toBe('Artifacts › Recently deleted')
    const back = { kind: 'artifacts' } as const
    expect(placeTitle({ kind: 'artifact', id: 'a1', back })).toBe('Artifact')
    useArtifactsStore.setState({ list: [{ id: 'a1', title: 'Heatmap' } as ArtifactSummary] })
    expect(placeTitle({ kind: 'artifact', id: 'a1', back })).toBe('Heatmap')
  })
})

describe('placeAgo', () => {
  it('counts minutes, then hours', () => {
    const now = 100 * 60 * MINUTE
    expect(placeAgo(now - 30_000, now)).toBe('just now')
    expect(placeAgo(now - 2 * MINUTE, now)).toBe('2 min')
    expect(placeAgo(now - 59 * MINUTE, now)).toBe('59 min')
    expect(placeAgo(now - 3 * 60 * MINUTE, now)).toBe('3 h')
  })
})
