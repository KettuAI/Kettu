// A direct edit of one element of an artifact's HTML: its start tag's `style`, and the text of an
// element that holds text alone. Only that part of the file changes, so what the agent wrote, and
// what scripts make of it, stays as it was.

import {
  checkedStyle,
  EDIT_TEXT_CHARS,
  type PreviewStyle,
} from '@shared/artifact-runtime/page-messages'
import { decodeText, startTagAt, textContentRange, type StartTag } from '@shared/artifact-source'

export interface ElementChange {
  style: PreviewStyle | null
  text: string | null
}

export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

/** A style's declarations, split at the semicolons outside quotes and brackets. */
function declarations(style: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let from = 0
  for (let i = 0; i < style.length; i++) {
    const c = style[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ';' && depth === 0) {
      out.push(style.slice(from, i))
      from = i + 1
    }
  }
  out.push(style.slice(from))
  return out.map((d) => d.trim()).filter((d) => d !== '')
}

/** The tag's `style` with each property of `style` set, at its end, and the others as written. */
export function styleWith(existing: string, style: PreviewStyle): string {
  const set = new Set(Object.keys(style))
  const kept = declarations(existing).filter((d) => {
    const colon = d.indexOf(':')
    return colon < 0 || !set.has(d.slice(0, colon).trim().toLowerCase())
  })
  const added = Object.entries(style).map(([property, value]) => `${property}: ${value}`)
  return [...kept, ...added].join('; ')
}

function attributeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function htmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function withStyleAttribute(html: string, tag: StartTag, style: PreviewStyle): string {
  // The parser takes an attribute's first occurrence, so that is the one to change.
  const current = tag.attributes.find((attribute) => attribute.name === 'style')
  const value = styleWith(
    current?.value === null || !current ? '' : decodeText(current.value),
    style,
  )
  const attribute = `style="${attributeText(value)}"`
  if (current) return html.slice(0, current.start) + attribute + html.slice(current.end)
  return `${html.slice(0, tag.nameEnd)} ${attribute}${html.slice(tag.nameEnd)}`
}

/**
 * The HTML with the element whose start tag is at `offset` changed: its text replaced, when it
 * holds text alone, and its style's properties set. Refused when no start tag is there, as the
 * scanner that marks served elements finds them, or the element has more than text.
 */
export function editElement(html: string, offset: number, change: ElementChange): string {
  const tag = startTagAt(html, offset)
  if (!tag) throw new EditError(`No element starts at offset ${offset}`)
  let out = html
  // The text lies after the tag, so changing it first leaves the tag's offsets as they are.
  if (change.text !== null) {
    if (change.text.length > EDIT_TEXT_CHARS) throw new EditError('The text is too long')
    const range = textContentRange(html, tag)
    if (!range) throw new EditError(`The <${tag.name}> at offset ${offset} holds more than text`)
    out = out.slice(0, range.start) + htmlText(change.text) + out.slice(range.end)
  }
  if (change.style) {
    const style = checkedStyle(change.style)
    if (!style) throw new EditError('The style has a property or value an edit may not write')
    if (Object.keys(style).length > 0) out = withStyleAttribute(out, tag, style)
  }
  return out
}
