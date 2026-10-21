// Reads the few terminal modes the host must know from a pty's output stream: the window title
// a program sets (OSC 0 or 2) and whether the shell enabled bracketed paste (DECSET 2004).

const MAX_CARRY = 1024
const MAX_TITLE = 256
// eslint-disable-next-line no-control-regex
const TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const BRACKETED_PASTE = /\x1b\[\?2004([hl])/g
const PASTE_ON = '\x1b[?2004h'
const PASTE_OFF = '\x1b[?2004l'

export class OutputScanner {
  private carry = ''
  private titleValue: string | null = null
  private bracketedPasteValue = false

  get title(): string | null {
    return this.titleValue
  }

  get bracketedPaste(): boolean {
    return this.bracketedPasteValue
  }

  /** Scans a chunk; sequences split across chunks are completed by the next one. */
  scan(chunk: string): void {
    if (!chunk.includes('\x1b') && !this.carry) return
    const text = this.carry + chunk
    for (const match of text.matchAll(TITLE)) {
      // eslint-disable-next-line no-control-regex
      const title = match[1].replace(/[\x00-\x1f\x7f]/g, '').trim()
      this.titleValue = title.length > 0 ? title.slice(0, MAX_TITLE) : null
    }
    for (const match of text.matchAll(BRACKETED_PASTE)) this.bracketedPasteValue = match[1] === 'h'
    this.carry = unfinishedTail(text)
  }
}

/** The part of `text` that may be the start of a sequence the next chunk completes. */
function unfinishedTail(text: string): string {
  const escape = text.lastIndexOf('\x1b')
  if (escape < 0) return ''
  const tail = text.slice(escape)
  const isOsc = tail.startsWith('\x1b]')
  const finished = isOsc
    ? tail.includes('\x07') || tail.includes('\x1b\\', 2)
    : tail.startsWith(PASTE_ON) || tail.startsWith(PASTE_OFF)
  if (finished) return ''
  if (isOsc) return tail.length <= MAX_CARRY ? tail : ''
  // Shorter than "\x1b[?2004h"; anything longer is some other complete sequence.
  return tail.length < PASTE_ON.length ? tail : ''
}
