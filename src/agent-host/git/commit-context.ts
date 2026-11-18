// What a model is shown to write a commit message: the diffs of the files about to be committed,
// bounded, and the subjects of the commits whose style it should match.

import type { ChangedFile } from '@shared/git'
import { GIT_TIMEOUT_MS, type Exec } from './exec'

/** The diffs show this many characters at most, over all files... */
export const DIFF_CHARS = 24_000
/** ...and one file's, this many. */
const FILE_DIFF_CHARS = 6_000
const SUBJECTS = 10
// Files whose diffs are read at once.
const BATCH = 8

export interface CommitContext {
  files: ChangedFile[]
  /** The diffs of the files that fit, one after another. */
  diff: string
  /** How many files have no diff in `diff`. */
  omitted: number
  /** The subjects of the repository's latest commits, newest first. */
  recent: string[]
  /** The subjects of the user's own latest commits that `recent` lacks. */
  own: string[]
}

/** A diff cut at a line before `limit` characters, marked as cut. */
function clip(diff: string, limit: number): string {
  if (diff.length <= limit) return diff
  const end = diff.lastIndexOf('\n', limit)
  // Never end on half of a surrogate pair.
  const kept = end > 0 ? diff.slice(0, end) : diff.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '')
  return `${kept}\n[diff cut]\n`
}

/**
 * Reads what the files' changes and the repository's latest commits say, for the files `files`
 * names, which the service already checked; paths are relative to `root`. Never rejects for what
 * git cannot give: a diff or a log it fails is left out.
 */
export async function readCommitContext(
  exec: Exec,
  root: string,
  files: ChangedFile[],
  unborn: boolean,
): Promise<CommitContext> {
  const run = (args: string[]) => exec('git', args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS })

  const diffOf = async (file: ChangedFile): Promise<string> => {
    // A new file has nothing in HEAD to compare with; `--no-index` exits 1 when files differ.
    const fresh = unborn || file.status === 'untracked'
    const result = await run(
      fresh
        ? ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', file.path]
        : [
            'diff',
            '--no-ext-diff',
            '--no-color',
            '-M',
            'HEAD',
            '--',
            ...(file.oldPath === null ? [] : [file.oldPath]),
            file.path,
          ],
    )
    if (result.failure !== null || result.code === null || result.code > (fresh ? 1 : 0)) return ''
    return result.stdout
  }

  const subjects = async (args: string[]): Promise<string[]> => {
    const result = await run([
      'log',
      '-n',
      String(SUBJECTS),
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%s',
      ...args,
      '--',
    ])
    // A branch with no commit has no log.
    if (result.failure !== null || result.code !== 0) return []
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  }

  const [recent, email] = await Promise.all([
    subjects([]),
    run(['config', 'user.email']).then((result) => result.stdout.trim()),
  ])
  const own = email === '' ? [] : await subjects(['--fixed-strings', `--author=${email}`])

  const parts: string[] = []
  let used = 0
  let shown = 0
  for (let i = 0; i < files.length && used < DIFF_CHARS; i += BATCH) {
    const diffs = await Promise.all(files.slice(i, i + BATCH).map(diffOf))
    for (const diff of diffs) {
      if (diff === '' || used >= DIFF_CHARS) continue
      const piece = clip(diff, Math.min(FILE_DIFF_CHARS, DIFF_CHARS - used))
      parts.push(piece)
      used += piece.length
      shown += 1
    }
  }

  const listed = new Set(recent)
  return {
    files,
    diff: parts.join('\n'),
    omitted: files.length - shown,
    recent,
    own: own.filter((subject) => !listed.has(subject)),
  }
}
