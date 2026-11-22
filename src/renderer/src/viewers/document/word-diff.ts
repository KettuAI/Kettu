// The words a changed passage lost and gained, for showing both in the text: a longest common
// subsequence of words and the spaces between them.

export interface DiffPart {
  op: 'same' | 'removed' | 'added'
  text: string
}

/** Above this many pairs of words the whole passage counts as replaced. */
const MAX_PAIRS = 250_000

function words(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part !== '')
}

function push(parts: DiffPart[], op: DiffPart['op'], text: string): void {
  const last = parts[parts.length - 1]
  if (last?.op === op) last.text += text
  else parts.push({ op, text })
}

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = words(before)
  const b = words(after)
  const parts: DiffPart[] = []
  if (a.length * b.length > MAX_PAIRS) {
    if (before) parts.push({ op: 'removed', text: before })
    if (after) parts.push({ op: 'added', text: after })
    return parts
  }
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(parts, 'same', a[i]!)
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) push(parts, 'removed', a[i++]!)
    else push(parts, 'added', b[j++]!)
  }
  while (i < a.length) push(parts, 'removed', a[i++]!)
  while (j < b.length) push(parts, 'added', b[j++]!)
  return merge(parts)
}

/**
 * Neighbouring changes as one removal and one addition, a space between two changes taken into
 * both, so "a b" to "c d" reads as one change.
 */
function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = []
  const space = (k: number) => parts[k]?.op === 'same' && /^\s+$/.test(parts[k]!.text)
  let k = 0
  while (k < parts.length) {
    if (parts[k]!.op === 'same') {
      push(out, 'same', parts[k++]!.text)
      continue
    }
    let removed = ''
    let added = ''
    for (;;) {
      const part = parts[k]
      if (part && part.op !== 'same') {
        if (part.op === 'removed') removed += part.text
        else added += part.text
        k++
      } else if (space(k) && parts[k + 1] && parts[k + 1]!.op !== 'same') {
        removed += parts[k]!.text
        added += parts[k]!.text
        k++
      } else break
    }
    if (removed.trim()) out.push({ op: 'removed', text: removed })
    if (added.trim()) out.push({ op: 'added', text: added })
  }
  return out
}
