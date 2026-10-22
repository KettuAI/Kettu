import { basename } from '@renderer/lib/format'

/** The folders a path sits in, outermost first, for either separator. */
function parentsOf(path: string): string[] {
  return path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .slice(0, -1)
    .filter(Boolean)
}

/**
 * What tells projects with the same folder name apart, keyed by path: the fewest trailing parent
 * folders that differ between them, as "work" or "client/src". A name no other project shares
 * gets no entry.
 */
export function nameHints(paths: readonly string[]): Map<string, string> {
  const byName = new Map<string, string[]>()
  for (const path of paths) {
    const name = basename(path)
    byName.set(name, [...(byName.get(name) ?? []), path])
  }
  const hints = new Map<string, string>()
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const parents = group.map(parentsOf)
    const deepest = Math.max(...parents.map((p) => p.length))
    for (let depth = 1; depth <= deepest; depth++) {
      const tails = parents.map((p) => p.slice(-depth).join('/'))
      if (depth < deepest && new Set(tails).size < tails.length) continue
      group.forEach((path, i) => {
        if (tails[i]) hints.set(path, tails[i])
      })
      break
    }
  }
  return hints
}
