import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEV_DATA_FOLDER, devUserDataPath, type UserDataInput } from './user-data'

const appData = resolve('app-data')
const cwd = resolve('worktree')
const base: UserDataInput = {
  isPackaged: false,
  switchValue: '',
  appData,
  override: undefined,
  cwd,
}

describe('devUserDataPath', () => {
  it('names the dev folder beside the installed app', () => {
    expect(DEV_DATA_FOLDER).toBe('Kettu Dev')
    expect(devUserDataPath(base)).toBe(join(appData, 'Kettu Dev'))
  })

  it('uses the folder KETTU_USER_DATA names', () => {
    const folder = resolve('elsewhere', 'feature-x')
    expect(devUserDataPath({ ...base, override: folder })).toBe(folder)
  })

  it('resolves a relative KETTU_USER_DATA from the working directory', () => {
    expect(devUserDataPath({ ...base, override: join('.dev', 'data') })).toBe(
      join(cwd, '.dev', 'data'),
    )
  })

  it('ignores an empty or blank KETTU_USER_DATA', () => {
    expect(devUserDataPath({ ...base, override: '' })).toBe(join(appData, 'Kettu Dev'))
    expect(devUserDataPath({ ...base, override: '  ' })).toBe(join(appData, 'Kettu Dev'))
  })

  it('leaves Electron alone when --user-data-dir has a value', () => {
    const switchValue = resolve('from-switch')
    expect(devUserDataPath({ ...base, switchValue })).toBeNull()
    expect(devUserDataPath({ ...base, switchValue, override: resolve('x') })).toBeNull()
  })

  it('does not count a --user-data-dir without a value', () => {
    // `--user-data-dir /tmp/x` leaves the value empty; Electron then keeps its default folder.
    expect(devUserDataPath({ ...base, switchValue: '' })).toBe(join(appData, 'Kettu Dev'))
    expect(devUserDataPath({ ...base, switchValue: '  ' })).toBe(join(appData, 'Kettu Dev'))
    const folder = resolve('elsewhere', 'feature-x')
    expect(devUserDataPath({ ...base, switchValue: '', override: folder })).toBe(folder)
  })

  it('leaves a packaged build alone, whatever the variable says', () => {
    expect(devUserDataPath({ ...base, isPackaged: true })).toBeNull()
    expect(devUserDataPath({ ...base, isPackaged: true, override: resolve('x') })).toBeNull()
  })
})
