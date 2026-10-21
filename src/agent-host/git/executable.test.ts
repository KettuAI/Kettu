import { describe, expect, it } from 'vitest'
import { findWindowsExecutable } from './executable'

const files = (...paths: string[]) => {
  const present = new Set(paths.map((path) => path.toLowerCase()))
  return async (path: string): Promise<boolean> => present.has(path.toLowerCase())
}

const env = {
  PATH: 'C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Tools',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
}

describe('findWindowsExecutable', () => {
  it('finds an exe on PATH', async () => {
    const isFile = files('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(await findWindowsExecutable('git', env, isFile)).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe',
    )
  })

  it('takes the first directory that has it', async () => {
    const isFile = files('C:\\Tools\\gh.exe', 'C:\\Windows\\gh.exe')
    expect(await findWindowsExecutable('gh', env, isFile)).toBe('C:\\Windows\\gh.exe')
  })

  it('prefers .com over .exe in PATHEXT order and ignores .cmd and .bat shims', async () => {
    expect(
      await findWindowsExecutable('git', env, files('C:\\Tools\\git.exe', 'C:\\Tools\\git.com')),
    ).toBe('C:\\Tools\\git.com')
    expect(
      await findWindowsExecutable('gh', env, files('C:\\Tools\\gh.cmd', 'C:\\Tools\\gh.bat')),
    ).toBeNull()
  })

  it('reads PATH and PATHEXT whatever their case', async () => {
    const lower = { Path: 'C:\\Tools', pathext: '.EXE' }
    expect(await findWindowsExecutable('gh', lower, files('C:\\Tools\\gh.exe'))).toBe(
      'C:\\Tools\\gh.exe',
    )
    expect(
      await findWindowsExecutable(
        'gh',
        { Path: 'C:\\Tools', pathext: '.CMD' },
        files('C:\\Tools\\gh.exe'),
      ),
    ).toBeNull()
  })

  it('defaults PATHEXT when it is missing', async () => {
    expect(
      await findWindowsExecutable('gh', { PATH: 'C:\\Tools' }, files('C:\\Tools\\gh.exe')),
    ).toBe('C:\\Tools\\gh.exe')
  })

  it('accepts a name that already has an extension', async () => {
    expect(await findWindowsExecutable('git.exe', env, files('C:\\Tools\\git.exe'))).toBe(
      'C:\\Tools\\git.exe',
    )
  })

  it('strips quotes around a PATH entry', async () => {
    const quoted = { PATH: '"C:\\Program Files\\Git\\cmd";C:\\Tools' }
    expect(
      await findWindowsExecutable('git', quoted, files('C:\\Program Files\\Git\\cmd\\git.exe')),
    ).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
  })

  it('never looks in the working directory or a relative PATH entry', async () => {
    const relative = { PATH: '.;;tools;C:\\Tools' }
    const seen: string[] = []
    const isFile = async (path: string) => {
      seen.push(path)
      return path === 'git.exe' || path === '.\\git.exe' || path === 'tools\\git.exe'
    }
    expect(await findWindowsExecutable('git', relative, isFile)).toBeNull()
    expect(seen.every((path) => path.startsWith('C:\\Tools'))).toBe(true)
  })

  it('uses an absolute name as it is', async () => {
    const isFile = files('D:\\bin\\gh.exe')
    expect(await findWindowsExecutable('D:\\bin\\gh', env, isFile)).toBe('D:\\bin\\gh.exe')
  })

  it('gives null when nothing matches or PATH is empty', async () => {
    expect(await findWindowsExecutable('git', env, files())).toBeNull()
    expect(await findWindowsExecutable('git', {}, files('C:\\Tools\\git.exe'))).toBeNull()
  })
})
