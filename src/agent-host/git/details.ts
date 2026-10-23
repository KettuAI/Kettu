// What the branch popover asks for on demand: a commit's details, the working tree's files,
// commits to pull, and the two sides of one file's change.

import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChangedFile, CommitDetails, FileDiff, LogCommit } from '@shared/git'
import type { Platform } from '@shared/platform'
import { pathKey } from '../paths'
import { expectOk, GIT_TIMEOUT_MS, type Exec, type ExecResult } from './exec'
import {
  parseAuthoredLog,
  parseCommitHeader,
  parseNameStatus,
  parseNumstat,
  parsePorcelainFiles,
  withLineCounts,
} from './parse'

/** A side of a diff larger than this is not sent. */
export const DIFF_SIDE_LIMIT = 1024 * 1024
const BINARY_SNIFF = 8 * 1024
const CHANGES_LIMIT = 500
const LOG_LIMIT = 20

function git(exec: Exec, cwd: string, args: string[]): Promise<ExecResult> {
  return exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS })
}

/** The full message, author and changed files of one commit, against its first parent. */
export async function readCommitDetails(
  exec: Exec,
  cwd: string,
  oid: string,
): Promise<CommitDetails> {
  const show = (...args: string[]): Promise<ExecResult> =>
    git(exec, cwd, ['show', '--no-show-signature', '--encoding=UTF-8', ...args, oid, '--'])
  const [header, names, numbers] = await Promise.all([
    show('-s', '--format=%H%x00%an%x00%ae%x00%at%x00%B'),
    show('--format=', '-z', '-M', '--diff-merges=first-parent', '--name-status'),
    show('--format=', '-z', '-M', '--diff-merges=first-parent', '--numstat'),
  ])
  const parsed = parseCommitHeader(expectOk('git show', header).stdout)
  if (!parsed) throw new Error(`Unexpected git show output for ${oid}`)
  const files = withLineCounts(
    parseNameStatus(expectOk('git show', names).stdout),
    parseNumstat(expectOk('git show', numbers).stdout),
  )
  return {
    oid: parsed.oid,
    subject: parsed.subject,
    body: parsed.body,
    authorName: parsed.authorName,
    authorEmail: parsed.authorEmail,
    authoredAt: parsed.time * 1000,
    files,
  }
}

/** The working tree's changed files against `HEAD`, at most 500. */
export async function readChanges(
  exec: Exec,
  cwd: string,
  unborn: boolean,
): Promise<ChangedFile[]> {
  const [status, numbers] = await Promise.all([
    git(exec, cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    unborn
      ? null
      : git(exec, cwd, ['diff', '--no-ext-diff', '-z', '-M', '--numstat', 'HEAD', '--']),
  ])
  const files = parsePorcelainFiles(expectOk('git status', status).stdout).slice(0, CHANGES_LIMIT)
  return numbers ? withLineCounts(files, parseNumstat(expectOk('git diff', numbers).stdout)) : files
}

/** Commits on `ref` that `HEAD` does not have, newest first. */
export async function readIncoming(exec: Exec, cwd: string, ref: string): Promise<LogCommit[]> {
  const result = await git(exec, cwd, [
    'log',
    '-n',
    String(LOG_LIMIT),
    '--no-show-signature',
    '--encoding=UTF-8',
    '--format=%H%x00%s%x00%at%x00%an',
    `HEAD..${ref}`,
    '--',
  ])
  return parseAuthoredLog(expectOk('git log', result).stdout).map((line) => ({
    oid: line.oid,
    subject: line.subject,
    authoredAt: line.time * 1000,
    pushed: true,
    authorName: line.author,
  }))
}

type Side = { text: string | null; binary: boolean; tooLarge: boolean }
const MISSING: Side = { text: null, binary: false, tooLarge: false }

function textSide(text: string, size: number): Side {
  if (size > DIFF_SIDE_LIMIT) return { text: null, binary: false, tooLarge: true }
  if (text.slice(0, BINARY_SNIFF).includes('\0'))
    return { text: null, binary: true, tooLarge: false }
  return { text, binary: false, tooLarge: false }
}

// A blob that does not exist at `rev`, such as a new file's parent side, is a missing side.
// `checkout` gives the blob as a checkout writes it, with its line endings converted, so it
// compares with the working tree; LFS objects stay pointers rather than being downloaded.
async function blobSide(
  exec: Exec,
  cwd: string,
  rev: string,
  path: string,
  checkout = false,
): Promise<Side> {
  const spec = `${rev}:${path}`
  const size = await git(exec, cwd, ['cat-file', '-s', spec])
  if (size.failure !== null) expectOk('git cat-file', size)
  if (size.code !== 0) return MISSING
  const bytes = Number(size.stdout.trim())
  if (bytes > DIFF_SIDE_LIMIT) return { text: null, binary: false, tooLarge: true }
  const blob = expectOk(
    'git cat-file',
    checkout
      ? await exec('git', ['cat-file', '--filters', spec], {
          cwd,
          timeoutMs: GIT_TIMEOUT_MS,
          env: { GIT_LFS_SKIP_SMUDGE: '1' },
        })
      : await git(exec, cwd, ['cat-file', 'blob', spec]),
  )
  return textSide(blob.stdout, bytes)
}

/** Resolves a repository-relative path inside `root`, or throws when it leaves it. */
export function insideRoot(root: string, path: string): string {
  if (isAbsolute(path) || path.includes('\0')) throw new Error(`Not a repository path: ${path}`)
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`Not a repository path: ${path}`)
  }
  return full
}

const PLATFORM = process.platform as Platform

function within(root: string, path: string): boolean {
  const rootKey = pathKey(root, PLATFORM)
  const key = pathKey(path, PLATFORM)
  return key === rootKey || key.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep)
}

// The working tree's side as git sees it: a symbolic link is its target, never followed, and
// the folders on the way must stay in the repository, as for project files.
async function diskSide(root: string, path: string): Promise<Side> {
  const full = insideRoot(root, path)
  let folder: string
  try {
    folder = await realpath(dirname(full))
  } catch {
    return MISSING
  }
  if (!within(await realpath(root), folder)) throw new Error(`Not a repository path: ${path}`)
  const file = join(folder, basename(full))
  let info
  try {
    info = await lstat(file)
  } catch {
    return MISSING
  }
  if (info.isSymbolicLink()) return { text: await readlink(file), binary: false, tooLarge: false }
  if (!info.isFile()) return MISSING
  if (info.size > DIFF_SIDE_LIMIT) return { text: null, binary: false, tooLarge: true }
  // Opened without following a link, in case one replaced the file since it was looked at.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const buffer = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0)
    return textSide(buffer.subarray(0, bytesRead).toString('utf8'), bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * The two sides of a file's change: `HEAD` against the working tree when `ref` is null, else
 * the commit against its first parent. `oldPath` names the file before a rename.
 */
export async function readFileDiff(
  exec: Exec,
  root: string,
  path: string,
  oldPath: string | null,
  ref: string | null,
  unborn: boolean,
): Promise<FileDiff> {
  insideRoot(root, path)
  if (oldPath !== null) insideRoot(root, oldPath)
  const before = oldPath ?? path
  const [oldSide, newSide] = await Promise.all([
    ref === null
      ? unborn
        ? MISSING
        : blobSide(exec, root, 'HEAD', before, true)
      : blobSide(exec, root, `${ref}^`, before),
    ref === null ? diskSide(root, path) : blobSide(exec, root, ref, path),
  ])
  return {
    path,
    oldText: oldSide.text,
    newText: newSide.text,
    binary: oldSide.binary || newSide.binary,
    tooLarge: oldSide.tooLarge || newSide.tooLarge,
  }
}
