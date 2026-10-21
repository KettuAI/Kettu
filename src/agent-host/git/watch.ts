// Watches a repository's git dir and says when something in it changed.

import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export type WatchFn = (
  path: string,
  options: { recursive?: boolean; persistent: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher

export interface GitDirWatchOptions {
  gitDir: string
  /** Shared refs and config; differs from `gitDir` in a linked worktree. */
  commonDir: string
  /** Quiet time before a change is reported. */
  debounceMs?: number
  /** A burst of changes is reported at the latest after this long. */
  maxWaitMs?: number
  /** Called once per burst of relevant changes, and once when a watcher fails. */
  onChange(): void
  onError(error: Error): void
  watch?: WatchFn
}

export interface GitDirWatch {
  readonly mode: 'recursive' | 'fallback'
  /** False after a watcher failed; the owner should start a new one. */
  readonly alive: boolean
  close(): void
}

const DEBOUNCE_MS = 300
const MAX_WAIT_MS = 2000

/** Objects and logs change on every git command without changing what is shown. */
export function shouldIgnore(filename: string | null): boolean {
  if (filename === null || filename === '') return false
  const segments = filename.split(/[\\/]/).filter(Boolean)
  const first = segments[0]
  if (first === 'objects' || first === 'logs') return true
  return (segments[segments.length - 1] ?? '').endsWith('.lock')
}

export async function watchGitDir(options: GitDirWatchOptions): Promise<GitDirWatch> {
  const watch = options.watch ?? (fsWatch as unknown as WatchFn)
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS
  const watchers: FSWatcher[] = []
  let closed = false
  let alive = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let burstStart = 0

  const fire = (): void => {
    timer = null
    if (!closed) options.onChange()
  }
  const trigger = (): void => {
    if (closed) return
    const now = Date.now()
    if (timer === null) burstStart = now
    else clearTimeout(timer)
    timer = setTimeout(fire, Math.max(0, Math.min(debounceMs, burstStart + maxWaitMs - now)))
    timer.unref()
  }

  const add = (path: string, recursive: boolean): void => {
    const watcher = watch(path, { recursive, persistent: false }, (_event, filename) => {
      if (!shouldIgnore(filename === null ? null : filename.toString())) trigger()
    })
    watcher.on('error', (error) => {
      alive = false
      watcher.close()
      options.onError(error)
      trigger()
    })
    watchers.push(watcher)
  }

  const closeAll = (): void => {
    for (const watcher of watchers.splice(0)) watcher.close()
  }

  const dirs = [...new Set([options.gitDir, options.commonDir])]
  let mode: GitDirWatch['mode'] = 'recursive'
  try {
    add(options.gitDir, true)
    if (options.commonDir !== options.gitDir) {
      add(join(options.commonDir, 'refs'), true)
      add(options.commonDir, false)
    }
  } catch {
    // Recursive watching is not available here.
    closeAll()
    mode = 'fallback'
    for (const dir of dirs) {
      for (const path of await fallbackTargets(dir)) {
        try {
          add(path, false)
        } catch (error) {
          options.onError(error instanceof Error ? error : new Error(String(error)))
        }
      }
    }
  }

  return {
    mode,
    get alive() {
      return alive
    },
    close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      closeAll()
    },
  }
}

// The git dir itself plus the directories where branch refs live, one level at a time.
async function fallbackTargets(dir: string): Promise<string[]> {
  const targets = [dir, join(dir, 'refs', 'heads'), join(dir, 'refs', 'remotes')]
  try {
    const remotes = await readdir(join(dir, 'refs', 'remotes'), { withFileTypes: true })
    for (const entry of remotes) {
      if (entry.isDirectory()) targets.push(join(dir, 'refs', 'remotes', entry.name))
    }
  } catch {
    // No remote has been fetched yet.
  }
  return targets
}
