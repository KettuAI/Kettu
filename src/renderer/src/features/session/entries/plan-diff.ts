// What changed between two versions of a plan, line by line, for the plan card's Changes view.

export type PlanLine =
  | { kind: 'same'; count: number }
  | { kind: 'removed'; text: string }
  | { kind: 'added'; text: string }

/**
 * The plan's lines as they read, without blank ones: no heading marks, emphasis or code ticks,
 * which would only clutter a line-by-line comparison.
 */
function lines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/(\*\*|__|`)(.+?)\1/g, '$2'),
    )
    .filter((line) => line !== '')
}

/**
 * The lines of `next` against `previous`: the removed and added ones in order, with each run of
 * unchanged lines folded into a count. A longest common subsequence keeps it minimal.
 */
export function planDiff(previous: string, next: string): PlanLine[] {
  const a = lines(previous)
  const b = lines(next)
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const out: PlanLine[] = []
  const same = () => {
    const last = out.at(-1)
    if (last?.kind === 'same') last.count++
    else out.push({ kind: 'same', count: 1 })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      same()
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: 'removed', text: a[i++]! })
    } else {
      out.push({ kind: 'added', text: b[j++]! })
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! })
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! })
  return out
}
