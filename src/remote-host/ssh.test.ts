// What ssh's own messages mean, what the setup script prints on a machine with and without the
// daemon, and the options every ssh runs with.

import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempFolder } from '../agent-host/testing/temp'
import {
  installRun,
  lastLines,
  parseSetupReport,
  runSsh,
  setupScript,
  sshProblem,
  unsupportedSystem,
  type SshProgram,
} from './ssh'

const FAKE_SSH = path.resolve('src/remote-host/testing/fake-ssh.mts')
const describePosix = describe.skipIf(process.platform === 'win32')

describe('sshProblem', () => {
  it.each([
    ['Host key verification failed.', 'host_unknown'],
    [
      'No ED25519 host key is known for dev-box and you have requested strict checking.\nHost key verification failed.',
      'host_unknown',
    ],
    [
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key for [127.0.0.1]:52222 has changed and you have requested strict checking.\nHost key verification failed.',
      'host_changed',
    ],
    ['lin@127.0.0.1: Permission denied (publickey).', 'auth'],
    ['Received disconnect from 10.0.0.2: Too many authentication failures', 'auth'],
    ['ssh: connect to host 127.0.0.1 port 52223: Connection refused', 'unreachable'],
    ['ssh: Could not resolve hostname dev-box: nodename nor servname provided', 'unreachable'],
    ['ssh: connect to host 10.0.0.2 port 22: Operation timed out', 'unreachable'],
    ['kex_exchange_identification: read: Connection reset by peer', 'unreachable'],
    ['Connection closed by 198.18.3.122 port 22', 'unreachable'],
    [
      'channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed',
      'refused',
    ],
    ['stdio forwarding failed', 'refused'],
    ['channel 0: open failed: administratively prohibited: open failed', 'forwarding'],
    ['Bad configuration option: foo', null],
  ])('reads %j', (stderr, problem) => {
    expect(sshProblem(stderr)).toBe(problem)
  })
})

describe('the setup report', () => {
  it('reads the system, the version and the host, and ignores the rest', () => {
    const host = { publicKey: 'a2V5', name: 'dev-box', platform: 'linux', version: '0.3.0' }
    const stdout = [
      'Welcome to Ubuntu',
      'kettu-ssh system Linux x86_64',
      'kettu-ssh version 0.3.0',
      `kettu-ssh host ${JSON.stringify({ ...host, port: 52001 })}`,
    ].join('\r\n')
    expect(parseSetupReport(stdout)).toEqual({
      system: { os: 'Linux', arch: 'x86_64' },
      version: '0.3.0',
      host: { ...host, port: 52001 },
      failed: null,
    })
  })

  it('takes no version that is none and no host that is not one', () => {
    const stdout = [
      'kettu-ssh system Darwin arm64',
      'kettu-ssh version kettu: something broke',
      'kettu-ssh host {"publicKey":"a2V5","port":0}',
    ].join('\n')
    expect(parseSetupReport(stdout)).toEqual({
      system: { os: 'Darwin', arch: 'arm64' },
      version: null,
      host: null,
      failed: null,
    })
    expect(parseSetupReport('kettu-ssh system Linux aarch64\nkettu-ssh exit 3\n')).toMatchObject({
      failed: 3,
    })
  })

  it.each([
    [{ os: 'Linux', arch: 'x86_64' }, null],
    [{ os: 'Linux', arch: 'aarch64' }, null],
    [{ os: 'Darwin', arch: 'arm64' }, null],
    // Rosetta is the install script's to tell.
    [{ os: 'Darwin', arch: 'x86_64' }, null],
    [{ os: 'Linux', arch: 'armv7l' }, 'Linux armv7l'],
    [{ os: 'FreeBSD', arch: 'amd64' }, 'FreeBSD amd64'],
  ])('supports %j: %s', (system, unsupported) => {
    expect(unsupportedSystem(system)).toBe(unsupported)
  })

  it('keeps the last lines that say something', () => {
    const text = ['a', '', 'b  ', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join('\n')
    expect(lastLines(text, 3)).toBe('line 17\nline 18\nline 19')
    expect(lastLines('a\r\n\r\nb\n')).toBe('a\nb')
  })
})

describePosix('the setup script', () => {
  const run = (home: string, script: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile('sh', ['-s'], { env: { ...process.env, HOME: home } }, (error, out) =>
        error ? reject(error) : resolve(out),
      )
      child.stdin!.end(script)
    })

  it('says only the system where no daemon is installed', async () => {
    const home = await tempFolder('kettu-ssh-home-')
    const report = parseSetupReport(await run(home, setupScript(null)))
    expect(report.system?.os).toMatch(/^(Darwin|Linux)$/)
    expect(report).toMatchObject({ version: null, host: null, failed: null })
  })

  it("passes the device to the daemon's ssh-setup and reports what it printed", async () => {
    const home = await tempFolder('kettu-ssh-home-')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const kettu = path.join(bin, 'kettu')
    await writeFile(
      kettu,
      [
        '#!/bin/sh',
        'if [ "$1" = --version ]; then echo 0.3.0; exit 0; fi',
        'printf "%s" "$2" > "$HOME/request.json"',
        `echo '{"publicKey":"a2V5","name":"dev box","platform":"linux","version":"0.3.0","port":52001}'`,
        '',
      ].join('\n'),
    )
    await chmod(kettu, 0o755)
    const device = {
      publicKey: 'ZGV2aWNl',
      name: 'Lin\'s MacBook "Pro" $HOME',
      kind: 'desktop',
      platform: 'macOS 26.1',
      model: '',
    }
    const report = parseSetupReport(await run(home, setupScript(device)))
    expect(report).toMatchObject({
      version: '0.3.0',
      host: { name: 'dev box', port: 52001 },
      failed: null,
    })
    const { readFile } = await import('node:fs/promises')
    expect(JSON.parse(await readFile(path.join(home, 'request.json'), 'utf8'))).toEqual({ device })
  })

  it("says how the daemon's ssh-setup exited when it failed", async () => {
    const home = await tempFolder('kettu-ssh-home-')
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(
      path.join(bin, 'kettu'),
      '#!/bin/sh\nif [ "$1" = --version ]; then echo 0.2.0; exit 0; fi\necho old >&2\nexit 2\n',
    )
    await chmod(path.join(bin, 'kettu'), 0o755)
    expect(parseSetupReport(await run(home, setupScript(null)))).toMatchObject({
      version: '0.2.0',
      host: null,
      failed: 2,
    })
  })
})

describe('the install script', () => {
  it('installs the version asked for, from the download place this computer names', () => {
    const script = installRun('0.3.0', { KETTU_RELEASES_URL: "http://127.0.0.1:8000/it's" })
    expect(script.split('\n').slice(0, 4)).toEqual([
      'exec 2>&1',
      'set -- --version 0.3.0',
      "KETTU_RELEASES_URL='http://127.0.0.1:8000/it'\\''s'",
      'export KETTU_RELEASES_URL',
    ])
    expect(script).toContain('kettu-daemon-$os-$arch.tar.gz')
    expect(installRun('0.3.0', {})).not.toContain('KETTU_RELEASES_URL=')
  })
})

describePosix('runSsh', () => {
  const fake = (env: NodeJS.ProcessEnv = {}): SshProgram => ({
    command: process.execPath,
    args: [FAKE_SSH],
    env: { ...process.env, ...env },
  })

  it("runs the script in sh on the machine, with ssh's own options first", async () => {
    const home = await tempFolder('kettu-ssh-home-')
    const log = path.join(home, 'ssh.log')
    const signal = new AbortController().signal
    const run = await runSsh(
      fake({ FAKE_SSH_HOME: home, FAKE_SSH_LOG: log }),
      'lin@dev-box',
      'echo "home $HOME"\necho oops >&2\nexit 4\n',
      { timeoutMs: 10_000, signal },
    )
    expect(run).toEqual({ code: 4, stdout: `home ${home}\n`, stderr: 'oops\n', problem: null })
    const { readFile } = await import('node:fs/promises')
    const { args } = JSON.parse(await readFile(log, 'utf8')) as { args: string[] }
    expect(args.slice(-3)).toEqual(['--', 'lin@dev-box', 'sh -s'])
    expect(args).toEqual(
      expect.arrayContaining(['-T', '-a', '-x', 'BatchMode=yes', 'ClearAllForwardings=yes']),
    )
  })

  it('says why ssh failed, and that there is no ssh', async () => {
    const signal = new AbortController().signal
    const options = { timeoutMs: 10_000, signal }
    expect(await runSsh(fake(), 'auth@dev-box', 'true', options)).toMatchObject({
      code: 255,
      problem: 'auth',
    })
    const missing = { command: path.join(await tempFolder('kettu-no-ssh-'), 'ssh'), args: [] }
    expect(await runSsh(missing, 'lin@dev-box', 'true', options)).toMatchObject({
      code: null,
      problem: 'missing',
    })
  })

  it('stops ssh that takes too long, and settles with nothing once aborted', async () => {
    const home = await tempFolder('kettu-ssh-home-')
    const program = fake({ FAKE_SSH_HOME: home })
    const slow = await runSsh(program, 'lin@dev-box', 'sleep 5\n', {
      timeoutMs: 300,
      signal: new AbortController().signal,
    })
    expect(slow).toMatchObject({ code: null, problem: null })
    expect(slow!.stderr).toContain('took too long')
    const aborting = new AbortController()
    const aborted = runSsh(program, 'lin@dev-box', 'sleep 5\n', {
      timeoutMs: 10_000,
      signal: aborting.signal,
    })
    aborting.abort()
    expect(await aborted).toBeNull()
  })
})
