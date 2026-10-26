// Web addresses in plain text, such as a notice's description, which has no Markdown to link them.

export type TextPart = { type: 'text'; text: string } | { type: 'link'; url: string }

// From http:// or https:// that no letter or digit runs into, over printable ASCII but < > and ".
// Stopping at anything else keeps Chinese punctuation and text that follows an address out of it.
const ADDRESS = /(?<![a-z0-9])https?:\/\/[!#-;=?-~]*/gi
const TRAILING = new Set(['.', ',', ':', ';', '!', '?', "'", '"', '*', '_', '~'])
const CLOSING = { ')': '(', ']': '[' } as const

const count = (text: string, char: string): number => text.split(char).length - 1

/** The address without what ends the sentence around it, or a bracket it did not open. */
function trimEnd(address: string): string {
  let end = address.length
  for (;;) {
    const last = address[end - 1] ?? ''
    const kept = address.slice(0, end)
    if (TRAILING.has(last)) end--
    else if (last in CLOSING) {
      const opening = CLOSING[last as keyof typeof CLOSING]
      if (count(kept, opening) >= count(kept, last)) break
      end--
    } else break
  }
  return address.slice(0, end)
}

function isWebAddress(address: string): boolean {
  const url = URL.parse(address)
  return (url?.protocol === 'http:' || url?.protocol === 'https:') && url.host !== ''
}

/** The text's parts in order, each plain text or a web address to link. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  const addText = (value: string) => {
    if (value === '') return
    const last = parts.at(-1)
    if (last?.type === 'text') last.text += value
    else parts.push({ type: 'text', text: value })
  }
  let at = 0
  for (const match of text.matchAll(ADDRESS)) {
    const url = trimEnd(match[0])
    if (!isWebAddress(url)) continue
    addText(text.slice(at, match.index))
    parts.push({ type: 'link', url })
    at = match.index + url.length
  }
  addText(text.slice(at))
  return parts
}
