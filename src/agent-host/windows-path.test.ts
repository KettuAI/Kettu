// The PATH agents get on Windows once the environment is read again, as after an install: the
// user's and the system's, read from the registry where an installer leaves them.

import { describe, expect, it } from 'vitest'
import {
  parseRegistryEnvironment,
  resolveShellEnvironment,
  type RegistryEnvironment,
} from './shell-env'

const BASE = {
  Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs;C:\\Tools',
  SystemRoot: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\me',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
}

const REGISTRY: RegistryEnvironment = {
  system: [
    { name: 'Path', value: '%SystemRoot%\\system32;C:\\Program Files\\nodejs\\', expand: true },
  ],
  user: [
    {
      name: 'Path',
      value:
        '%USERPROFILE%\\.local\\bin;%PNPM_HOME%;%LOCALAPPDATA%\\Microsoft\\WinGet\\Links;%NOPE%',
      expand: true,
    },
    { name: 'PNPM_HOME', value: 'C:\\Users\\me\\AppData\\Local\\pnpm', expand: false },
  ],
}

function reread(registry: RegistryEnvironment | Error, again = true) {
  const asked: number[] = []
  const result = resolveShellEnvironment({
    platform: 'win32',
    nodeRuntime: { command: 'C:\\Kettu\\Kettu.exe', env: {} },
    baseEnv: { ...BASE, ELECTRON_RUN_AS_NODE: '1' },
    again,
    readRegistry: async () => {
      asked.push(1)
      if (registry instanceof Error) throw registry
      return registry
    },
  })
  return { result, asked }
}

describe('reading the environment again on Windows', () => {
  it('takes the system PATH, then the user PATH, then what only the inherited one had', async () => {
    const { env } = await reread(REGISTRY).result
    expect(env.Path).toBe(
      [
        'C:\\Windows\\system32',
        'C:\\Program Files\\nodejs\\',
        'C:\\Users\\me\\.local\\bin',
        'C:\\Users\\me\\AppData\\Local\\pnpm',
        'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links',
        '%NOPE%',
        'C:\\Tools',
      ].join(';'),
    )
    expect(Object.keys(env).filter((name) => name.toUpperCase() === 'PATH')).toEqual(['Path'])
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('keeps the inherited PATH when the registry names none', async () => {
    const { env } = await reread({ system: [], user: [] }).result
    expect(env.Path).toBe(BASE.Path)
  })

  it('keeps the inherited environment and says why when the registry cannot be read', async () => {
    const found = await reread(new Error('powershell.exe did not finish')).result
    expect(found.env.Path).toBe(BASE.Path)
    expect(found.warning).toMatchObject({
      key: 'environment.registryFailed',
      params: { error: 'powershell.exe did not finish' },
    })
  })

  it('reads nothing at start, when the inherited environment is current', async () => {
    const { result, asked } = reread(REGISTRY, false)
    expect((await result).env.Path).toBe(BASE.Path)
    expect(asked).toEqual([])
  })
})

describe('what the registry script prints', () => {
  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

  it('decodes each value, a non-ASCII one and an empty one included', () => {
    const text = [
      `system e ${b64('Path')} ${b64('%SystemRoot%\\system32')}`,
      `user s ${b64('Path')} ${b64('C:\\Users\\张三\\.local\\bin')}`,
      `user s ${b64('EMPTY')} `,
      'WARNING: something PowerShell said',
      '',
    ].join('\r\n')
    expect(parseRegistryEnvironment(text)).toEqual({
      system: [{ name: 'Path', value: '%SystemRoot%\\system32', expand: true }],
      user: [
        { name: 'Path', value: 'C:\\Users\\张三\\.local\\bin', expand: false },
        { name: 'EMPTY', value: '', expand: false },
      ],
    })
  })
})
