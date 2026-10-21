// Helpers for tests that run real git in temporary repositories.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createExec, expectOk, type Exec, type ExecRunner } from './exec'

export interface Sandbox {
  root: string
  /** An environment with no user or system git config and a fixed identity. */
  env: NodeJS.ProcessEnv
  runner: ExecRunner
  exec: Exec
  /** Runs git and returns its trimmed output; throws when it fails. */
  git(cwd: string, ...args: string[]): Promise<string>
  /** Creates a repository whose first branch is `main`. */
  initRepo(name: string): Promise<string>
  /** Creates a bare repository, such as an `origin`. */
  initBare(name: string): Promise<string>
  /** Writes a file, commits it, and returns the new commit id. */
  commit(cwd: string, file: string, message: string, content?: string): Promise<string>
  write(cwd: string, file: string, content: string): Promise<void>
  dispose(): Promise<void>
}

export async function createSandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ob-git-')))
  const home = join(root, 'home')
  await mkdir(home)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: 'Test Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.com',
  }
  const runner = createExec(() => env)

  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    expectOk(
      `git ${args.join(' ')}`,
      await runner.exec('git', args, { cwd, timeoutMs: 20_000 }),
    ).stdout.trim()

  const write = async (cwd: string, file: string, content: string): Promise<void> => {
    const path = join(cwd, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }

  return {
    root,
    env,
    runner,
    exec: runner.exec,
    git,
    async initRepo(name) {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await git(dir, 'init', '-b', 'main')
      return dir
    },
    async initBare(name) {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await git(dir, 'init', '--bare', '-b', 'main')
      return dir
    },
    async commit(cwd, file, message, content) {
      await write(cwd, file, content ?? `${message}\n`)
      await git(cwd, 'add', '--', file)
      await git(cwd, 'commit', '-m', message)
      return git(cwd, 'rev-parse', 'HEAD')
    },
    write,
    async dispose() {
      runner.killAll()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}
