import { describe, expect, it } from 'vitest'
import {
  candidateNames,
  deleteEnv,
  findCommand,
  getEnv,
  needsShell,
  pathEntries,
} from './find-command'

function files(...paths: string[]): (file: string) => Promise<boolean> {
  const set = new Set(paths)
  return async (file) => set.has(file)
}

describe('findCommand on Windows', () => {
  const env = {
    Path: 'C:\\Windows\\system32;"C:\\Program Files\\nodejs";;relative\\bin',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  }

  it('tries each PATHEXT extension and reads Path case-insensitively', async () => {
    const isExecutable = files(
      'C:\\Program Files\\nodejs\\npx.cmd',
      'C:\\Program Files\\nodejs\\node.exe',
    )
    expect(await findCommand('npx', { platform: 'win32', env, isExecutable })).toBe(
      'C:\\Program Files\\nodejs\\npx.cmd',
    )
    expect(await findCommand('node', { platform: 'win32', env, isExecutable })).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    )
  })

  it('takes a name that already has a known extension as is', async () => {
    const isExecutable = files('C:\\Windows\\system32\\opencode.exe')
    expect(await findCommand('opencode.exe', { platform: 'win32', env, isExecutable })).toBe(
      'C:\\Windows\\system32\\opencode.exe',
    )
    expect(candidateNames('tool.cmd', env, 'win32')).toEqual(['tool.cmd'])
    expect(candidateNames('tool', env, 'win32')).toEqual([
      'tool.com',
      'tool.exe',
      'tool.bat',
      'tool.cmd',
    ])
  })

  it('never searches relative PATH entries or the current directory', async () => {
    const isExecutable = files('relative\\bin\\npx.cmd', 'npx.cmd')
    expect(await findCommand('npx', { platform: 'win32', env, isExecutable })).toBeNull()
  })

  it('checks an absolute path with PATHEXT', async () => {
    const isExecutable = files('D:\\tools\\opencode.exe')
    expect(await findCommand('D:\\tools\\opencode', { platform: 'win32', env, isExecutable })).toBe(
      'D:\\tools\\opencode.exe',
    )
  })

  it('uses the default PATHEXT when it is unset', () => {
    expect(candidateNames('npx', { Path: 'C:\\x' }, 'win32')).toContain('npx.cmd')
  })
})

describe('findCommand on macOS and Linux', () => {
  const env = { PATH: '/usr/local/bin:/usr/bin::bin' }

  it('walks PATH in order', async () => {
    const isExecutable = files('/usr/bin/npx', '/usr/local/bin/npx')
    expect(await findCommand('npx', { platform: 'darwin', env, isExecutable })).toBe(
      '/usr/local/bin/npx',
    )
  })

  it('does not apply PATHEXT and ignores relative entries', async () => {
    const isExecutable = files('/usr/bin/npx.cmd', 'bin/npx')
    expect(await findCommand('npx', { platform: 'linux', env, isExecutable })).toBeNull()
  })

  it('is case-sensitive about the variable name', async () => {
    expect(pathEntries({ Path: '/usr/bin' }, 'linux')).toEqual([])
    expect(pathEntries(env, 'linux')).toEqual(['/usr/local/bin', '/usr/bin', 'bin'])
  })

  it('rejects relative paths with separators', async () => {
    expect(
      await findCommand('./npx', { platform: 'linux', env, isExecutable: files('./npx') }),
    ).toBeNull()
  })
})

describe('environment helpers', () => {
  it('reads and deletes names by the platform rules', () => {
    const env: Record<string, string | undefined> = { Path: 'a', http_proxy: 'p', HTTP_PROXY: 'P' }
    expect(getEnv(env, 'PATH', 'win32')).toBe('a')
    expect(getEnv(env, 'PATH', 'linux')).toBeUndefined()
    deleteEnv(env, 'HTTP_PROXY', 'win32')
    expect(env).toEqual({ Path: 'a' })
  })

  it('spawns only .cmd and .bat through a shell, on Windows', () => {
    expect(needsShell('C:\\nodejs\\npx.cmd', 'win32')).toBe(true)
    expect(needsShell('C:\\x\\run.BAT', 'win32')).toBe(true)
    expect(needsShell('C:\\x\\opencode.exe', 'win32')).toBe(false)
    expect(needsShell('/usr/bin/npx.cmd', 'linux')).toBe(false)
  })
})
