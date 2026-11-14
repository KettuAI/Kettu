/** The parts of a key event that decide whether it reaches a terminal a turn uses. */
export interface HeldKey {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'])

/**
 * Whether a key still goes through while an agent's turn uses the terminal: Ctrl+C, to stop its
 * command, and what types nothing into it, such as a modifier alone, copying and, on macOS, the
 * app's Command shortcuts. Everything else is held back until the user takes it over.
 */
export function passesHeld(event: HeldKey, mac: boolean): boolean {
  if (MODIFIERS.has(event.key)) return true
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === 'KeyC')
    return true
  // Command never reaches the shell on macOS; a paste is held back as it arrives.
  if (mac) return event.metaKey
  return event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyC'
}
