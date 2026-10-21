import { describe, expect, it } from 'vitest'
import { OutputScanner } from './output-scanner'

describe('OutputScanner', () => {
  it('reads OSC 0 and OSC 2 titles with either terminator', () => {
    const scanner = new OutputScanner()
    scanner.scan('\x1b]0;first\x07text')
    expect(scanner.title).toBe('first')
    scanner.scan('\x1b]2;second\x1b\\')
    expect(scanner.title).toBe('second')
  })

  it('completes a title split across chunks', () => {
    const scanner = new OutputScanner()
    scanner.scan('output \x1b]0;Admin')
    expect(scanner.title).toBeNull()
    scanner.scan('istrator: pwsh\x07 more')
    expect(scanner.title).toBe('Administrator: pwsh')
  })

  it('strips control characters and clears an empty title', () => {
    const scanner = new OutputScanner()
    scanner.scan('\x1b]0;a\x01b\x07')
    expect(scanner.title).toBe('ab')
    scanner.scan('\x1b]0;\x07')
    expect(scanner.title).toBeNull()
  })

  it('tracks bracketed paste mode, also across chunks', () => {
    const scanner = new OutputScanner()
    expect(scanner.bracketedPaste).toBe(false)
    scanner.scan('prompt \x1b[?20')
    scanner.scan('04h$ ')
    expect(scanner.bracketedPaste).toBe(true)
    scanner.scan('\x1b[?2004l')
    expect(scanner.bracketedPaste).toBe(false)
  })

  it('ignores other sequences', () => {
    const scanner = new OutputScanner()
    scanner.scan('\x1b[31mred\x1b[0m \x1b]7;file:///tmp\x07')
    expect(scanner.title).toBeNull()
    expect(scanner.bracketedPaste).toBe(false)
  })
})
