// The Files pane's view of a project's paths: the filter's matching and the tree's rows. Paths are
// relative to the project's root, with `/` between segments.

export interface PathMatch {
  path: string
  score: number
  /** Indexes into `path` of the matched characters, for highlighting. */
  positions: number[]
}

const SEPARATORS = new Set(['/', '-', '_', '.', ' '])

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, '')
}

/**
 * The score of `path`, whose lowercase form is `lower`, for a normalized query, with the indexes
 * of the matched characters written into `positions`; null when they do not appear in order.
 */
function scorePath(q: string, path: string, lower: string, positions: number[]): number | null {
  const nameStart = path.lastIndexOf('/', path.length - 2) + 1
  // As fzf's first algorithm: forward to the end of the first full match, then back from there,
  // which settles on the shortest stretch that ends there.
  let at = 0
  for (let i = 0; i < q.length; i++) {
    at = lower.indexOf(q[i]!, at)
    if (at < 0) return null
    at++
  }
  at--
  for (let i = q.length - 1; i >= 0; i--) {
    while (lower[at] !== q[i]) at--
    positions[i] = at
    at--
  }
  let score = 0
  for (let i = 0; i < q.length; i++) {
    const index = positions[i]!
    score += 1
    if (i > 0 && positions[i - 1] === index - 1) score += 5
    if (index === 0 || SEPARATORS.has(path[index - 1]!)) score += 4
    if (index >= nameStart) score += 2
  }
  return score - path.length / 1000
}

const ranksBefore = (score: number, path: string, other: PathMatch): boolean =>
  score > other.score || (score === other.score && path < other.path)

const lowerCase = new WeakMap<readonly string[], string[]>()

/**
 * The best `limit` paths for the query, without sorting every match, for a list too long to rank
 * on each keystroke, and how many matched in all. The query's characters must appear in the path
 * in order, ignoring case and spaces; consecutive characters, characters at the start of a word
 * and characters in the file name count for more, and a shorter path wins a tie. A folder's path
 * ends in `/`, and its last segment is its name. A list's lowercase form is kept while it lives.
 */
export function rankPaths(
  query: string,
  paths: readonly string[],
  limit: number,
): { matches: PathMatch[]; total: number } {
  if (limit <= 0) return { matches: [], total: 0 }
  const q = normalizeQuery(query)
  let lower = lowerCase.get(paths)
  if (!lower) {
    lower = paths.map((path) => path.toLowerCase())
    lowerCase.set(paths, lower)
  }
  const best: PathMatch[] = []
  const positions = new Array<number>(q.length)
  let total = 0
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!
    const score = q ? scorePath(q, path, lower[i]!, positions) : 0
    if (score === null) continue
    total++
    if (best.length === limit && !ranksBefore(score, path, best[limit - 1]!)) continue
    let low = 0
    let high = best.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (ranksBefore(score, path, best[middle]!)) high = middle
      else low = middle + 1
    }
    best.splice(low, 0, { path, score, positions: positions.slice() })
    if (best.length > limit) best.pop()
  }
  return { matches: best, total }
}

/** The best `limit` matches, ranked as `rankPaths` ranks them. */
export function bestPaths(query: string, paths: readonly string[], limit: number): PathMatch[] {
  return rankPaths(query, paths, limit).matches
}

export interface Folder {
  folders: string[]
  files: string[]
}

const byName = (a: string, b: string) => {
  const x = nameOf(a).toLowerCase()
  const y = nameOf(b).toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Each folder's direct children, folders and files apart, keyed by the folder's path ('' is the
 * root). `empty` names folders with nothing in them, which no file path gives.
 */
export function indexFolders(
  paths: readonly string[],
  empty: readonly string[] = [],
): Map<string, Folder> {
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
  for (const path of empty) if (path !== '') folder(path)
  for (const entry of index.values()) {
    entry.folders.sort(byName)
    entry.files.sort(byName)
  }
  return index
}

/** Whether `path` lies inside one of `folders`, below it. */
export function insideAny(path: string, folders: ReadonlySet<string>): boolean {
  for (let folder = folderOf(path); folder !== ''; folder = folderOf(folder)) {
    if (folders.has(folder)) return true
  }
  return false
}

/**
 * The folders of `index` that hold none of the files and empty folders git does not ignore, so
 * that all in them is ignored.
 */
export function ignoredOnly(
  index: ReadonlyMap<string, Folder>,
  files: readonly string[],
  empty: readonly string[],
): string[] {
  const holding = new Set<string>()
  // A folder already counted has every folder above it counted too.
  const hold = (from: string) => {
    for (let folder = from; folder !== '' && !holding.has(folder); folder = folderOf(folder)) {
      holding.add(folder)
    }
  }
  for (const path of files) hold(folderOf(path))
  for (const folder of empty) hold(folder)
  return [...index.keys()].filter((folder) => folder !== '' && !holding.has(folder))
}

/**
 * The index with the insides of folders read one at a time, which the list left empty; a read
 * folder's own folders come in empty until they are read too. Only folders `unread` names take
 * their read.
 */
export function withReads(
  index: ReadonlyMap<string, Folder>,
  reads: readonly (readonly [string, Folder])[],
  unread: (folder: string) => boolean,
): Map<string, Folder> {
  const out = new Map(index)
  // A folder before the folders in it, which its read brings into the index.
  const ordered = [...reads].sort(([a], [b]) => a.length - b.length)
  for (const [folder, read] of ordered) {
    if (!out.has(folder) || !unread(folder)) continue
    out.set(folder, {
      folders: [...read.folders].sort(byName),
      files: [...read.files].sort(byName),
    })
    for (const inner of read.folders)
      if (!out.has(inner)) out.set(inner, { folders: [], files: [] })
  }
  return out
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

/** `name` in `folder`, '' being the project's own. */
export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

/** Whether `path` is `folder` or lies inside it. */
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

/** The paths that no other of them holds, in their order: a folder stands for what is in it. */
export function outermost(paths: readonly string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && isWithin(path, other)))
}

/** Where `path` is after `from` moved to `to`: itself when it is neither `from` nor inside it. */
export function movedPath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? `${to}${path.slice(from.length)}` : path
}
