import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { translate } from './i18n'
import {
  applyProxy,
  defaultShell,
  EnvironmentService,
  parseProbeOutput,
  resolveShellEnvironment,
  satisfiesNode,
  shellProbeArgs,
  withoutElectronVars,
} from './shell-env'

describe('shellProbeArgs', () => {
  it('runs an interactive login shell for sh-like shells', () => {
    const args = shellProbeArgs('/bin/zsh', '/Apps/Electron App/Electron', 'MARK')
    expect(args.slice(0, 3)).toEqual(['-i', '-l', '-c'])
    expect(args[3]).toBe(
      `'/Apps/Electron App/Electron' -p '"MARK" + JSON.stringify(process.env) + "MARK"'`,
    )
  })

  it('drops -l for csh and tcsh, which accept it only alone', () => {
    expect(shellProbeArgs('/bin/tcsh', '/e', 'M')[0]).toBe('-ic')
    expect(shellProbeArgs('/bin/csh', '/e', 'M')[0]).toBe('-ic')
  })

  it('uses PowerShell and nushell syntax', () => {
    expect(shellProbeArgs('/usr/local/bin/pwsh', "/a'b/e", 'M')).toEqual([
      '-Login',
      '-Command',
      `& '/a''b/e' -p '''M'' + JSON.stringify(process.env) + ''M'''`,
    ])
    expect(shellProbeArgs('/opt/bin/nu', '/e', 'M')[3]).toMatch(/^\^\/e -p/)
  })
})

describe('parseProbeOutput', () => {
  it('reads the JSON between the markers and ignores profile noise', () => {
    const output = `Welcome!\nMARK{"PATH":"/usr/bin","N":1,"HOME":"/h"}MARK\nbye`
    expect(parseProbeOutput(output, 'MARK')).toEqual({ PATH: '/usr/bin', HOME: '/h' })
  })

  it('returns null without both markers or with broken JSON', () => {
    expect(parseProbeOutput('nothing', 'MARK')).toBeNull()
    expect(parseProbeOutput('MARK{"a":', 'MARK')).toBeNull()
    expect(parseProbeOutput('MARK[1]MARK', 'MARK')).toBeNull()
  })
})

describe('environment cleanup', () => {
  it('removes every ELECTRON_ variable', () => {
    expect(
      withoutElectronVars(
        { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: '/bin' },
        'darwin',
      ),
    ).toEqual({ PATH: '/bin' })
    expect(withoutElectronVars({ Electron_Run_As_Node: '1', Path: 'C:\\' }, 'win32')).toEqual({
      Path: 'C:\\',
    })
  })

  it('applies a custom proxy in both cases, and only upper case on Windows', () => {
    const custom = { mode: 'custom' as const, url: 'http://proxy:8080', noProxy: 'localhost' }
    expect(applyProxy({ http_proxy: 'old', PATH: '/bin' }, custom, 'linux')).toEqual({
      PATH: '/bin',
      HTTP_PROXY: 'http://proxy:8080',
      http_proxy: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
      https_proxy: 'http://proxy:8080',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
    })
    expect(
      applyProxy({ Http_Proxy: 'old', no_proxy: 'x' }, { ...custom, noProxy: '' }, 'win32'),
    ).toEqual({
      HTTP_PROXY: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
    })
    const env = { HTTP_PROXY: 'keep' }
    expect(applyProxy(env, { mode: 'environment' }, 'darwin')).toBe(env)
  })

  it('picks the default shell per platform', () => {
    expect(defaultShell('darwin', {})).toBe('/bin/zsh')
    expect(defaultShell('linux', {})).toBe('/bin/sh')
    expect(defaultShell('linux', { SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish')
    expect(defaultShell('linux', { SHELL: 'fish' })).toBe('/bin/sh')
  })

  it('compares Node.js versions with a >= requirement', () => {
    expect(satisfiesNode('v24.1.0', '>=22')).toBe(true)
    expect(satisfiesNode('v22.0.0', '>=22')).toBe(true)
    expect(satisfiesNode('v20.18.1', '>=22')).toBe(false)
    expect(satisfiesNode('v22.11.0', '>=22.12')).toBe(false)
    expect(satisfiesNode('garbage', '>=22')).toBe(false)
  })
})

describe('resolveShellEnvironment', () => {
  it('uses the inherited environment on Windows, with the restart note', async () => {
    const result = await resolveShellEnvironment({
      platform: 'win32',
      electronPath: 'electron.exe',
      baseEnv: { Path: 'C:\\x', ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(result).toMatchObject({ source: 'inherited', env: { Path: 'C:\\x' } })
    expect(result.warning).toEqual({ key: 'environment.inherited' })
  })

  // The probe spawns a POSIX login shell; Windows has no such step.
  describe.skipIf(process.platform === 'win32')('with a real shell', () => {
    let dir: string
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'overbench-shell-'))
      await writeFile(path.join(dir, 'slow.sh'), '#!/bin/sh\nsleep 5\n')
      await chmod(path.join(dir, 'slow.sh'), 0o755)
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('reads the login shell environment through Node.js', async () => {
      const result = await resolveShellEnvironment({
        platform: process.platform,
        electronPath: process.execPath,
        baseEnv: { SHELL: '/bin/sh', PATH: process.env.PATH, OVERBENCH_PROBE: 'yes' },
      })
      expect(result.source).toBe('login-shell')
      expect(result.env.OVERBENCH_PROBE).toBe('yes')
      expect(result.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    })

    it('falls back with a warning when the shell does not answer in time', async () => {
      const result = await resolveShellEnvironment({
        platform: process.platform,
        electronPath: process.execPath,
        baseEnv: { SHELL: path.join(dir, 'slow.sh'), PATH: '/usr/bin:/bin', KEEP: '1' },
        timeoutMs: 300,
      })
      expect(result.source).toBe('fallback')
      expect(result.env.KEEP).toBe('1')
      expect(result.warning).toMatchObject({ key: 'environment.fallback' })
      expect(translate(result.warning!)).toMatch(/did not answer/)
    })
  })
})

describe('EnvironmentService', () => {
  it('resolves once, applies the proxy and reports what it found', async () => {
    let runs = 0
    const service = new EnvironmentService({
      platform: 'linux',
      electronPath: '/e',
      baseEnv: { PATH: '/inherited' },
      resolve: async () => {
        runs++
        return {
          env: { PATH: '/login' },
          source: 'login-shell',
          shell: '/bin/bash',
          durationMs: 12,
          warning: null,
        }
      },
      probe: async () => ({
        nodeVersion: 'v24.1.0',
        npmPath: '/login/npm',
        nodePath: '/login/node',
      }),
    })
    expect(service.info().source).toBe('pending')
    expect(service.agentEnv()).toEqual({ PATH: '/inherited' })
    await Promise.all([service.ready(), service.ready()])
    expect(runs).toBe(1)
    service.setProxy({ mode: 'custom', url: 'http://p', noProxy: '' })
    expect(service.agentEnv()).toMatchObject({ PATH: '/login', HTTPS_PROXY: 'http://p' })
    expect(service.info()).toMatchObject({
      source: 'login-shell',
      nodeVersion: 'v24.1.0',
      npmPath: '/login/npm',
    })
    await service.reload()
    expect(runs).toBe(2)
  })
})
