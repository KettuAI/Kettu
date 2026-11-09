// The top-level scalars of a SKILL.md's YAML frontmatter, which is all a skill's listing needs:
// plain, quoted, folded and literal values. Nested maps and lists are passed over.

/** The frontmatter's top-level scalars by key; empty when the file has none. */
export function frontmatter(text: string): Record<string, string> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (end === -1) return {}
  const body = lines.slice(1, end)
  const out: Record<string, string> = {}
  let index = 0
  while (index < body.length) {
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*?))?\s*$/.exec(body[index]!)
    index++
    if (!match) continue
    // The lines indented under the key: a block scalar's text, or a plain value's continuation.
    const more: string[] = []
    while (index < body.length && (body[index]!.trim() === '' || /^\s/.test(body[index]!))) {
      more.push(body[index]!)
      index++
    }
    while (more.length > 0 && more[more.length - 1]!.trim() === '') more.pop()
    const value = scalar(match[2] ?? '', more)
    if (value !== null) out[match[1]!] = value
  }
  return out
}

function scalar(raw: string, more: string[]): string | null {
  const block = /^([|>])[+-]?\d*\s*(?:#.*)?$/.exec(raw)
  if (block) return blockScalar(block[1] === '>', more)
  if (raw.startsWith('"') || raw.startsWith("'")) {
    return quoted([raw, ...more.map((line) => line.trim())].join(' '))
  }
  // A nested map or list under the key, which a listing has no use for.
  if (raw === '' && /^\s*(-\s|[A-Za-z0-9_-]+:)/.test(more[0] ?? '')) return null
  return joined([raw.replace(/\s+#.*$/, ''), ...more.map((line) => line.trim())], false)
}

/**
 * Lines as YAML folds them: a line break between two lines of text becomes a space, each blank
 * line a break; a literal block keeps every break, and so does a folded one around indented lines.
 */
function joined(lines: string[], literal: boolean): string {
  let out = ''
  let breaks = 0
  let indented = false
  for (const line of lines) {
    if (line.trim() === '') {
      breaks++
      continue
    }
    const deeper = /^\s/.test(line)
    if (out !== '') {
      if (literal) out += '\n'.repeat(breaks + 1)
      else out += breaks > 0 ? '\n'.repeat(breaks) : deeper || indented ? '\n' : ' '
    }
    out += line
    breaks = 0
    indented = deeper
  }
  return out.trim()
}

function blockScalar(fold: boolean, lines: string[]): string {
  const filled = lines.filter((line) => line.trim() !== '')
  const indent = Math.min(...filled.map((line) => /^\s*/.exec(line)![0].length))
  return joined(
    lines.map((line) => (line.trim() === '' ? '' : line.slice(indent))),
    !fold,
  )
}

function quoted(text: string): string | null {
  const quote = text[0]!
  let out = ''
  for (let i = 1; i < text.length; i++) {
    const char = text[i]!
    if (quote === "'" && char === "'") {
      if (text[i + 1] !== "'") return out
      out += "'"
      i++
    } else if (quote === '"' && char === '\\') {
      const next = text[++i]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '')
    } else if (quote === '"' && char === '"') {
      return out
    } else {
      out += char
    }
  }
  return null
}
