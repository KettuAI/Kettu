import { describe, expect, it } from 'vitest'
import {
  agentColor,
  DEFAULT_SETTINGS,
  isAgentColor,
  nextAgentColor,
  stepZoom,
  type AddedAgent,
} from './settings'

describe('stepZoom', () => {
  it("steps through Chrome's zoom levels", () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1.1, 1)).toBe(1.25)
    expect(stepZoom(1.1, -1)).toBe(1)
    expect(stepZoom(0.9, -1)).toBe(0.8)
  })

  it('holds at the ends', () => {
    expect(stepZoom(1.5, 1)).toBe(1.5)
    expect(stepZoom(0.8, -1)).toBe(0.8)
  })

  it('resets to the default', () => {
    expect(stepZoom(1.5, 0)).toBe(DEFAULT_SETTINGS.appearance.zoom)
    expect(DEFAULT_SETTINGS.appearance.zoom).toBe(1)
  })
})

const agent = (id: AddedAgent['id'], color?: AddedAgent['color']): AddedAgent => ({
  id,
  name: id,
  configDir: `/srv/${id}`,
  created: true,
  ...(color && { color }),
})

describe('agentColor', () => {
  it("is an added agent's own color", () => {
    expect(agentColor([agent('codex~a', 'rose')], 'codex~a')).toBe('rose')
  })

  it('falls back to one by its place in the list, for a file from before colors', () => {
    const agents = [agent('codex~a'), agent('claude-code~b'), agent('codex~c', 'slate')]
    expect(agentColor(agents, 'codex~a')).toBe('teal')
    expect(agentColor(agents, 'claude-code~b')).toBe('violet')
    expect(agentColor(agents, 'codex~c')).toBe('slate')
  })

  it('is null for a default agent or one not in the list', () => {
    expect(agentColor([agent('codex~a')], 'codex')).toBeNull()
    expect(agentColor([agent('codex~a')], 'codex~z')).toBeNull()
  })
})

describe('nextAgentColor', () => {
  it('picks the first color nobody has, and the first once all are taken', () => {
    expect(nextAgentColor([])).toBe('teal')
    expect(nextAgentColor([agent('codex~a', 'teal'), agent('codex~b')])).toBe('amber')
    const all = ['teal', 'violet', 'amber', 'rose', 'green', 'slate'] as const
    expect(nextAgentColor(all.map((color, i) => agent(`codex~${i}`, color)))).toBe('teal')
  })
})

describe('isAgentColor', () => {
  it('knows the palette only', () => {
    expect(isAgentColor('teal')).toBe(true)
    expect(isAgentColor('blue')).toBe(false)
    expect(isAgentColor(undefined)).toBe(false)
  })
})
