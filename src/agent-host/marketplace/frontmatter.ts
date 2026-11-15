// The top-level values of a SKILL.md's YAML frontmatter, which is all a skill's listing needs:
// plain, quoted, folded and literal scalars, and lists of scalars. Nested maps are passed over.

/** Each top-level key with its value's first line and the lines under it. */
function entries(text: string): { key: string; raw: string; more: string[] }[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return []
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (end === -1) return []
  const body = lines.slice(1, end)
  const out: { key: string; raw: string; more: string[] }[] = []
  let index = 0
  while (index < body.length) {
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*?))?\s*$/.exec(body[index]!)
    index++
    if (!match) continue
    // The lines under the key: a block scalar's text, a plain value's continuation or a list,
    // whose items YAML lets start at the key's own indent.
    const more: string[] = []
    while (
      index < body.length &&
      (body[index]!.trim() === '' || /^\s/.test(body[index]!) || /^-(\s|$)/.test(body[index]!))
    ) {
      more.push(body[index]!)
      index++
    }
    while (more.length > 0 && more[more.length - 1]!.trim() === '') more.pop()
    out.push({ key: match[1]!, raw: match[2] ?? '', more })
  }
  return out
}

/** The frontmatter's top-level scalars by key; empty when the file has none. */
export function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, raw, more } of entries(text)) {
    const value = scalar(raw, more)
    if (value !== null) out[key] = value
  }
  return out
}

/** The frontmatter's top-level lists of scalars by key, block or flow style. */
export function frontmatterLists(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const { key, raw, more } of entries(text)) {
    if (raw === '' && /^\s*-(\s|$)/.test(more[0] ?? '')) {
      out[key] = more
        .filter((line) => /^\s*-(\s|$)/.test(line))
        .map((line) => item(line.replace(/^\s*-\s*/, '')))
    } else if (/^\[.*\]$/.test(raw.replace(/\s+#.*$/, ''))) {
      const inner = raw.replace(/\s+#.*$/, '').slice(1, -1)
      out[key] = inner.trim() === '' ? [] : inner.split(',').map(item)
    }
  }
  return out
}

function item(text: string): string {
  const value = text.replace(/\s+#.*$/, '').trim()
  return value.startsWith('"') || value.startsWith("'") ? (quoted(value) ?? value) : value
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
