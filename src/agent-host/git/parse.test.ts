import { describe, expect, it } from 'vitest'
import {
  isNoPullRequestMessage,
  parseConfigEntries,
  parseGhAccount,
  parseGhVersion,
  parseGitVersion,
  parseGithubRemote,
  parseLeftRightCount,
  parseLog,
  parseOidLines,
  parsePorcelainStatus,
  parseShortstat,
  pickRemote,
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

  it('uses a configured remote that is not called origin only when it is the branch remote', () => {
    const entries: [string, string][] = [
      ['remote.fork.url', 'https://github.com/me/app'],
      ['branch.main.remote', 'fork'],
    ]
    expect(pickRemote(entries, 'main')).toEqual({ name: 'fork', url: 'https://github.com/me/app' })
    expect(pickRemote(entries, 'other')).toBeNull()
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
