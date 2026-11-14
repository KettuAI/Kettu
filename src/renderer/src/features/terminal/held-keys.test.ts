import { describe, expect, it } from 'vitest'
import { passesHeld, type HeldKey } from './held-keys'

const key = (code: string, key: string, mods: Partial<HeldKey> = {}): HeldKey => ({
  code,
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('typing into a terminal a turn uses', () => {
  it('lets Ctrl+C through to stop its command, on every system', () => {
    for (const mac of [true, false]) {
      expect(passesHeld(key('KeyC', 'c', { ctrlKey: true }), mac)).toBe(true)
    }
  })

  it('holds back text, Enter, other control keys and escapes', () => {
    const typed = [
      key('KeyA', 'a'),
      key('KeyA', 'A', { shiftKey: true }),
      key('Enter', 'Enter'),
      key('Backspace', 'Backspace'),
      key('ArrowUp', 'ArrowUp'),
      key('Escape', 'Escape'),
      key('Tab', 'Tab'),
      key('KeyD', 'd', { ctrlKey: true }),
      key('KeyZ', 'z', { ctrlKey: true }),
      key('KeyC', 'c', { ctrlKey: true, altKey: true }),
      key('KeyB', '∫', { altKey: true }),
    ]
    for (const mac of [true, false]) {
      for (const event of typed) expect(passesHeld(event, mac), `${event.code} ${mac}`).toBe(false)
    }
  })

  it('lets copying and lone modifiers through, but not pasting', () => {
    expect(passesHeld(key('ShiftLeft', 'Shift', { shiftKey: true }), false)).toBe(true)
    expect(passesHeld(key('KeyC', 'c', { metaKey: true }), true)).toBe(true)
    expect(passesHeld(key('KeyC', 'C', { ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(passesHeld(key('KeyV', 'V', { ctrlKey: true, shiftKey: true }), false)).toBe(false)
  })
})
