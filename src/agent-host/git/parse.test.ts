import { describe, expect, it } from 'vitest'
import {
  isNoPullRequestMessage,
  parseConfigEntries,
  parseGhAccount,
  parseGhVersion,
  parseGitVersion,
  parseGithubRemote,
  parseLeftRightCount,
  parseAuthoredLog,
  parseCommitHeader,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseOidLines,
  parsePorcelainFiles,
  parsePorcelainStatus,
  parseShortstat,
  pickRemote,
  resolvePushTarget,
  withLineCounts,
} from './parse'

const OID = '3f2a1c1d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49'

function z(...records: string[]): string {
  return records.map((record) => `${record}\0`).join('')
}

describe('parsePorcelainStatus', () => {
  it('reads the branch headers', () => {
    const status = parsePorcelainStatus(
      z(
        `# branch.oid ${OID}`,
        '# branch.head feature/login',
        '# branch.upstream origin/feature/login',
        '# branch.ab +2 -5',
      ),
    )
    expect(status).toMatchObject({
      oid: OID,
      branch: 'feature/login',
      detached: false,
      upstream: 'origin/feature/login',
      ahead: 2,
      behind: 5,
    })
  })

  it('has no counts for a branch without an upstream', () => {
    const status = parsePorcelainStatus(z(`# branch.oid ${OID}`, '# branch.head main'))
    expect(status).toMatchObject({ upstream: null, ahead: null, behind: 0 })
  })

  it('keeps the upstream but has no counts when the upstream branch is gone', () => {
    const status = parsePorcelainStatus(
      z(`# branch.oid ${OID}`, '# branch.head main', '# branch.upstream origin/main'),
    )
    expect(status).toMatchObject({ upstream: 'origin/main', ahead: null })
  })

  it('reads a detached head', () => {
    const status = parsePorcelainStatus(z(`# branch.oid ${OID}`, '# branch.head (detached)'))
    expect(status).toMatchObject({ oid: OID, branch: null, detached: true })
  })

  it('reads an unborn branch', () => {
    const status = parsePorcelainStatus(z('# branch.oid (initial)', '# branch.head main'))
    expect(status).toMatchObject({ oid: null, branch: 'main', detached: false })
  })

  it('counts staged, unstaged, untracked and conflicted entries', () => {
    const status = parsePorcelainStatus(
      z(
        `# branch.oid ${OID}`,
        '# branch.head main',
        `1 M. N... 100644 100644 100644 ${OID} ${OID} staged.ts`,
        `1 .M N... 100644 100644 100644 ${OID} ${OID} unstaged.ts`,
        `1 MM N... 100644 100644 100644 ${OID} ${OID} both.ts`,
        `1 A. N... 000000 100644 100644 ${OID} ${OID} path with spaces.ts`,
        `u UU N... 100644 100644 100644 100644 ${OID} ${OID} ${OID} conflict.ts`,
        `u AA N... 000000 100644 100644 100644 ${OID} ${OID} ${OID} conflict2.ts`,
        '? new.ts',
        '? dir/',
        '! ignored.log',
      ),
    )
    expect(status).toMatchObject({ staged: 3, unstaged: 2, untracked: 2, conflicted: 2 })
  })

  it('consumes the original path of a rename so it is not read as an entry', () => {
    const status = parsePorcelainStatus(
      z(
        `# branch.oid ${OID}`,
        '# branch.head main',
        `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 new name.ts`,
        '? old name.ts',
        `2 RM N... 100644 100644 100644 ${OID} ${OID} R90 b.ts`,
        '1 other',
        '? real-untracked.ts',
      ),
    )
    expect(status).toMatchObject({ staged: 2, unstaged: 1, untracked: 1, conflicted: 0 })
  })

  it('returns zeros for empty output', () => {
    expect(parsePorcelainStatus('')).toMatchObject({
      oid: null,
      branch: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    })
  })
})

describe('parseShortstat', () => {
  it.each([
    [' 3 files changed, 10 insertions(+), 2 deletions(-)\n', 10, 2],
    [' 1 file changed, 1 insertion(+)\n', 1, 0],
    [' 1 file changed, 1 deletion(-)\n', 0, 1],
    [' 1 file changed, 1 insertion(+), 1 deletion(-)\n', 1, 1],
    [' 2 files changed, 120 insertions(+)\n', 120, 0],
    [' 1 file changed, 0 insertions(+), 0 deletions(-)\n', 0, 0],
    ['', 0, 0],
    ['\n', 0, 0],
  ])('reads %j', (output, insertions, deletions) => {
    expect(parseShortstat(output)).toEqual({ insertions, deletions })
  })
})

describe('parseLeftRightCount', () => {
  it('reads two counts', () => {
    expect(parseLeftRightCount('3\t12\n')).toEqual({ left: 3, right: 12 })
    expect(parseLeftRightCount('0\t0\n')).toEqual({ left: 0, right: 0 })
  })

  it('rejects anything else', () => {
    expect(() => parseLeftRightCount('')).toThrow()
    expect(() => parseLeftRightCount('fatal: bad revision')).toThrow()
  })
})

describe('parseLog', () => {
  it('reads oid, subject and time per line', () => {
    const lines = parseLog(
      `${OID}\0fix(auth): read the clock once\x001700000000\n${OID.replace('3', '4')}\0second\0 1700000100\n`,
    )
    expect(lines).toEqual([
      { oid: OID, subject: 'fix(auth): read the clock once', time: 1_700_000_000 },
      { oid: OID.replace('3', '4'), subject: 'second', time: 1_700_000_100 },
    ])
  })

  it('keeps a subject with spaces and drops a carriage return', () => {
    expect(parseLog(`${OID}\0a  b\r\x0010\n`)[0]?.subject).toBe('a  b')
  })

  it('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([])
  })
})

describe('parseOidLines', () => {
  it('keeps only object ids', () => {
    expect(parseOidLines(`${OID}\nwarning: x\n\n`)).toEqual([OID])
  })
})

describe('config and remotes', () => {
  const output = [
    'remote.origin.url\nhttps://github.com/acme/app.git',
    'remote.upstream.url\ngit@github.com:other/app.git',
    'remote.gitlab.url\nhttps://gitlab.com/acme/app.git',
    'branch.main.remote\norigin',
    'branch.fix/login.remote\nupstream',
    'branch.local.remote\n.',
  ]
    .map((record) => `${record}\0`)
    .join('')

  it('parses key and value records', () => {
    const entries = parseConfigEntries(output)
    expect(entries).toContainEqual(['remote.origin.url', 'https://github.com/acme/app.git'])
    expect(entries).toContainEqual(['branch.fix/login.remote', 'upstream'])
    expect(parseConfigEntries('')).toEqual([])
  })

  it('prefers the remote of the branch', () => {
    const entries = parseConfigEntries(output)
    expect(pickRemote(entries, 'fix/login')).toEqual({
      name: 'upstream',
      url: 'git@github.com:other/app.git',
    })
  })

  it('falls back to origin without a branch remote, for detached heads and local upstreams', () => {
    const entries = parseConfigEntries(output)
    const origin = { name: 'origin', url: 'https://github.com/acme/app.git' }
    expect(pickRemote(entries, 'unknown')).toEqual(origin)
    expect(pickRemote(entries, null)).toEqual(origin)
    expect(pickRemote(entries, 'local')).toEqual(origin)
  })

  it('has no remote when the named and default remotes are missing', () => {
    expect(pickRemote([['branch.main.remote', 'gone']], 'main')).toBeNull()
    expect(pickRemote([], 'main')).toBeNull()
  })

  it('uses a remote not called origin when it is the branch remote or the only one', () => {
    const entries: [string, string][] = [
      ['remote.fork.url', 'https://github.com/me/app'],
      ['branch.main.remote', 'fork'],
    ]
    expect(pickRemote(entries, 'main')).toEqual({ name: 'fork', url: 'https://github.com/me/app' })
    expect(pickRemote(entries, 'other')).toEqual({ name: 'fork', url: 'https://github.com/me/app' })
    const two: [string, string][] = [...entries, ['remote.upstream.url', 'https://github.com/a/b']]
    expect(pickRemote(two, 'other')).toBeNull()
  })
})

describe('parseGithubRemote', () => {
  it.each([
    ['https://github.com/acme/app.git', 'acme', 'app'],
    ['https://github.com/acme/app', 'acme', 'app'],
    ['https://github.com/acme/app/', 'acme', 'app'],
    ['http://github.com/acme/app.git', 'acme', 'app'],
    ['https://user:token@github.com/acme/app.git', 'acme', 'app'],
    ['https://www.github.com/acme/app.git', 'acme', 'app'],
    ['HTTPS://GitHub.com/acme/app.git', 'acme', 'app'],
    ['git@github.com:acme/app.git', 'acme', 'app'],
    ['git@github.com:acme/app', 'acme', 'app'],
    ['github.com:acme/app.git', 'acme', 'app'],
    ['ssh://git@github.com/acme/app.git', 'acme', 'app'],
    ['ssh://git@github.com/acme/app', 'acme', 'app'],
    ['ssh://git@github.com:22/acme/app.git', 'acme', 'app'],
    ['ssh://git@ssh.github.com:443/acme/app.git', 'acme', 'app'],
    ['git://github.com/acme/app.git', 'acme', 'app'],
    ['https://github.com/acme/app.js.git', 'acme', 'app.js'],
    ['https://github.com/a-b_c/d.e-f', 'a-b_c', 'd.e-f'],
  ])('reads %s', (url, owner, repo) => {
    expect(parseGithubRemote(url)).toEqual({ owner, repo })
  })

  it.each([
    'https://gitlab.com/acme/app.git',
    'git@gitlab.com:acme/app.git',
    'https://github.example.com/acme/app.git',
    'https://github.com.evil.test/acme/app.git',
    'https://notgithub.com/acme/app.git',
    'https://github.com/acme',
    'https://github.com/acme/app/pull/3',
    '/Users/me/projects/app.git',
    'C:\\projects\\app.git',
    '../origin.git',
    '',
  ])('gives null for %j', (url) => {
    expect(parseGithubRemote(url)).toBeNull()
  })
})

describe('versions', () => {
  it('reads git versions', () => {
    expect(parseGitVersion('git version 2.51.2\n')).toBe('2.51.2')
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)\n')).toBe('2.39.5')
    expect(parseGitVersion('git version 2.43.0.windows.1\r\n')).toBe('2.43.0.windows.1')
    expect(parseGitVersion('something else')).toBeNull()
  })

  it('reads gh versions', () => {
    expect(
      parseGhVersion(
        'gh version 2.98.0 (2026-08-20)\nhttps://github.com/cli/cli/releases/tag/v2.98.0',
      ),
    ).toBe('2.98.0')
    expect(parseGhVersion('')).toBeNull()
  })
})

describe('parseGhAccount', () => {
  it('reads the account from current output', () => {
    const output = [
      'github.com',
      '  \u2713 Logged in to github.com account octocat (keyring)',
      '  - Active account: true',
      '  - Git operations protocol: https',
      '  - Token: gho_************************************',
    ].join('\n')
    expect(parseGhAccount(output)).toBe('octocat')
  })

  it('reads the account from older output', () => {
    expect(
      parseGhAccount('github.com\n  \u2713 Logged in to github.com as octocat (oauth_token)'),
    ).toBe('octocat')
  })

  it('prefers the active account', () => {
    const output = [
      'github.com',
      '  \u2713 Logged in to github.com account first (keyring)',
      '  - Active account: false',
      '  \u2713 Logged in to github.com account second (keyring)',
      '  - Active account: true',
    ].join('\n')
    expect(parseGhAccount(output)).toBe('second')
  })

  it('has no account when signed out', () => {
    expect(
      parseGhAccount('You are not logged into any GitHub hosts. To log in, run: gh auth login'),
    ).toBeNull()
    expect(parseGhAccount('')).toBeNull()
  })
})

describe('isNoPullRequestMessage', () => {
  it('matches the message of a branch without a pull request', () => {
    expect(isNoPullRequestMessage('no pull requests found for branch "fix/x"\n')).toBe(true)
    expect(isNoPullRequestMessage('could not determine current branch')).toBe(false)
  })
})

describe('parseNameStatus', () => {
  it('reads plain changes, renames and copies', () => {
    const output =
      '\n' +
      z(
        'M',
        'src/a b.ts',
        'A',
        'new.ts',
        'D',
        'gone.ts',
        'R087',
        'old.ts',
        'moved.ts',
        'C100',
        'x.ts',
        'y.ts',
        'T',
        'link',
      )
    expect(parseNameStatus(output)).toEqual([
      { path: 'src/a b.ts', oldPath: null, status: 'modified', insertions: null, deletions: null },
      { path: 'new.ts', oldPath: null, status: 'added', insertions: null, deletions: null },
      { path: 'gone.ts', oldPath: null, status: 'deleted', insertions: null, deletions: null },
      { path: 'moved.ts', oldPath: 'old.ts', status: 'renamed', insertions: null, deletions: null },
      { path: 'y.ts', oldPath: 'x.ts', status: 'copied', insertions: null, deletions: null },
      { path: 'link', oldPath: null, status: 'typechange', insertions: null, deletions: null },
    ])
  })

  it('is empty for empty output', () => {
    expect(parseNameStatus('')).toEqual([])
  })
})

describe('parseNumstat', () => {
  it('reads counts, binary files and renames', () => {
    const output = z('3\t1\tsrc/a.ts', '-\t-\timage.png', '5\t0\t', 'old.ts', 'moved.ts')
    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', insertions: 3, deletions: 1 },
      { path: 'image.png', insertions: null, deletions: null },
      { path: 'moved.ts', insertions: 5, deletions: 0 },
    ])
  })

  it('adds the counts to the files they name', () => {
    const files = parseNameStatus(z('M', 'a.ts', 'A', 'b.ts'))
    expect(withLineCounts(files, [{ path: 'a.ts', insertions: 2, deletions: 4 }])).toMatchObject([
      { path: 'a.ts', insertions: 2, deletions: 4 },
      { path: 'b.ts', insertions: null, deletions: null },
    ])
  })
})

describe('parsePorcelainFiles', () => {
  it('lists changed, renamed, conflicted and untracked files', () => {
    const output = z(
      '# branch.oid ' + OID,
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '1 A. N... 000000 100644 100644 000 bbb added.ts',
      '1 .D N... 100644 100644 000000 aaa aaa deleted.ts',
      '2 R. N... 100644 100644 100644 aaa aaa R100 moved name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc both.ts',
      '? new dir/file.ts',
    )
    expect(parsePorcelainFiles(output).map((f) => [f.status, f.path, f.oldPath])).toEqual([
      ['modified', 'src/a file.ts', null],
      ['added', 'added.ts', null],
      ['deleted', 'deleted.ts', null],
      ['renamed', 'moved name.ts', 'old name.ts'],
      ['conflicted', 'both.ts', null],
      ['untracked', 'new dir/file.ts', null],
    ])
  })
})

describe('parseCommitHeader', () => {
  it('splits the subject from the body', () => {
    const output = [
      OID,
      'Ada',
      'ada@example.com',
      '1792483200',
      'fix: one\r\n\r\nWhy it was wrong.\r\nAnd more.\n',
    ].join('\0')
    expect(parseCommitHeader(output)).toEqual({
      oid: OID,
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      time: 1792483200,
      subject: 'fix: one',
      body: 'Why it was wrong.\nAnd more.',
    })
  })

  it('has an empty body for a one-line message and rejects other output', () => {
    expect(parseCommitHeader([OID, 'A', 'a@x', '1', 'chore: x\n'].join('\0'))?.body).toBe('')
    expect(parseCommitHeader('fatal: bad object')).toBeNull()
  })
})

describe('parseAuthoredLog', () => {
  it('reads commits with their authors', () => {
    expect(
      parseAuthoredLog([OID, 'ci: snapshots', '1792483200', 'github-actions\n'].join('\0')),
    ).toEqual([{ oid: OID, subject: 'ci: snapshots', time: 1792483200, author: 'github-actions' }])
  })
})

describe('resolvePushTarget', () => {
  const origin: [string, string] = ['remote.origin.url', 'https://github.com/acme/app.git']
  const fork: [string, string] = ['remote.fork.url', 'git@github.com:me/app.git']
  const tracking = (branch: string, remote: string, merge: string): [string, string][] => [
    [`branch.${branch}.remote`, remote],
    [`branch.${branch}.merge`, `refs/heads/${merge}`],
  ]
  const acme = { owner: 'acme', repo: 'app' }

  it('pushes a branch to its upstream of the same name', () => {
    expect(resolvePushTarget([origin, ...tracking('fix', 'origin', 'fix')], 'fix')).toEqual({
      kind: 'remote',
      remote: 'origin',
      github: acme,
      branch: 'fix',
      setUpstream: false,
    })
  })

  it('publishes a branch without an upstream to origin under its own name', () => {
    expect(resolvePushTarget([fork, origin], 'feat')).toMatchObject({
      remote: 'origin',
      branch: 'feat',
      setUpstream: true,
    })
  })

  it('refuses an upstream of another name, as push.default=simple does', () => {
    // `git switch -c fix origin/main` tracks origin/main; a plain push would land on main.
    expect(resolvePushTarget([origin, ...tracking('fix', 'origin', 'main')], 'fix')).toEqual({
      kind: 'otherName',
      upstream: 'origin/main',
    })
  })

  it('follows push.default for an upstream of another name', () => {
    const entries = [origin, ...tracking('fix', 'origin', 'main')]
    expect(resolvePushTarget([...entries, ['push.default', 'upstream']], 'fix')).toMatchObject({
      remote: 'origin',
      branch: 'main',
      setUpstream: false,
    })
    expect(resolvePushTarget([...entries, ['push.default', 'current']], 'fix')).toMatchObject({
      remote: 'origin',
      branch: 'fix',
      setUpstream: false,
    })
  })

  it('never pushes to a local upstream', () => {
    expect(resolvePushTarget([origin, ...tracking('loc', '.', 'main')], 'loc')).toEqual({
      kind: 'localUpstream',
    })
  })

  it('prefers pushRemote, then remote.pushDefault, over the upstream remote', () => {
    const entries = [origin, fork, ...tracking('fix', 'origin', 'main')]
    expect(resolvePushTarget([...entries, ['branch.fix.pushremote', 'fork']], 'fix')).toMatchObject(
      { remote: 'fork', github: { owner: 'me', repo: 'app' }, branch: 'fix' },
    )
    expect(resolvePushTarget([...entries, ['remote.pushdefault', 'fork']], 'fix')).toMatchObject({
      remote: 'fork',
      branch: 'fix',
      setUpstream: false,
    })
    // A pushRemote can send a branch with a local upstream to a real remote.
    expect(
      resolvePushTarget(
        [origin, ...tracking('loc', '.', 'main'), ['branch.loc.pushremote', 'origin']],
        'loc',
      ),
    ).toMatchObject({ remote: 'origin', branch: 'loc', setUpstream: false })
  })

  it('tells no remote apart from several with none chosen', () => {
    expect(resolvePushTarget([], 'feat')).toEqual({ kind: 'noRemote' })
    expect(resolvePushTarget([fork], 'feat')).toMatchObject({ kind: 'remote', remote: 'fork' })
    expect(
      resolvePushTarget([fork, ['remote.upstream.url', 'https://github.com/acme/app']], 'feat'),
    ).toEqual({ kind: 'unknownRemote' })
    expect(resolvePushTarget([origin, ['branch.feat.remote', 'gone']], 'feat')).toEqual({
      kind: 'unknownRemote',
    })
  })
})
