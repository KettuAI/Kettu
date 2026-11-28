import { describe, expect, it } from 'vitest'
import {
  PROJECT_ICON_COLORS,
  PROJECT_ICON_EMOJI_MAX,
  PROJECT_ICON_NAMES,
  extractSingleProjectEmoji,
  isProjectIconColor,
  isProjectIconName,
  isValidProjectEmoji,
  parseProjectIcon,
  projectIconsEqual,
  validateProjectIcon,
} from './project-icon'

describe('project-icon shared helpers', () => {
  it('recognizes curated icon names and preset color tokens', () => {
    for (const name of PROJECT_ICON_NAMES) {
      expect(isProjectIconName(name)).toBe(true)
    }
    for (const color of PROJECT_ICON_COLORS) {
      expect(isProjectIconColor(color)).toBe(true)
    }
    expect(isProjectIconName('unknown-icon')).toBe(false)
    expect(isProjectIconName('')).toBe(false)
    expect(isProjectIconColor('magenta')).toBe(false)
    expect(isProjectIconColor('#ff0000')).toBe(false)
  })

  it('accepts single emoji graphemes including ZWJ, skin tones, flags and keycaps', () => {
    for (const emoji of ['🚀', '👨‍💻', '🇨🇳', '🏳️‍🌈', '1️⃣', '⚙️', '❤️', '👍🏽', '🦊', '  ✨  ']) {
      expect(isValidProjectEmoji(emoji)).toBe(true)
      expect(extractSingleProjectEmoji(emoji)).toBe(emoji.trim())
    }
  })

  it('rejects non-emoji, multi-grapheme, empty, control-character and overlong inputs', () => {
    const bad = [
      '',
      '   ',
      'a',
      'code',
      '项目',
      '1',
      '#',
      '🚀🔥',
      '🚀a',
      'a🚀',
      '\u0000🚀',
      '🚀\n',
      '🚀'.repeat(PROJECT_ICON_EMOJI_MAX),
    ]
    for (const value of bad) {
      expect(isValidProjectEmoji(value)).toBe(false)
      expect(extractSingleProjectEmoji(value)).toBeNull()
    }
  })

  it('strictly validates IPC/remote project icon payloads', () => {
    expect(validateProjectIcon({ kind: 'icon', value: 'terminal' })).toEqual({
      ok: true,
      icon: { kind: 'icon', value: 'terminal' },
    })
    expect(validateProjectIcon({ kind: 'icon', value: 'terminal', color: null })).toEqual({
      ok: true,
      icon: { kind: 'icon', value: 'terminal' },
    })
    expect(validateProjectIcon({ kind: 'icon', value: 'globe', color: 'green' })).toEqual({
      ok: true,
      icon: { kind: 'icon', value: 'globe', color: 'green' },
    })
    expect(validateProjectIcon({ kind: 'emoji', value: ' 🦊 ' })).toEqual({
      ok: true,
      icon: { kind: 'emoji', value: '🦊' },
    })

    for (const bad of [
      null,
      'terminal',
      [],
      {},
      { kind: 'svg', value: '<svg/>' },
      { kind: 'icon', value: 'not-a-real-icon' },
      { kind: 'icon', value: 'code', color: '#123456' },
      { kind: 'emoji', value: 'not-emoji' },
      { kind: 'emoji', value: '🚀🔥' },
      { kind: 'emoji', value: '🚀', color: 'red' },
      { kind: 'emoji', value: 123 },
    ]) {
      expect(validateProjectIcon(bad).ok).toBe(false)
    }
  })

  it('leniently parses stored project icons and drops invalid entries', () => {
    expect(parseProjectIcon({ kind: 'icon', value: 'flask', color: 'purple' })).toEqual({
      kind: 'icon',
      value: 'flask',
      color: 'purple',
    })
    // An unknown color drops only the color while keeping a valid built-in icon.
    expect(parseProjectIcon({ kind: 'icon', value: 'flask', color: 'neon' })).toEqual({
      kind: 'icon',
      value: 'flask',
    })
    expect(parseProjectIcon({ kind: 'emoji', value: '🧪' })).toEqual({
      kind: 'emoji',
      value: '🧪',
    })
    expect(parseProjectIcon({ kind: 'icon', value: 'removed-icon' })).toBeNull()
    expect(parseProjectIcon({ kind: 'emoji', value: 'abc' })).toBeNull()
    expect(parseProjectIcon('bad')).toBeNull()
  })

  it('compares project icons structurally', () => {
    expect(projectIconsEqual(null, undefined)).toBe(true)
    expect(
      projectIconsEqual({ kind: 'icon', value: 'code' }, { kind: 'icon', value: 'code' }),
    ).toBe(true)
    expect(
      projectIconsEqual(
        { kind: 'icon', value: 'code', color: 'blue' },
        { kind: 'icon', value: 'code' },
      ),
    ).toBe(false)
    expect(projectIconsEqual({ kind: 'emoji', value: '🦊' }, { kind: 'emoji', value: '🚀' })).toBe(
      false,
    )
  })
})
