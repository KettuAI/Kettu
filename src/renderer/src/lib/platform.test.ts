import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', { kettu: { platform: 'darwin', client: 'desktop' } })

const { formatShortcut } = await import('./platform')

describe('formatShortcut on macOS', () => {
  it('writes the modifiers in the order Control, Option, Shift, Command', () => {
    expect(formatShortcut('Mod+Shift+V')).toBe('⇧⌘V')
    expect(formatShortcut('Mod+Alt+Ctrl+K')).toBe('⌃⌥⌘K')
    expect(formatShortcut('Shift+Mod+Alt+Ctrl+Enter')).toBe('⌃⌥⇧⌘↩')
  })

  it('keeps a plus key', () => {
    expect(formatShortcut('Mod++')).toBe('⌘+')
  })
})
