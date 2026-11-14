// A terminal's output as plain text, as an agent reads it and a reply's command bar shows it.

const MAX_CHARS = 64 * 1024

/* eslint-disable no-control-regex */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ESCAPE = /\x1b[@-Z\\-_]?/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g
/* eslint-enable no-control-regex */

/** One line as it ends up on screen: a carriage return starts it over, a backspace erases. */
function settle(line: string): string {
  const shown = line.slice(line.lastIndexOf('\r') + 1)
  let out = ''
  for (const char of shown) out = char === '\b' ? out.slice(0, -1) : out + char
  return out.replace(CONTROL, '').trimEnd()
}

/** The last `lines` lines of `raw` output as plain text, at most 64 KiB of it. */
export function plainTail(raw: string, lines: number): string {
  const text = raw.replace(OSC, '').replace(CSI, '').replace(ESCAPE, '').replace(/\r\n/g, '\n')
  const settled = text.split('\n').map(settle)
  while (settled.length > 0 && settled[settled.length - 1] === '') settled.pop()
  const kept = settled.slice(-lines)
  while (kept.length > 0 && kept[0] === '') kept.shift()
  const tail = kept.join('\n')
  return tail.length > MAX_CHARS ? tail.slice(-MAX_CHARS) : tail
}
