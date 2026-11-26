import type { Project } from '@shared/agent-host'
import { basename } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'

/** The folders a path sits in, outermost first, for either separator. */
function parentsOf(path: string): string[] {
  return path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .slice(0, -1)
    .filter(Boolean)
}

interface NamedPath {
  path: string
  name: string
}

function hintsForNamed(items: readonly NamedPath[]): Map<string, string> {
  const byName = new Map<string, string[]>()
  for (const item of items) {
    byName.set(item.name, [...(byName.get(item.name) ?? []), item.path])
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

/**
 * What tells folders with the same basename apart, keyed by path: the fewest trailing parent
 * folders that differ between them, as "work" or "client/src". A name no other path shares
 * gets no entry.
 */
export function nameHints(paths: readonly string[]): Map<string, string> {
  return hintsForNamed(paths.map((path) => ({ path, name: basename(path) })))
}

/**
 * Disambiguates projects on each host that share the same display name (or folder basename when
 * plain paths are passed), keyed by the window's qualified path.
 */
export function projectNameHints(
  items: readonly (string | Pick<Project, 'path' | 'name'>)[],
): Map<string, string> {
  const normalized: NamedPath[] = items.map((item) =>
    typeof item === 'string'
      ? { path: item, name: basename(hostPath(item)) }
      : { path: item.path, name: item.name },
  )
  const hints = new Map<string, string>()
  for (const hostId of new Set(normalized.map((item) => hostOfPath(item.path)))) {
    const own = normalized.filter((item) => hostOfPath(item.path) === hostId)
    const found = hintsForNamed(own.map((item) => ({ path: hostPath(item.path), name: item.name })))
    for (const item of own) {
      const hint = found.get(hostPath(item.path))
      if (hint) hints.set(item.path, hint)
    }
  }
  return hints
}
