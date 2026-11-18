import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KnownHost } from '@shared/remote/hosts'
import {
  configEntries,
  configLine,
  hostAlias,
  listSshConfigHosts,
  parseResolved,
  readConfigAliases,
  RESOLVE_CONCURRENCY,
  type Resolve,
} from './ssh-config'

describe('configLine', () => {
  it('reads the keyword in any case, after a space or one =', () => {
    expect(configLine('Host dev')).toEqual({ keyword: 'host', args: ['dev'] })
    expect(configLine('  HOST\tdev')).toEqual({ keyword: 'host', args: ['dev'] })
    expect(configLine('Host=dev')).toEqual({ keyword: 'host', args: ['dev'] })
    expect(configLine('host = dev box')).toEqual({ keyword: 'host', args: ['dev', 'box'] })
    expect(configLine('Host ==dev')).toEqual({ keyword: 'host', args: ['=dev'] })
  })

  it('takes quotes, escapes and a comment that starts an argument', () => {
    expect(configLine('Include "my configs/*.conf" other')).toEqual({
      keyword: 'include',
      args: ['my configs/*.conf', 'other'],
    })
    expect(configLine("Include 'a b' c\\ d")).toEqual({ keyword: 'include', args: ['a b', 'c d'] })
    expect(configLine('Host dev # the dev box')).toEqual({ keyword: 'host', args: ['dev'] })
    expect(configLine('Host dev#1')).toEqual({ keyword: 'host', args: ['dev#1'] })
    expect(configLine('Host dev  \r')).toEqual({ keyword: 'host', args: ['dev'] })
  })

  it('skips blank lines, comments and unbalanced quotes', () => {
    expect(configLine('')).toBeNull()
    expect(configLine('   ')).toBeNull()
    expect(configLine('# Host dev')).toBeNull()
    expect(configLine('  #Host dev')).toBeNull()
    expect(configLine('Include "open')).toBeNull()
  })
})

describe('hostAlias', () => {
  it('takes the first pattern without a wildcard, negation or class', () => {
    expect(hostAlias(['dev', 'dev.local'])).toBe('dev')
    expect(hostAlias(['*.corp', 'build'])).toBe('build')
    expect(hostAlias(['!bastion', 'box?', 'web[12]', 'db'])).toBe('db')
    expect(hostAlias(['*'])).toBeNull()
    expect(hostAlias(['!*.corp', '*'])).toBeNull()
  })
})

describe('configEntries', () => {
  it('lists Host aliases and Include lines, and nothing of Match or other keywords', () => {
    const text = [
      'Host *',
      '  ServerAliveInterval 30',
      'Host dev dev.local',
      '  HostName 10.0.0.12',
      'Match host build exec "true"',
      '  User ci',
      'Include ~/.ssh/conf.d/*',
      'Host',
      'Host gpu',
    ].join('\n')
    expect(configEntries(text)).toEqual([
      { kind: 'host', alias: 'dev' },
      { kind: 'include', paths: ['~/.ssh/conf.d/*'] },
      { kind: 'host', alias: 'gpu' },
    ])
  })
})

describe('readConfigAliases', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'kettu-ssh-config-'))
    await mkdir(path.join(home, '.ssh', 'conf.d'), { recursive: true })
  })
  afterEach(() => rm(home, { recursive: true, force: true }))

  const write = (name: string, lines: string[]): Promise<void> =>
    writeFile(path.join(home, name), lines.join('\n'))
  const read = () =>
    readConfigAliases(path.join(home, '.ssh', 'config'), { home, platform: 'linux' })

  it('follows Include in place: ~, paths relative to ~/.ssh, globs in order', async () => {
    await write('.ssh/config', [
      'Host first',
      'Include conf.d/*.conf',
      'Host middle',
      'Include ~/extra',
      'Host last first',
    ])
    await write('.ssh/conf.d/b.conf', ['Host b'])
    await write('.ssh/conf.d/a.conf', ['Host a1', 'Host a2'])
    await write('.ssh/conf.d/skipped.txt', ['Host skipped'])
    await write('extra', ['Host extra'])
    expect(await read()).toEqual({ aliases: ['first', 'a1', 'a2', 'b', 'middle', 'extra', 'last'] })
  })

  it('takes an absolute Include, and skips missing files and folders', async () => {
    const other = path.join(home, 'other.conf')
    await write('other.conf', ['Host other'])
    await mkdir(path.join(home, '.ssh', 'conf.d', 'folder'))
    await write('.ssh/config', [
      `Include "${other}"`,
      'Include missing.conf nothing/*',
      'Include conf.d/*',
      'Host dev',
    ])
    expect(await read()).toEqual({ aliases: ['other', 'dev'] })
  })

  it('reads each file once, so an Include loop ends', async () => {
    await write('.ssh/config', ['Host top', 'Include config', 'Include conf.d/loop'])
    await write('.ssh/conf.d/loop', ['Host inner', 'Include ~/.ssh/config', 'Include conf.d/loop'])
    expect(await read()).toEqual({ aliases: ['top', 'inner'] })
  })

  it('is empty without a config', async () => {
    expect(await read()).toEqual({ aliases: [] })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names a file it cannot read',
    async () => {
      await write('.ssh/config', ['Host dev', 'Include private.conf'])
      await writeFile(path.join(home, '.ssh', 'private.conf'), 'Host secret', { mode: 0 })
      const result = await read()
      expect(result).toEqual({
        failed: { path: path.join(home, '.ssh', 'private.conf'), detail: expect.any(String) },
      })
    },
  )
})

describe('parseResolved', () => {
  it('takes the user, host name, port and jump hosts ssh -G prints', () => {
    const stdout = [
      'host gpu',
      'user root',
      'hostname gpu.example.com',
      'port 2222',
      'proxyjump lin@jump.example.com',
      'identityfile ~/.ssh/id_ed25519',
      '',
    ].join('\n')
    expect(parseResolved(stdout)).toEqual({
      user: 'root',
      hostname: 'gpu.example.com',
      port: 2222,
      proxyJump: 'lin@jump.example.com',
    })
    expect(parseResolved('user lin\r\nhostname 10.0.0.12\r\nport 22\r\n')).toEqual({
      user: 'lin',
      hostname: '10.0.0.12',
      port: 22,
    })
    expect(parseResolved('user lin\nhostname box\nport 22\nproxyjump none\n')).toEqual({
      user: 'lin',
      hostname: 'box',
      port: 22,
    })
  })

  it('is null without a host name, a user or a valid port', () => {
    expect(parseResolved('')).toBeNull()
    expect(parseResolved('user lin\nport 22\n')).toBeNull()
    expect(parseResolved('hostname box\nport 22\n')).toBeNull()
    expect(parseResolved('user lin\nhostname box\nport 70000\n')).toBeNull()
  })
})

describe('listSshConfigHosts', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'kettu-ssh-list-'))
    await mkdir(path.join(home, '.ssh'))
  })
  afterEach(() => rm(home, { recursive: true, force: true }))

  const config = (lines: string[]): Promise<void> =>
    writeFile(path.join(home, '.ssh', 'config'), lines.join('\n'))
  const printed = (hostname: string, port = 22): { stdout: string } => ({
    stdout: `user lin\nhostname ${hostname}\nport ${port}\n`,
  })

  const known = (id: string, ssh: KnownHost['ssh'], removed = false): KnownHost => ({
    id,
    publicKey: 'key',
    name: id,
    platform: 'linux',
    version: '0.1.10',
    addresses: [],
    deviceName: 'Mac',
    addedAt: 1,
    lastOnlineAt: null,
    removed,
    ...(ssh ? { ssh } : {}),
  })

  it('lists what ssh resolves, in order, without code hosts or what it cannot resolve', async () => {
    await config(['Host dev', 'Host gh', 'Host broken', 'Host lab', 'Host -oProxyCommand=x'])
    const resolve: Resolve = async (alias) => {
      if (alias === 'dev') return printed('10.0.0.12')
      if (alias === 'gh') return printed('GitHub.com')
      if (alias === 'lab') return printed('lab.example.com', 2222)
      return 'failed'
    }
    const known_ = [
      known('a'.repeat(32), { target: 'lab', port: 47000 }),
      known('b'.repeat(32), { target: 'dev', port: 47000, sshPort: 2200 }),
    ]
    expect(await listSshConfigHosts({ known: known_, home, platform: 'linux', resolve })).toEqual({
      state: 'ok',
      hosts: [
        { alias: 'dev', user: 'lin', hostname: '10.0.0.12', port: 22 },
        {
          alias: 'lab',
          user: 'lin',
          hostname: 'lab.example.com',
          port: 2222,
          hostId: 'a'.repeat(32),
        },
      ],
    })
  })

  it('does not count a host this computer was removed from as added', async () => {
    await config(['Host dev'])
    const resolve: Resolve = async () => printed('10.0.0.12')
    const result = await listSshConfigHosts({
      known: [known('c'.repeat(32), { target: 'dev', port: 47000 }, true)],
      home,
      platform: 'linux',
      resolve,
    })
    expect(result).toEqual({
      state: 'ok',
      hosts: [{ alias: 'dev', user: 'lin', hostname: '10.0.0.12', port: 22 }],
    })
  })

  it('runs at most four at once and stops at 200 machines', async () => {
    await config(Array.from({ length: 260 }, (_, i) => `Host m${i}`))
    let running = 0
    let most = 0
    let asked = 0
    const resolve: Resolve = async (alias) => {
      asked++
      running++
      most = Math.max(most, running)
      await new Promise((done) => setTimeout(done, 1))
      running--
      return printed(`${alias}.example.com`)
    }
    const result = await listSshConfigHosts({ known: [], home, platform: 'linux', resolve })
    expect(most).toBe(RESOLVE_CONCURRENCY)
    expect(asked).toBeLessThan(260)
    expect(result.state === 'ok' && result.hosts.map((host) => host.alias)).toEqual(
      Array.from({ length: 200 }, (_, i) => `m${i}`),
    )
  })

  it('says so when there is no ssh program', async () => {
    await config(['Host dev', 'Host lab'])
    const resolve: Resolve = async () => 'missing'
    expect(await listSshConfigHosts({ known: [], home, platform: 'linux', resolve })).toEqual({
      state: 'failed',
      reason: 'ssh_missing',
    })
  })
})
