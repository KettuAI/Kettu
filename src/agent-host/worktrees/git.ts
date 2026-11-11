// The git and file system side of a session's worktree: creating it with its branch, inspecting
// what removing it would lose, and removing or recreating it. Nothing here fetches, removes
// changes the user was not shown, or changes the repository's config.

import { createHash, randomBytes } from 'node:crypto'
import { access, constants, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { HostError, invalidParams, notFound } from '../errors'
import { describeFailure, GIT_TIMEOUT_MS, type Exec, type ExecResult } from '../git/exec'
import { canonicalizePath, folderName, pathKey, samePath } from '../paths'
import { processControl, type ProcessControl } from '../process-tree'
import type { WorktreeRecord } from '../storage'
import type { WorktreeGit, WorktreeInspection, WorktreeRequest } from './api'
import { copyLocalFiles } from './copy'
import { branchFromTemplate, checkWorktreeBranch, folderNameFor, insideRoot, slugOf } from './names'
import { runSetup } from './setup'

/** Checking out a large repository takes a while. */
export const WORKTREE_ADD_TIMEOUT_MS = 300_000
export const WORKTREE_REMOVE_TIMEOUT_MS = 120_000
const MAX_SUFFIX = 100

export interface WorktreeGitDeps {
  exec: Exec
  platform: Platform
  homeDir: string
  control?: ProcessControl
  now?: () => number
  /** Hex for a branch without a usable slug. */
  random?: () => string
}

function gitError(label: string, result: ExecResult): HostError {
  return new HostError('git_error', `${label}: ${describeFailure(result)}`)
}

function ok(result: ExecResult): boolean {
  return result.failure === null && result.code === 0
}

export function createWorktreeGit(deps: WorktreeGitDeps): WorktreeGit {
  const { exec, platform, homeDir } = deps
  const p = platform === 'win32' ? path.win32 : path.posix
  const control = deps.control ?? processControl(platform)
  const now = deps.now ?? Date.now
  const random = deps.random ?? (() => randomBytes(3).toString('hex'))
  // Paths in a worktree of a deep project easily pass MAX_PATH on Windows.
  const longPaths = platform === 'win32' ? ['-c', 'core.longpaths=true'] : []

  const git = (cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult> =>
    exec('git', args, { cwd, timeoutMs })

  const canonical = (value: string): Promise<string> => canonicalizePath(value, platform, realpath)

  async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
    if (rev === '' || rev.includes('\0')) return null
    const result = await git(cwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${rev}^{commit}`,
    ])
    if (result.failure === null && result.code === 1) return null
    if (!ok(result)) throw gitError('git rev-parse', result)
    return result.stdout.trim() || null
  }

  async function branchHead(cwd: string, branch: string): Promise<string | null> {
    return resolveCommit(cwd, `refs/heads/${branch}`)
  }

  /** Branch names on any local or remote ref, folded on case-insensitive file systems. */
  async function takenNames(cwd: string): Promise<{ local: Set<string>; remote: string[] }> {
    const result = await git(cwd, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/',
      'refs/remotes/',
    ])
    if (!ok(result)) throw gitError('git for-each-ref', result)
    const local = new Set<string>()
    const remote: string[] = []
    for (const ref of result.stdout.split('\n')) {
      if (ref.startsWith('refs/heads/')) local.add(fold(ref.slice('refs/heads/'.length)))
      else if (ref.startsWith('refs/remotes/')) remote.push(fold(ref.slice('refs/remotes/'.length)))
    }
    return { local, remote }
  }

  // A ref whose name differs only in case is the same loose ref file on macOS and Windows.
  function fold(name: string): string {
    return platform === 'darwin' || platform === 'win32' ? name.toLowerCase() : name
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await lstat(target)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return false
      throw error
    }
  }

  async function isDirectory(target: string): Promise<boolean> {
    try {
      return (await stat(target)).isDirectory()
    } catch {
      return false
    }
  }

  interface ListedWorktree {
    path: string
    branch: string | null
  }

  async function listWorktrees(projectPath: string): Promise<ListedWorktree[]> {
    const result = await git(projectPath, ['worktree', 'list', '--porcelain', '-z'])
    if (!ok(result)) throw gitError('git worktree list', result)
    const listed: ListedWorktree[] = []
    let current: ListedWorktree | null = null
    for (const field of result.stdout.split('\0')) {
      if (field.startsWith('worktree ')) {
        current = { path: field.slice('worktree '.length), branch: null }
        listed.push(current)
      } else if (current && field.startsWith('branch refs/heads/')) {
        current.branch = field.slice('branch refs/heads/'.length)
      }
    }
    return Promise.all(
      listed.map(async (entry) => ({
        ...entry,
        path: await canonical(entry.path).catch(() => entry.path),
      })),
    )
  }

  async function rootFor(projectPath: string, root: string | null): Promise<string> {
    if (root !== null) {
      await mkdir(root, { recursive: true })
      return canonical(root)
    }
    const name = folderName(projectPath, platform)
    const beside = p.join(p.dirname(projectPath), `${name}-worktrees`)
    try {
      await mkdir(beside, { recursive: true })
      await access(beside, constants.W_OK)
      return await canonical(beside)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw error
    }
    const hash = createHash('sha256')
      .update(pathKey(projectPath, platform))
      .digest('hex')
      .slice(0, 8)
    const fallback = p.join(homeDir, '.kettu', 'worktrees', `${name}-${hash}`)
    await mkdir(fallback, { recursive: true })
    return canonical(fallback)
  }

  async function create(request: WorktreeRequest): Promise<WorktreeRecord> {
    const project = request.projectPath
    const baseOid = await resolveCommit(project, request.base)
    if (baseOid === null) throw invalidParams(`Base ${JSON.stringify(request.base)} not found`)

    let wanted: string
    if (request.branch !== undefined && request.branch.trim() !== '') {
      wanted = checkWorktreeBranch(request.branch.trim())
    } else {
      const slug = slugFor(request.text)
      wanted = checkWorktreeBranch(
        branchFromTemplate(request.template, { slug, type: request.type, issue: request.issue }),
      )
    }

    const root = await rootFor(project, request.root)
    const taken = await takenNames(project)
    const isTaken = (name: string): boolean => {
      const key = fold(name)
      return (
        taken.local.has(key) ||
        taken.remote.some((ref) => ref.endsWith(`/${key}`)) ||
        (request.takenByPullRequest?.(name) ?? false)
      )
    }

    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const branch = n === 1 ? wanted : `${wanted}-${n}`
      // The suffix may push the name past the limit.
      checkWorktreeBranch(branch)
      if (isTaken(branch)) continue
      const folder = p.join(root, folderNameFor(branch, platform))
      if (!insideRoot(root, folder, platform))
        throw invalidParams('Worktree folder outside its root')
      if (await exists(folder)) continue
      const result = await git(
        project,
        [...longPaths, 'worktree', 'add', '-b', branch, '--', folder, baseOid],
        WORKTREE_ADD_TIMEOUT_MS,
      )
      if (!ok(result)) throw gitError('git worktree add', result)
      return { path: await canonical(folder), branch, base: request.base, baseOid }
    }
    throw new HostError('conflict', `Every name from ${wanted} to ${wanted}-${MAX_SUFFIX} is taken`)

    function slugFor(text: string): string {
      return slugOf(text) || `session-${random().slice(0, 6)}`
    }
  }

  async function countEntries(worktree: string): Promise<number> {
    const result = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!ok(result)) throw gitError('git status', result)
    const fields = result.stdout.split('\0')
    let count = 0
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!
      if (field === '') continue
      count++
      // A rename or copy is followed by the path it came from.
      if (field[0] === 'R' || field[0] === 'C') i++
    }
    return count
  }

  async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
    const result = await git(cwd, ['merge-base', '--is-ancestor', a, b])
    if (result.failure === null && result.code === 1) return false
    if (!ok(result)) throw gitError('git merge-base', result)
    return true
  }

  /** Merging `head` into `target` changes nothing, as after a squash merge. */
  async function mergesToNothing(cwd: string, target: string, head: string): Promise<boolean> {
    // Needs git 2.38; an older git, or a conflict, counts as not merged.
    const merged = await git(cwd, ['merge-tree', '--write-tree', target, head])
    if (!ok(merged)) return false
    const tree = await git(cwd, ['rev-parse', '--verify', '--quiet', `${target}^{tree}`])
    if (!ok(tree)) return false
    return merged.stdout.split('\n')[0]!.trim() === tree.stdout.trim()
  }

  async function mergeTargets(projectPath: string, record: WorktreeRecord): Promise<string[]> {
    const targets = await Promise.all([
      resolveCommit(projectPath, record.base),
      resolveCommit(projectPath, `${record.base}@{upstream}`),
      resolveCommit(projectPath, 'refs/remotes/origin/HEAD'),
    ])
    return [...new Set(targets.filter((oid): oid is string => oid !== null))]
  }

  async function inspect(projectPath: string, record: WorktreeRecord): Promise<WorktreeInspection> {
    const folderThere = await isDirectory(record.path)
    const listed = folderThere ? await listWorktrees(projectPath) : []
    const there = listed.some((entry) => samePath(entry.path, record.path, platform))
    const head = await branchHead(projectPath, record.branch)
    const uncommitted = there ? await countEntries(record.path) : 0
    if (head === null) {
      return { exists: there, branchExists: false, head, uncommitted, unpushed: 0, merged: false }
    }
    const targets = await mergeTargets(projectPath, record)
    // Commits the base already has locally are not lost with the branch either.
    const known = [...new Set([record.baseOid, ...targets])]
    const count = await git(projectPath, [
      'rev-list',
      '--count',
      head,
      '--not',
      '--remotes',
      ...known,
    ])
    if (!ok(count)) throw gitError('git rev-list', count)
    const unpushed = Number(count.stdout.trim()) || 0

    let merged = await isAncestor(projectPath, head, record.baseOid)
    for (const target of targets) {
      if (merged) break
      merged =
        (await isAncestor(projectPath, head, target)) ||
        (await mergesToNothing(projectPath, target, head))
    }
    return { exists: there, branchExists: true, head, uncommitted, unpushed, merged }
  }

  async function remove(
    projectPath: string,
    record: WorktreeRecord,
    options: { branch: 'keep' | 'delete'; expected: WorktreeInspection },
  ): Promise<{ branchDeleted: boolean }> {
    const { expected } = options
    const state = await inspect(projectPath, record)
    if (
      state.exists !== expected.exists ||
      state.head !== expected.head ||
      state.uncommitted !== expected.uncommitted ||
      state.unpushed !== expected.unpushed
    ) {
      throw new HostError('conflict', 'The worktree changed since it was inspected')
    }

    if (state.exists) {
      const listed = await listWorktrees(projectPath)
      const own = listed.slice(1).some((entry) => samePath(entry.path, record.path, platform))
      if (!own || samePath(record.path, projectPath, platform)) {
        throw new HostError('conflict', 'The folder is not a worktree of this project')
      }
      // Changed files go only when the user was shown them and they are still what was shown; a
      // single --force still leaves a locked worktree alone.
      const force = state.uncommitted > 0 ? ['--force'] : []
      const result = await git(
        projectPath,
        [...longPaths, 'worktree', 'remove', ...force, '--', record.path],
        WORKTREE_REMOVE_TIMEOUT_MS,
      )
      if (!ok(result)) throw gitError('git worktree remove', result)
    } else {
      await prune(projectPath)
    }

    if (options.branch === 'keep') return { branchDeleted: false }
    if (state.head === null) return { branchDeleted: true }
    const deleted = await git(projectPath, ['branch', '-d', '--', record.branch])
    if (ok(deleted)) return { branchDeleted: true }
    if (!expected.merged) return { branchDeleted: false }
    // Another worktree still has it checked out.
    const listed = await listWorktrees(projectPath)
    if (listed.some((entry) => entry.branch === record.branch)) return { branchDeleted: false }
    // Squash-merged: git cannot see it, so delete only if it still points where it did.
    const ref = await git(projectPath, [
      'update-ref',
      '-d',
      `refs/heads/${record.branch}`,
      state.head,
    ])
    if (!ok(ref))
      throw new HostError('conflict', `Could not delete ${record.branch}: ${describeFailure(ref)}`)
    return { branchDeleted: true }
  }

  async function recreate(projectPath: string, record: WorktreeRecord): Promise<void> {
    checkWorktreeBranch(record.branch)
    await prune(projectPath)
    if ((await branchHead(projectPath, record.branch)) === null) {
      throw notFound(`Branch ${record.branch} no longer exists`)
    }
    const result = await git(
      projectPath,
      [...longPaths, 'worktree', 'add', '--', record.path, record.branch],
      WORKTREE_ADD_TIMEOUT_MS,
    )
    if (!ok(result)) throw gitError('git worktree add', result)
  }

  async function prune(projectPath: string): Promise<void> {
    const result = await git(projectPath, ['worktree', 'prune'])
    if (!ok(result)) throw gitError('git worktree prune', result)
  }

  return {
    rootFor,
    create,
    copyLocalFiles: (projectPath, worktreePath, extra) =>
      copyLocalFiles(exec, platform, projectPath, worktreePath, extra),
    runSetup: (command, options) => runSetup(command, options, { platform, control, now }),
    inspect,
    remove,
    recreate,
    prune,
  }
}
