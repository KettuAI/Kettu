// What every kind of device looks like to the host: a stream of encoded frames, the screen they
// show, and input to send back.

import type {
  DeviceFrame,
  DeviceInput,
  DeviceOrientation,
  DeviceScreen,
  FrameKind,
} from '@shared/device-host'

export interface DriverEvents {
  frame(kind: FrameKind, data: Uint8Array): void
  screen(screen: DeviceScreen): void
  /** The stream ended or could not start; `error` says why, for the pane. */
  ended(error: string | null): void
  input(available: boolean): void
}

export interface DeviceDriver {
  start(events: DriverEvents): Promise<void>
  stop(): Promise<void>
  send(input: DeviceInput): void
  /** Asks the encoder for a keyframe, for a client that joined or fell behind. */
  requestKeyframe(): void
  screenshot(): Promise<Uint8Array>
  /** The device's own frame, where the driver knows one. */
  frame?(): Promise<DeviceFrame | null>
  /** Turns the device so its stream reports the turn; true once it has. */
  orient?(orientation: DeviceOrientation): Promise<boolean>
}

export class DriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** `KeyboardEvent.code` to USB HID usage page 7, for the keys a phone keyboard has. */
export function hidUsage(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65)
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49)
  if (code === 'Digit0') return 0x27
  return HID_USAGE[code] ?? null
}

const HID_USAGE: Record<string, number> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  Home: 0x4a,
  End: 0x4d,
  PageUp: 0x4b,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
}

/** A printable ASCII character as the HID key and whether Shift is held, on a US layout. */
export function asciiKey(character: string): { usage: number; shift: boolean } | null {
  if (/^[a-z]$/.test(character)) return { usage: 0x04 + character.charCodeAt(0) - 97, shift: false }
  if (/^[A-Z]$/.test(character)) return { usage: 0x04 + character.charCodeAt(0) - 65, shift: true }
  if (/^[1-9]$/.test(character)) return { usage: 0x1e + character.charCodeAt(0) - 49, shift: false }
  const plain: Record<string, number> = {
    '0': 0x27,
    ' ': 0x2c,
    '\n': 0x28,
    '\t': 0x2b,
    '-': 0x2d,
    '=': 0x2e,
    '[': 0x2f,
    ']': 0x30,
    '\\': 0x31,
    ';': 0x33,
    "'": 0x34,
    '`': 0x35,
    ',': 0x36,
    '.': 0x37,
    '/': 0x38,
  }
  if (character in plain) return { usage: plain[character]!, shift: false }
  const shifted: Record<string, number> = {
    '!': 0x1e,
    '@': 0x1f,
    '#': 0x20,
    $: 0x21,
    '%': 0x22,
    '^': 0x23,
    '&': 0x24,
    '*': 0x25,
    '(': 0x26,
    ')': 0x27,
    _: 0x2d,
    '+': 0x2e,
    '{': 0x2f,
    '}': 0x30,
    '|': 0x31,
    ':': 0x33,
    '"': 0x34,
    '~': 0x35,
    '<': 0x36,
    '>': 0x37,
    '?': 0x38,
  }
  if (character in shifted) return { usage: shifted[character]!, shift: true }
  return null
}
