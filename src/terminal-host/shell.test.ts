import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pathLookup, programName, readEnv, resolveShell, shellEnvironment } from './shell'

const nothingOnPath = async (): Promise<string | null> => null

describe('resolveShell', () => {
  it('runs $SHELL as a login shell on macOS, else zsh', async () => {
    expect(
      await resolveShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, null, nothingOnPath),
    ).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'], name: 'fish' })
    expect(await resolveShell('darwin', {}, null, nothingOnPath)).toEqual({
      file: '/bin/zsh',
      args: ['-l'],
      name: 'zsh',
    })
  })

  it('runs $SHELL as a login shell on Linux, else bash', async () => {
    expect(await resolveShell('linux', { SHELL: '/usr/bin/zsh' }, null, nothingOnPath)).toEqual({
      file: '/usr/bin/zsh',
      args: ['-l'],
      name: 'zsh',
    })
    expect(await resolveShell('linux', { SHELL: 'zsh' }, null, nothingOnPath)).toEqual({
      file: '/bin/bash',
      args: ['-l'],
      name: 'bash',
    })
  })

  it('prefers pwsh on PATH on Windows', async () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    const lookups: string[] = []
    const shell = await resolveShell('win32', {}, null, async (program) => {
      lookups.push(program)
      return pwsh
    })
    expect(lookups).toEqual(['pwsh.exe'])
    expect(shell).toEqual({ file: pwsh, args: [], name: 'pwsh' })
  })

  it('falls back to Windows PowerShell under SystemRoot', async () => {
    expect(await resolveShell('win32', { SYSTEMROOT: 'D:\\Win' }, null, nothingOnPath)).toEqual({
      file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: [],
      name: 'powershell',
    })
  })

  it('uses the shell picked in Settings', async () => {
    expect(
      await resolveShell('linux', { SHELL: '/bin/bash' }, '/usr/bin/fish', nothingOnPath),
    ).toEqual({ file: '/usr/bin/fish', args: ['-l'], name: 'fish' })
    expect(
      await resolveShell('win32', {}, 'C:\\Program Files\\Git\\bin\\bash.exe', nothingOnPath),
    ).toEqual({ file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: [], name: 'bash' })
  })
})

describe('programName and readEnv', () => {
  it('names programs per platform', () => {
    expect(programName('/usr/local/bin/nu', 'linux')).toBe('nu')
    expect(programName('C:\\Windows\\System32\\cmd.EXE', 'win32')).toBe('cmd')
  })

  it('reads variables case-insensitively on Windows only', () => {
    expect(readEnv({ Path: 'x' }, 'PATH', 'win32')).toBe('x')
    expect(readEnv({ Path: 'x' }, 'PATH', 'linux')).toBeUndefined()
  })
})

describe('shellEnvironment', () => {
  it('drops Electron variables and adds the terminal ones', () => {
    const env = shellEnvironment(
      { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', electron_enable_logging: '1', HOME: '/h' },
      'linux',
      '0.3.0',
    )
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'OverBench',
      TERM_PROGRAM_VERSION: '0.3.0',
    })
  })

  it('sets LANG on macOS only when it is unset', () => {
    expect(shellEnvironment({}, 'darwin', '1.0.0').LANG).toBe('en_US.UTF-8')
    expect(shellEnvironment({ LANG: 'de_DE.UTF-8' }, 'darwin', '1.0.0').LANG).toBe('de_DE.UTF-8')
    expect(shellEnvironment({}, 'linux', '1.0.0').LANG).toBeUndefined()
  })
})

describe('pathLookup', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('finds the first matching program on PATH', async () => {
    dir = await mkdtemp(join(tmpdir(), 'overbench-path-'))
    const first = join(dir, 'a')
    const second = join(dir, 'b')
    await mkdir(first)
    await mkdir(second)
    await writeFile(join(second, 'tool'), '')
    await chmod(join(second, 'tool'), 0o755)
    const find = pathLookup({ PATH: ['relative', first, second].join(delimiter) }, process.platform)
    expect(await find('tool')).toBe(join(second, 'tool'))
    expect(await find('missing')).toBeNull()
  })
})
