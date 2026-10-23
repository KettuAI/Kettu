import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { GitServiceApi } from './api'
import { createTestService, pullRequestJson } from './service-test-support'
import { createSandbox, type Sandbox } from './test-support'

let s: Sandbox
let counter = 0
const services: GitServiceApi[] = []

beforeAll(async () => {
  s = await createSandbox()
})

afterEach(async () => {
  await Promise.all(services.splice(0).map((svc) => svc.dispose()))
})

afterAll(async () => {
  await s.dispose()
})

const name = (prefix: string): string => `${prefix}-${counter++}`

/** A clone of a local bare `origin`, on `main`, with one pushed commit. */
async function publishedRepo(): Promise<{ work: string; origin: string }> {
  const origin = await s.initBare(name('origin') + '.git')
  const work = await s.initRepo(name('work'))
  await s.commit(work, 'readme.md', 'chore: init')
  await s.git(work, 'remote', 'add', 'origin', origin)
  await s.git(work, 'push', '-u', 'origin', 'main')
  return { work, origin }
}

/** Another clone of `origin` that pushes one commit to `branch`. */
async function pushFromElsewhere(origin: string, branch: string): Promise<string> {
  const other = join(s.root, name('other'))
  await s.git(s.root, 'clone', '--branch', branch, origin, other)
  const oid = await s.commit(other, name('theirs') + '.txt', 'ci: theirs')
  await s.git(other, 'push', 'origin', branch)
  return oid
}

/** The push target the status names, as the interface sends it back. */
async function shownTarget(
  svc: GitServiceApi,
  work: string,
): Promise<{ remote: string; branch: string }> {
  const push = (await svc.status(work)).push
  if (push?.kind !== 'remote') throw new Error(`No push target: ${JSON.stringify(push)}`)
  return { remote: push.remote, branch: push.branch }
}

describe('push', () => {
  it('publishes a branch that has no upstream and tracks it', async () => {
    const { work, origin } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/login')
    const oid = await s.commit(work, 'login.ts', 'feat: add login')
    const { svc } = createTestService(s, services)
    const status = await svc.status(work)
    expect(status.upstream).toBeNull()
    expect(status.push).toMatchObject({ remote: 'origin', branch: 'feat/login', setUpstream: true })

    const after = await svc.push(work, await shownTarget(svc, work))
    expect(after.status.upstream).toEqual({ name: 'origin/feat/login', ahead: 0, behind: 0 })
    expect(after.log).toContain('refs/heads/feat/login')
    expect(await s.git(origin, 'rev-parse', 'feat/login')).toBe(oid)
  })

  it('pushes the branch by name, never HEAD', async () => {
    const { work } = await publishedRepo()
    await s.commit(work, 'n.txt', 'feat: n')
    const { svc, gitCalls } = createTestService(s, services)
    await svc.push(work, await shownTarget(svc, work))
    expect(gitCalls).toContainEqual([
      'push',
      '--porcelain',
      'origin',
      'refs/heads/main:refs/heads/main',
    ])
  })

  it('refuses an upstream of another name instead of pushing onto it', async () => {
    // `git switch -c fix origin/main` tracks origin/main: a plain push would land on main.
    const { work, origin } = await publishedRepo()
    const before = await s.git(origin, 'rev-parse', 'main')
    await s.git(work, 'switch', '-c', 'fix', 'origin/main')
    await s.commit(work, 'fix.txt', 'fix: it')
    const { svc } = createTestService(s, services)
    expect((await svc.status(work)).push).toEqual({ kind: 'otherName', upstream: 'origin/main' })
    await expect(svc.push(work, { remote: 'origin', branch: 'main' })).rejects.toThrow(
      /another name/,
    )
    expect(await s.git(origin, 'rev-parse', 'main')).toBe(before)
  })

  it('pushes to an upstream of another name when push.default says so', async () => {
    const { work, origin } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'local')
    await s.git(work, 'push', '-u', 'origin', 'local:shared-name')
    await s.git(work, 'config', 'push.default', 'upstream')
    const oid = await s.commit(work, 'b.txt', 'feat: b')
    const { svc } = createTestService(s, services)
    expect(await shownTarget(svc, work)).toEqual({ remote: 'origin', branch: 'shared-name' })

    const { status } = await svc.push(work, { remote: 'origin', branch: 'shared-name' })
    expect(status.upstream).toMatchObject({ name: 'origin/shared-name', ahead: 0 })
    expect(await s.git(origin, 'rev-parse', 'shared-name')).toBe(oid)
  })

  it('refuses when the target is no longer the one shown', async () => {
    const { work, origin } = await publishedRepo()
    await s.commit(work, 'c.txt', 'feat: c')
    const before = await s.git(origin, 'rev-parse', 'main')
    const { svc } = createTestService(s, services)
    await expect(svc.push(work, { remote: 'origin', branch: 'other' })).rejects.toThrow(
      /has changed to origin\/main/,
    )
    expect(await s.git(origin, 'rev-parse', 'main')).toBe(before)
  })

  it('pushes to the pushRemote, past an upstream that has moved on', async () => {
    const { work, origin } = await publishedRepo()
    const fork = await s.initBare(name('fork') + '.git')
    await s.git(work, 'remote', 'add', 'fork', fork)
    await s.git(work, 'config', 'branch.main.pushRemote', 'fork')
    await pushFromElsewhere(origin, 'main')
    const oid = await s.commit(work, 'mine.txt', 'feat: mine')
    const { svc } = createTestService(s, services)
    await svc.fetch(work)
    expect(await shownTarget(svc, work)).toEqual({ remote: 'fork', branch: 'main' })

    await svc.push(work, { remote: 'fork', branch: 'main' })
    expect(await s.git(fork, 'rev-parse', 'main')).toBe(oid)
  })

  it('never pushes a branch whose upstream is local', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'loc', '--track', 'main')
    await s.commit(work, 'loc.txt', 'feat: loc')
    const { svc } = createTestService(s, services)
    expect((await svc.status(work)).push).toEqual({ kind: 'localUpstream' })
    await expect(svc.push(work, { remote: '.', branch: 'main' })).rejects.toThrow(
      /branch of this repository/,
    )
  })

  it('refuses while the upstream has commits the branch does not', async () => {
    const { work, origin } = await publishedRepo()
    await pushFromElsewhere(origin, 'main')
    const { svc } = createTestService(s, services)
    await svc.fetch(work)
    const target = await shownTarget(svc, work)
    await expect(svc.push(work, target)).rejects.toThrow(/pull first/)

    await s.commit(work, 'mine.txt', 'feat: mine')
    await expect(svc.push(work, target)).rejects.toThrow(/diverged/)
  })

  it('fails with git output and leaves the commits unpushed', async () => {
    const { work } = await publishedRepo()
    await s.commit(work, 'c.txt', 'feat: c')
    await s.git(work, 'remote', 'set-url', 'origin', join(s.root, name('missing')))
    const { svc } = createTestService(s, services)
    await expect(svc.push(work, await shownTarget(svc, work))).rejects.toThrow(
      /does not appear to be a git repository|fatal/,
    )
    expect((await svc.status(work)).upstream?.ahead).toBe(1)
  })

  it('runs one operation at a time', async () => {
    const { work } = await publishedRepo()
    await s.commit(work, 'd.txt', 'feat: d')
    const { svc } = createTestService(s, services)
    const target = await shownTarget(svc, work)
    const first = svc.push(work, target)
    await expect(svc.push(work, target)).rejects.toMatchObject({ code: 'busy' })
    await expect(svc.pull(work)).rejects.toMatchObject({ code: 'busy' })
    await expect(
      svc.createPullRequest(work, { title: 'x', body: '', base: 'main', draft: false }),
    ).rejects.toMatchObject({ code: 'busy' })
    await first
    await expect(svc.push(work, target)).resolves.toBeDefined()
  })
})

describe('pull', () => {
  it('fast-forwards the branch', async () => {
    const { work, origin } = await publishedRepo()
    const theirs = await pushFromElsewhere(origin, 'main')
    const { svc } = createTestService(s, services)
    await svc.fetch(work)
    expect((await svc.status(work)).upstream?.behind).toBe(1)

    const { status } = await svc.pull(work)
    expect(status.upstream).toMatchObject({ ahead: 0, behind: 0 })
    expect(status.head.oid).toBe(theirs)
  })

  it('refuses a branch that has diverged', async () => {
    const { work, origin } = await publishedRepo()
    await pushFromElsewhere(origin, 'main')
    await s.commit(work, 'mine.txt', 'feat: mine')
    const { svc } = createTestService(s, services)
    await svc.fetch(work)
    await expect(svc.pull(work)).rejects.toThrow(/diverged/)
  })

  it('refuses a branch without an upstream', async () => {
    const work = await s.initRepo(name('lonely'))
    await s.commit(work, 'a.txt', 'chore: a')
    const { svc } = createTestService(s, services)
    await expect(svc.pull(work)).rejects.toThrow(/not published/)
  })
})

describe('publish', () => {
  it('creates the repository with gh and pushes to it', async () => {
    const work = await s.initRepo(name('fresh'))
    await s.commit(work, 'a.txt', 'chore: a')
    const { svc, gh } = createTestService(s, services)
    const origin = await s.initBare(name('created') + '.git')
    gh.onRepoCreate = async (root) => {
      await s.git(root, 'remote', 'add', 'origin', origin)
      await s.git(root, 'push', '--set-upstream', 'origin', 'HEAD')
    }

    const { status } = await svc.publish(work, 'fresh-app', 'private')
    expect(status.remote?.name).toBe('origin')
    expect(status.upstream).toMatchObject({ name: 'origin/main', ahead: 0 })
    expect(gh.calls).toContainEqual([
      'repo',
      'create',
      'fresh-app',
      '--private',
      `--source=${work}`,
      '--remote=origin',
      '--push',
    ])
  })

  it('refuses without gh, or when any remote exists', async () => {
    const { work } = await publishedRepo()
    const { svc, gh } = createTestService(s, services)
    await expect(svc.publish(work, 'app', 'public')).rejects.toThrow(/already has a remote/)

    // A remote that is not called origin still counts.
    const renamed = await s.initRepo(name('renamed'))
    await s.commit(renamed, 'a.txt', 'chore: a')
    await s.git(renamed, 'remote', 'add', 'github', 'https://github.com/acme/app.git')
    await s.git(renamed, 'remote', 'add', 'upstream', 'https://github.com/other/app.git')
    expect((await svc.status(renamed)).push).toEqual({ kind: 'unknownRemote' })
    await expect(svc.publish(renamed, 'app', 'public')).rejects.toThrow(/already has a remote/)

    const fresh = await s.initRepo(name('nogh'))
    await s.commit(fresh, 'a.txt', 'chore: a')
    gh.installed = false
    await svc.reloadTools()
    await expect(svc.publish(fresh, 'app', 'public')).rejects.toThrow(/not installed/)
    expect(gh.calls.some((call) => call[0] === 'repo')).toBe(false)
  })
})

describe('createPullRequest', () => {
  it('opens the pull request for the upstream branch and returns it', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/twelve')
    await s.commit(work, 'twelve.txt', 'feat: twelve')
    await s.git(work, 'push', '-u', 'origin', 'feat/twelve')
    await s.git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git')
    const { svc, gh } = createTestService(s, services)
    gh.created = pullRequestJson() as { url: string }

    const pr = await svc.createPullRequest(work, {
      title: '-feat: twelve',
      body: '',
      base: 'main',
      draft: true,
    })
    expect(pr).toMatchObject({ number: 12, url: 'https://github.com/acme/app/pull/12' })
    expect(gh.calls).toContainEqual([
      'pr',
      'create',
      '--repo=acme/app',
      '--head=feat/twelve',
      '--base=main',
      '--title=-feat: twelve',
      '--body=',
      '--draft',
    ])
  })

  it('names the fork as owner:branch when the branch is pushed there', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'remote', 'add', 'fork', 'git@github.com:me/app.git')
    await s.git(work, 'config', 'remote.pushDefault', 'fork')
    await s.git(work, 'switch', '-c', 'feat/fork', 'origin/main')
    await s.git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git')
    const { svc, gh } = createTestService(s, services)
    gh.created = pullRequestJson() as { url: string }

    await svc.createPullRequest(work, { title: 'Fork', body: '', base: 'main', draft: false })
    expect(gh.pullRequestCalls().find((call) => call[1] === 'create')).toEqual(
      expect.arrayContaining(['--repo=acme/app', '--head=me:feat/fork', '--base=main']),
    )
  })

  it('refuses a branch that is its own base, or not pushed yet', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git')
    const { svc, gh } = createTestService(s, services)
    gh.created = pullRequestJson() as { url: string }
    const draft = { title: 'x', body: '', base: 'main', draft: false }
    await expect(svc.createPullRequest(work, draft)).rejects.toThrow(/same branch/)

    await s.git(work, 'switch', '-c', 'feat/local')
    await expect(svc.createPullRequest(work, draft)).rejects.toThrow(/GitHub remote first/)
    expect(gh.pullRequestCalls().some((call) => call[1] === 'create')).toBe(false)
  })

  it('returns what it knows when gh cannot show the new pull request yet', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/twelve')
    await s.git(work, 'push', '-u', 'origin', 'feat/twelve')
    await s.git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git')
    const { svc, gh } = createTestService(s, services)
    gh.created = pullRequestJson() as { url: string }
    gh.createdUnseen = true

    const pr = await svc.createPullRequest(work, {
      title: 'Twelve',
      body: '',
      base: 'main',
      draft: true,
    })
    expect(pr).toMatchObject({
      url: 'https://github.com/acme/app/pull/12',
      owner: 'acme',
      repo: 'app',
      number: 12,
      title: 'Twelve',
      state: 'draft',
      head: 'feat/twelve',
      base: 'main',
    })
  })

  it('fails with gh output', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/empty')
    await s.git(work, 'push', '-u', 'origin', 'feat/empty')
    await s.git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git')
    const { svc } = createTestService(s, services)
    await expect(
      svc.createPullRequest(work, { title: 'x', body: 'y', base: 'main', draft: false }),
    ).rejects.toThrow(/No commits between/)
  })
})

describe('details', () => {
  it('reads a commit with its message, author and files', async () => {
    const work = await s.initRepo(name('details'))
    await s.commit(work, 'old name.txt', 'chore: init', 'one\ntwo\nthree\nfour\n')
    await s.git(work, 'mv', 'old name.txt', 'new name.txt')
    await s.write(work, 'image.bin', 'a\0b')
    await s.write(work, 'src/a.ts', 'export const a = 1\n')
    await s.git(work, 'add', '-A')
    await s.git(work, 'commit', '-m', 'feat: move\n\nWhy it moved.\nAnd more.')
    const oid = await s.git(work, 'rev-parse', 'HEAD')
    const { svc } = createTestService(s, services)

    const details = await svc.commit(work, oid.slice(0, 7))
    expect(details).toMatchObject({
      oid,
      subject: 'feat: move',
      body: 'Why it moved.\nAnd more.',
      authorName: 'Test Author',
      authorEmail: 'author@example.com',
    })
    expect(details.files).toEqual(
      expect.arrayContaining([
        {
          path: 'new name.txt',
          oldPath: 'old name.txt',
          status: 'renamed',
          insertions: 0,
          deletions: 0,
        },
        { path: 'image.bin', oldPath: null, status: 'added', insertions: null, deletions: null },
        { path: 'src/a.ts', oldPath: null, status: 'added', insertions: 1, deletions: 0 },
      ]),
    )
  })

  it('lists the working tree changes with their line counts', async () => {
    const work = await s.initRepo(name('changes'))
    await s.commit(work, 'a.txt', 'chore: a', 'a\n')
    await s.commit(work, 'gone.txt', 'chore: gone', 'g\n')
    await s.write(work, 'a.txt', 'a\nb\nc\n')
    await s.git(work, 'rm', '-q', 'gone.txt')
    await s.write(work, 'new dir/n.txt', 'n\n')
    const { svc } = createTestService(s, services)

    expect(await svc.changes(work)).toEqual([
      { path: 'a.txt', oldPath: null, status: 'modified', insertions: 2, deletions: 0 },
      { path: 'gone.txt', oldPath: null, status: 'deleted', insertions: 0, deletions: 1 },
      {
        path: 'new dir/n.txt',
        oldPath: null,
        status: 'untracked',
        insertions: null,
        deletions: null,
      },
    ])
  })

  it('lists the commits to pull and the base commits since the branch started', async () => {
    const { work, origin } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/x')
    await s.git(work, 'push', '-u', 'origin', 'feat/x')
    const onBranch = await pushFromElsewhere(origin, 'feat/x')
    const onMain = await pushFromElsewhere(origin, 'main')
    const { svc } = createTestService(s, services)
    await svc.fetch(work)

    expect((await svc.incoming(work, 'upstream')).map((c) => c.oid)).toEqual([onBranch])
    const base = await svc.incoming(work, 'base')
    expect(base).toEqual([
      expect.objectContaining({ oid: onMain, subject: 'ci: theirs', authorName: 'Test Author' }),
    ])
  })

  it('gives both sides of a change in the working tree and in a commit', async () => {
    const work = await s.initRepo(name('diff'))
    const first = await s.commit(work, 'a.txt', 'chore: a', 'one\n')
    const second = await s.commit(work, 'a.txt', 'chore: a again', 'one\ntwo\n')
    await s.write(work, 'a.txt', 'one\ntwo\nthree\n')
    await s.write(work, 'new.txt', 'new\n')
    const { svc } = createTestService(s, services)

    expect(await svc.fileDiff(work, 'a.txt', null, null)).toEqual({
      path: 'a.txt',
      oldText: 'one\ntwo\n',
      newText: 'one\ntwo\nthree\n',
      binary: false,
      tooLarge: false,
    })
    expect(await svc.fileDiff(work, 'new.txt', null, null)).toMatchObject({
      oldText: null,
      newText: 'new\n',
    })
    expect(await svc.fileDiff(work, 'a.txt', null, second)).toMatchObject({
      oldText: 'one\n',
      newText: 'one\ntwo\n',
    })
    // The root commit has no parent: the old side is missing.
    expect(await svc.fileDiff(work, 'a.txt', null, first)).toMatchObject({
      oldText: null,
      newText: 'one\n',
    })
  })

  it('flags binary files and never leaves the repository', async () => {
    const work = await s.initRepo(name('guard'))
    await s.commit(work, 'a.txt', 'chore: a')
    await writeFile(join(work, 'bin.dat'), Buffer.from([1, 0, 2]))
    const { svc } = createTestService(s, services)

    expect(await svc.fileDiff(work, 'bin.dat', null, null)).toMatchObject({
      binary: true,
      newText: null,
    })
    await expect(svc.fileDiff(work, '../outside.txt', null, null)).rejects.toThrow(
      /Not a repository path/,
    )
  })

  it.skipIf(process.platform === 'win32')(
    'never follows a folder link out of the repository',
    async () => {
      // A cloned repository can commit `docs -> /Users/me`; its files are not the repository's.
      const outside = join(s.root, name('home'))
      await s.write(outside, '.ssh/id_rsa', 'PRIVATE KEY\n')
      const work = await s.initRepo(name('escape'))
      await symlink(outside, join(work, 'docs'))
      await s.git(work, 'add', 'docs')
      await s.git(work, 'commit', '-m', 'docs: link')
      const { svc } = createTestService(s, services)
      await expect(svc.fileDiff(work, 'docs/.ssh/id_rsa', null, null)).rejects.toThrow(
        /Not a repository path/,
      )
      // A link inside the repository is still read.
      await s.write(work, 'real/a.txt', 'inside\n')
      await symlink(join(work, 'real'), join(work, 'alias'))
      expect(await svc.fileDiff(work, 'alias/a.txt', null, null)).toMatchObject({
        newText: 'inside\n',
      })
    },
  )

  it('compares the working tree with HEAD as checked out, line endings converted', async () => {
    const work = await s.initRepo(name('crlf'))
    await s.git(work, 'config', 'core.autocrlf', 'true')
    await s.commit(work, 'a.txt', 'chore: a', 'one\ntwo\n')
    await s.write(work, 'a.txt', 'one\r\ntwo\r\nthree\r\n')
    const { svc } = createTestService(s, services)
    expect(await svc.fileDiff(work, 'a.txt', null, null)).toMatchObject({
      oldText: 'one\r\ntwo\r\n',
      newText: 'one\r\ntwo\r\nthree\r\n',
    })
  })

  it.skipIf(process.platform === 'win32')('shows a symbolic link as its target', async () => {
    const work = await s.initRepo(name('link'))
    await s.commit(work, 'a.txt', 'chore: a')
    await symlink('/etc/hosts', join(work, 'hosts'))
    const { svc } = createTestService(s, services)
    expect(await svc.fileDiff(work, 'hosts', null, null)).toMatchObject({ newText: '/etc/hosts' })
  })
})
