import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEV_DATA_FOLDER, devUserDataPath, type UserDataInput } from './user-data'

const appData = resolve('app-data')
const cwd = resolve('worktree')
const base: UserDataInput = {
  isPackaged: false,
  hasSwitch: false,
  appData,
  override: undefined,
  cwd,
}

describe('devUserDataPath', () => {
  it('names the dev folder beside the installed app', () => {
    expect(DEV_DATA_FOLDER).toBe('OverBench Dev')
    expect(devUserDataPath(base)).toBe(join(appData, 'OverBench Dev'))
  })

  it('uses the folder OVERBENCH_USER_DATA names', () => {
    const folder = resolve('elsewhere', 'feature-x')
    expect(devUserDataPath({ ...base, override: folder })).toBe(folder)
  })

  it('resolves a relative OVERBENCH_USER_DATA from the working directory', () => {
    expect(devUserDataPath({ ...base, override: join('.dev', 'data') })).toBe(
      join(cwd, '.dev', 'data'),
    )
  })

  it('ignores an empty or blank OVERBENCH_USER_DATA', () => {
    expect(devUserDataPath({ ...base, override: '' })).toBe(join(appData, 'OverBench Dev'))
    expect(devUserDataPath({ ...base, override: '  ' })).toBe(join(appData, 'OverBench Dev'))
  })

  it('leaves Electron alone when --user-data-dir is passed', () => {
    expect(devUserDataPath({ ...base, hasSwitch: true })).toBeNull()
    expect(devUserDataPath({ ...base, hasSwitch: true, override: resolve('x') })).toBeNull()
  })

  it('leaves a packaged build alone, whatever the variable says', () => {
    expect(devUserDataPath({ ...base, isPackaged: true })).toBeNull()
    expect(devUserDataPath({ ...base, isPackaged: true, override: resolve('x') })).toBeNull()
  })
})
