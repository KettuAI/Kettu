import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', {
  kettu: { perf: false, platform: 'darwin', client: 'desktop' },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const { keyCaps, shortcutList } = await import('./shortcuts')

describe('shortcutList', () => {
  const keysOf = (sendKey: 'enter' | 'mod-enter', action: string) =>
    shortcutList(sendKey).find((row) => row.action === action)?.keys

  it("follows the send key setting for the composer's keys", () => {
    expect(keysOf('enter', 'send')).toBe('Enter')
    expect(keysOf('enter', 'sendNow')).toBe('Mod+Enter')
    expect(keysOf('enter', 'newLine')).toBe('Shift+Enter')
    expect(keysOf('mod-enter', 'send')).toBe('Mod+Enter')
    expect(keysOf('mod-enter', 'sendNow')).toBe('Mod+Shift+Enter')
    expect(keysOf('mod-enter', 'newLine')).toBe('Enter')
  })

  it('lists each action once per group', () => {
    const rows = shortcutList('enter')
    expect(new Set(rows.map((row) => `${row.group}:${row.action}`)).size).toBe(rows.length)
  })
})

describe('keyCaps', () => {
  it('puts each key on a cap, a range of keys on one', () => {
    expect(keyCaps('1-9')).toEqual(['1–9'])
    expect(keyCaps('Enter')).toEqual(['↵'])
    expect(keyCaps('Ctrl+`')).toEqual(['⌃', '`'])
    expect(keyCaps('Mod+=')).toEqual(['⌘', '='])
    expect(keyCaps('Mod+Shift+[')).toEqual(['⇧', '⌘', '['])
  })
})
