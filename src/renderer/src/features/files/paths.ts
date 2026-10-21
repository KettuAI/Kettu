// The Files pane's view of a project's paths: the filter's matching and the tree's rows. Paths are
// relative to the project's root, with `/` between segments.

export interface PathMatch {
  path: string
  score: number
  /** Indexes into `path` of the matched characters, for highlighting. */
  positions: number[]
}

const SEPARATORS = new Set(['/', '-', '_', '.', ' '])

/**
 * Whether the query's characters appear in the path in order, ignoring case, and how well:
 * consecutive characters, characters at the start of a word and characters in the file name
 * count for more, and a shorter path wins a tie. Null when they do not appear.
 */
export function matchPath(query: string, path: string): PathMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { path, score: 0, positions: [] }
  const p = path.toLowerCase()
  const nameStart = path.lastIndexOf('/') + 1
  // As fzf's first algorithm: forward to the end of the first full match, then back from there,
  // which settles on the shortest stretch that ends there.
  let at = 0
  for (const char of q) {
    at = p.indexOf(char, at)
    if (at < 0) return null
    at++
  }
  const positions: number[] = []
  at--
  for (let i = q.length - 1; i >= 0; i--) {
    while (p[at] !== q[i]) at--
    positions.push(at)
    at--
  }
  positions.reverse()
  let score = 0
  for (let i = 0; i < positions.length; i++) {
    const index = positions[i]!
    score += 1
    if (i > 0 && positions[i - 1] === index - 1) score += 5
    if (index === 0 || SEPARATORS.has(path[index - 1]!)) score += 4
    if (index >= nameStart) score += 2
  }
  return { path, score: score - path.length / 1000, positions }
}

/** The paths that match, best first, at most `limit` of them, and how many matched in all. */
export function filterPaths(
  query: string,
  paths: readonly string[],
  limit: number,
): { matches: PathMatch[]; total: number } {
  const matches: PathMatch[] = []
  for (const path of paths) {
    const match = matchPath(query, path)
    if (match) matches.push(match)
  }
  matches.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
  return { matches: matches.slice(0, limit), total: matches.length }
}

export interface Folder {
  folders: string[]
  files: string[]
}

/** Each folder's direct children, folders and files apart, keyed by the folder's path ('' is the root). */
export function indexFolders(paths: readonly string[]): Map<string, Folder> {
  const index = new Map<string, Folder>([['', { folders: [], files: [] }]])
  const folder = (path: string): Folder => {
    let entry = index.get(path)
    if (!entry) {
      entry = { folders: [], files: [] }
      index.set(path, entry)
      const slash = path.lastIndexOf('/')
      folder(slash < 0 ? '' : path.slice(0, slash)).folders.push(path)
    }
    return entry
  }
  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    folder(slash < 0 ? '' : path.slice(0, slash)).files.push(path)
  }
  const byName = (a: string, b: string) => {
    const x = nameOf(a).toLowerCase()
    const y = nameOf(b).toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  for (const entry of index.values()) {
    entry.folders.sort(byName)
    entry.files.sort(byName)
  }
  return index
}

export interface TreeRow {
  path: string
  depth: number
  folder: boolean
}

/** The rows on screen: each folder's folders, then its files, and the insides of open folders. */
export function treeRows(index: Map<string, Folder>, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (path: string, depth: number) => {
    const entry = index.get(path)
    if (!entry) return
    for (const folder of entry.folders) {
      rows.push({ path: folder, depth, folder: true })
      if (open.has(folder)) walk(folder, depth + 1)
    }
    for (const file of entry.files) rows.push({ path: file, depth, folder: false })
  }
  walk('', 0)
  return rows
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** Every folder above the path, outermost first, so revealing a file can open them. */
export function foldersAbove(path: string): string[] {
  const folders: string[] = []
  let slash = path.indexOf('/')
  while (slash >= 0) {
    folders.push(path.slice(0, slash))
    slash = path.indexOf('/', slash + 1)
  }
  return folders
}
