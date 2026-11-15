import { describe, expect, it } from 'vitest'
import { compactWindows, contextWindow } from './compact-window'

describe('contextWindow', () => {
  const settings = {
    autoCompactWindow: 500_000,
    modelSettings: {
      'claude-haiku-5-5[1m]': { autoCompactWindow: 150_000 },
      'claude-sonnet-5-5': { autoCompactWindow: 'auto' },
    },
  }

  it('takes the model entry over the top-level window, under any spelling', () => {
    const windows = compactWindows(settings, {})
    expect(contextWindow(windows, 'claude-haiku-5-5-20261101', null)).toBe(150_000)
    expect(contextWindow(windows, 'claude-opus-5-5', null)).toBe(500_000)
  })

  it("keeps the model's own window for auto, and never goes wider than it", () => {
    const windows = compactWindows(settings, {})
    expect(contextWindow(windows, 'claude-sonnet-5-5', 1_000_000)).toBe(1_000_000)
    expect(contextWindow(windows, 'claude-sonnet-5-5', null)).toBeNull()
    expect(contextWindow(windows, 'claude-opus-5-5', 200_000)).toBe(200_000)
  })

  it('lets the environment variable win, from the settings first', () => {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }
    expect(contextWindow(compactWindows(settings, env), 'claude-haiku-5-5', null)).toBe(300_000)
    const own = { ...settings, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' } }
    expect(contextWindow(compactWindows(own, env), 'claude-haiku-5-5', null)).toBe(400_000)
  })

  it('says nothing when neither the settings nor Claude Code do', () => {
    expect(contextWindow(compactWindows({}, {}), 'claude-opus-5-5', null)).toBeNull()
  })
})
