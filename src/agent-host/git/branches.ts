// The local branches and the remotes, as the branch switcher lists them.

import { realpath } from 'node:fs/promises'
import type { BranchInfo, GitRemote } from '@shared/git'
import type { Platform } from '@shared/platform'
import { canonicalizePath, samePath } from '../paths'
import { expectOk, GIT_TIMEOUT_MS, type Exec, type ExecResult } from './exec'
import { parseConfigEntries, parseGithubRemote } from './parse'

const PLATFORM = process.platform as Platform
const HEADS = 'refs/heads/'

function git(exec: Exec, cwd: string, args: string[]): Promise<ExecResult> {
  return exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS })
}

/** Every configured remote with the URL it fetches from, in the config's order. */
export async function readRemotes(exec: Exec, cwd: string): Promise<GitRemote[]> {
  const result = await git(exec, cwd, ['config', '-z', '--get-regexp', '^remote\\..+\\.url$'])
  // Exit code 1 means no entry matched.
  if (result.failure === null && result.code === 1) return []
  const remotes = new Map<string, GitRemote>()
  for (const [key, url] of parseConfigEntries(expectOk('git config', result).stdout)) {
    const name = /^remote\.(.+)\.url$/.exec(key)?.[1]
    // A remote with several URLs fetches from the first.
    if (name !== undefined && !remotes.has(name)) {
      remotes.set(name, { name, url, github: parseGithubRemote(url) })
    }
  }
  return [...remotes.values()]
}

async function canonical(path: string): Promise<string> {
  try {
    return await canonicalizePath(path, PLATFORM, realpath)
  } catch {
    // A worktree whose folder is gone still holds its branch.
    return path
  }
}

/**
 * The local branches, the most recently committed first, with an unborn current branch on top.
 * `root` is the repository root of the project, whose own checkout is not another worktree.
 */
export async function readBranches(exec: Exec, root: string): Promise<BranchInfo[]> {
  const [head, refs] = await Promise.all([
    git(exec, root, ['symbolic-ref', '--quiet', 'HEAD']),
    // Each record ends in NUL and newline: only the worktree's path, last, may hold a newline.
    git(exec, root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%00%(committerdate:unix)%00%(worktreepath)%00',
      HEADS,
    ]),
  ])
  // Exit code 1 means HEAD is detached.
  const headRef =
    head.failure === null && head.code === 1 ? '' : expectOk('git symbolic-ref', head).stdout.trim()
  const current = headRef.startsWith(HEADS) ? headRef.slice(HEADS.length) : null
  const here = await canonical(root)

  const branches = await Promise.all(
    expectOk('git for-each-ref', refs)
      .stdout.split('\0\n')
      .filter((record) => record.startsWith(HEADS))
      .map(async (record): Promise<BranchInfo> => {
        const [refname = '', time = '', path = ''] = record.split('\0')
        const name = refname.slice(HEADS.length)
        const seconds = time === '' ? Number.NaN : Number(time)
        const folder = path === '' ? null : await canonical(path)
        return {
          name,
          committedAt: Number.isFinite(seconds) ? seconds * 1000 : null,
          current: name === current,
          worktree: folder !== null && !samePath(folder, here, PLATFORM) ? folder : null,
        }
      }),
  )
  if (current !== null && !branches.some((branch) => branch.name === current)) {
    branches.unshift({ name: current, committedAt: null, current: true, worktree: null })
  }
  return branches
}
