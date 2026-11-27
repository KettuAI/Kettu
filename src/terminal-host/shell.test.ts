import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FileStatsLike,
  isWindowsAppExecutionAliasPath,
  pathLookup,
  probeWindowsAppExecutionAlias,
  resolveShell,
  type ShellLog,
} from './shell'

const WINDOWS_APPS = 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps'
const STORE_PWSH = `${WINDOWS_APPS}\\pwsh.exe`
const MSI_PWSH_DIR = 'C:\\Program Files\\PowerShell\\7'
const MSI_PWSH = `${MSI_PWSH_DIR}\\pwsh.exe`
const POWERSHELL_51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function errno(code: string, message = code): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${message}`) as NodeJS.ErrnoException
  error.code = code
  return error
}

function stats(
  kind: 'file' | 'symlink' | 'dir',
  size = kind === 'symlink' ? 0 : 1024,
): FileStatsLike {
  return {
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    isDirectory: () => kind === 'dir',
    size,
  }
}

interface LogEntry {
  level: 'info' | 'warn'
  message: string
  data?: Record<string, unknown>
}

function createLog(): { entries: LogEntry[]; log: ShellLog } {
  const entries: LogEntry[] = []
  return {
    entries,
    log: (level, message, data) => entries.push({ level, message, data }),
  }
}

describe('isWindowsAppExecutionAliasPath', () => {
  it('matches .exe entries inside WindowsApps or a package subfolder beneath it', () => {
    expect(isWindowsAppExecutionAliasPath(STORE_PWSH)).toBe(true)
    expect(
      isWindowsAppExecutionAliasPath(
        `${WINDOWS_APPS}\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe`,
      ),
    ).toBe(true)
    expect(
      isWindowsAppExecutionAliasPath('C:/Users/alice/AppData/Local/Microsoft/WindowsApps/PWSH.EXE'),
    ).toBe(true)
  })

  it('rejects non-WindowsApps paths, non-.exe files, and deeper nested folders', () => {
    expect(isWindowsAppExecutionAliasPath(MSI_PWSH)).toBe(false)
    expect(isWindowsAppExecutionAliasPath('C:\\Restricted\\pwsh.exe')).toBe(false)
    expect(isWindowsAppExecutionAliasPath(`${WINDOWS_APPS}\\pwsh.bat`)).toBe(false)
    expect(isWindowsAppExecutionAliasPath(`${WINDOWS_APPS}\\pkg\\nested\\pwsh.exe`)).toBe(false)
  })
})

describe('Windows shell detection and App Execution Aliases', () => {
  it('resolves Microsoft Store pwsh.exe when stat throws EACCES and lstat sees a symlink', async () => {
    const { entries, log } = createLog()
    const probeAlias = vi.fn(async () => ({ ok: true, detail: 'PowerShell 7.5.0' }))
    const findOnPath = pathLookup({ Path: `"${WINDOWS_APPS}";C:\\Windows\\System32` }, 'win32', {
      stat: async (candidate) => {
        if (candidate === STORE_PWSH) throw errno('EACCES', 'permission denied')
        throw errno('ENOENT')
      },
      lstat: async (candidate) => {
        if (candidate === STORE_PWSH) return stats('symlink', 0)
        throw errno('ENOENT')
      },
      probeAlias,
      log,
    })

    const shell = await resolveShell('win32', { SystemRoot: 'C:\\Windows' }, null, findOnPath, log)

    expect(shell).toEqual({ file: STORE_PWSH, args: [], name: 'pwsh' })
    expect(probeAlias).toHaveBeenCalledWith(STORE_PWSH, 'pwsh.exe')
    expect(entries).toContainEqual({
      level: 'info',
      message: 'Verified Windows App Execution Alias',
      data: { candidate: STORE_PWSH, statCode: 'EACCES', detail: 'PowerShell 7.5.0' },
    })
    expect(entries).toContainEqual({
      level: 'info',
      message: 'Resolved Windows default shell to pwsh.exe',
      data: { file: STORE_PWSH },
    })
  })

  it.each(['EISDIR', 'UNKNOWN', 'EPERM', 'EINVAL'])(
    'also handles Windows App Execution Alias when stat throws %s',
    async (code) => {
      const probeAlias = vi.fn(async () => ({ ok: true, detail: 'PowerShell 7.4.6' }))
      const findOnPath = pathLookup({ PATH: WINDOWS_APPS }, 'win32', {
        stat: async () => {
          throw errno(code)
        },
        lstat: async () => stats('symlink', 0),
        probeAlias,
      })

      expect(await findOnPath('pwsh.exe')).toBe(STORE_PWSH)
      expect(probeAlias).toHaveBeenCalledTimes(1)
    },
  )

  it('probes 0-byte WindowsApps executables even if stat reports a regular file', async () => {
    const probeAlias = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'exit code 9009: placeholder stub' })
      .mockResolvedValueOnce({ ok: true, detail: 'PowerShell 7.5.0' })

    const brokenLookup = pathLookup({ PATH: WINDOWS_APPS }, 'win32', {
      stat: async () => stats('file', 0),
      probeAlias,
    })
    expect(await brokenLookup('pwsh.exe')).toBeNull()

    const workingLookup = pathLookup({ PATH: WINDOWS_APPS }, 'win32', {
      stat: async () => stats('file', 0),
      probeAlias,
    })
    expect(await workingLookup('pwsh.exe')).toBe(STORE_PWSH)
  })

  it('resolves regular pwsh.exe directly without lstat or alias probing', async () => {
    const lstatFn = vi.fn(async () => stats('symlink', 0))
    const probeAlias = vi.fn(async () => ({ ok: true }))
    const { entries, log } = createLog()
    const findOnPath = pathLookup({ Path: `${MSI_PWSH_DIR};${WINDOWS_APPS}` }, 'win32', {
      stat: async (candidate) => {
        if (candidate === MSI_PWSH) return stats('file', 280_000)
        throw errno('ENOENT')
      },
      lstat: lstatFn,
      probeAlias,
      log,
    })

    const shell = await resolveShell('win32', { SystemRoot: 'C:\\Windows' }, null, findOnPath, log)

    expect(shell).toEqual({ file: MSI_PWSH, args: [], name: 'pwsh' })
    expect(lstatFn).not.toHaveBeenCalled()
    expect(probeAlias).not.toHaveBeenCalled()
    expect(entries).toContainEqual({
      level: 'info',
      message: 'Resolved Windows default shell to pwsh.exe',
      data: { file: MSI_PWSH },
    })
  })

  it('falls back to Windows PowerShell 5.1 when a Store alias is broken or unrunnable', async () => {
    const { entries, log } = createLog()
    const findOnPath = pathLookup({ Path: WINDOWS_APPS }, 'win32', {
      stat: async (candidate) => {
        if (candidate === STORE_PWSH) throw errno('EACCES', 'permission denied')
        throw errno('ENOENT')
      },
      lstat: async () => stats('symlink', 0),
      probeAlias: async () => ({ ok: false, reason: 'exit code 9009: package corrupted' }),
      log,
    })

    const shell = await resolveShell('win32', { SystemRoot: 'C:\\Windows' }, null, findOnPath, log)

    expect(shell).toEqual({ file: POWERSHELL_51, args: [], name: 'powershell' })
    expect(entries).toContainEqual({
      level: 'warn',
      message: 'Skipped unusable Windows App Execution Alias',
      data: {
        candidate: STORE_PWSH,
        statCode: 'EACCES',
        reason: 'exit code 9009: package corrupted',
      },
    })
    expect(entries).toContainEqual({
      level: 'info',
      message: 'Falling back to Windows PowerShell 5.1: pwsh.exe was not found on PATH',
      data: { file: POWERSHELL_51 },
    })
  })

  it('continues past a broken WindowsApps alias to find a later regular pwsh.exe on PATH', async () => {
    const findOnPath = pathLookup({ Path: `${WINDOWS_APPS};${MSI_PWSH_DIR}` }, 'win32', {
      stat: async (candidate) => {
        if (candidate === STORE_PWSH) throw errno('EACCES')
        if (candidate === MSI_PWSH) return stats('file', 280_000)
        throw errno('ENOENT')
      },
      lstat: async () => stats('symlink', 0),
      probeAlias: async () => ({ ok: false, reason: 'probe timed out after 3000ms' }),
    })

    const shell = await resolveShell('win32', { SystemRoot: 'C:\\Windows' }, null, findOnPath)
    expect(shell).toEqual({ file: MSI_PWSH, args: [], name: 'pwsh' })
  })

  it('rejects unreadable non-WindowsApps files and restricted directories without probing', async () => {
    const lstatFn = vi.fn(async (candidate: string) => {
      if (candidate === STORE_PWSH) return stats('dir', 0)
      return stats('file', 100)
    })
    const probeAlias = vi.fn(async () => ({ ok: true }))
    const { entries, log } = createLog()

    const findOnPath = pathLookup({ Path: `C:\\Restricted;${WINDOWS_APPS}` }, 'win32', {
      stat: async () => {
        throw errno('EACCES')
      },
      lstat: lstatFn,
      probeAlias,
      log,
    })

    const shell = await resolveShell('win32', { SystemRoot: 'C:\\Windows' }, null, findOnPath, log)

    expect(shell).toEqual({ file: POWERSHELL_51, args: [], name: 'powershell' })
    expect(lstatFn).toHaveBeenCalledTimes(1)
    expect(lstatFn).toHaveBeenCalledWith(STORE_PWSH)
    expect(probeAlias).not.toHaveBeenCalled()
    expect(
      entries.some((entry) => entry.message === 'Skipped unreadable Windows PATH candidate'),
    ).toBe(true)
    expect(
      entries.some(
        (entry) =>
          entry.message ===
          'Skipped WindowsApps candidate: not an App Execution Alias reparse point',
      ),
    ).toBe(true)
  })

  it('honors an explicit shell override without querying PATH', async () => {
    const findOnPath = vi.fn(async () => MSI_PWSH)
    const shell = await resolveShell(
      'win32',
      { SystemRoot: 'C:\\Windows' },
      'C:\\Tools\\nu.exe',
      findOnPath,
    )

    expect(shell).toEqual({ file: 'C:\\Tools\\nu.exe', args: [], name: 'nu' })
    expect(findOnPath).not.toHaveBeenCalled()
  })
})

describe('probeWindowsAppExecutionAlias', () => {
  const dirs: string[] = []

  afterEach(async () => {
    while (dirs.length > 0) {
      await rm(dirs.pop()!, { recursive: true, force: true })
    }
  })

  async function writeScript(code: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kettu-shell-probe-'))
    dirs.push(dir)
    const script = join(dir, 'fake-pwsh.mjs')
    await writeFile(script, code, 'utf8')
    return script
  }

  function spawnViaNode(script: string) {
    return (
      _file: string,
      args: string[],
      options: { stdio: ['ignore', 'pipe', 'pipe']; windowsHide: true },
    ) => spawn(process.execPath, [script, ...args], options)
  }

  it('rejects Microsoft Store install redirector stubs via readlink without spawning', async () => {
    const spawnFn = vi.fn()
    const result = await probeWindowsAppExecutionAlias(STORE_PWSH, 'pwsh.exe', {
      readlink: async () =>
        'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.0_x64__8wekyb3d8bbwe\\AppInstallerPythonRedirector.exe',
      spawn: spawnFn,
    })

    expect(result).toEqual({ ok: false, reason: 'Windows Store install redirector stub' })
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('accepts a runnable pwsh alias that exits 0 with a PowerShell version banner', async () => {
    const script = await writeScript(
      `if (process.argv.includes('--version')) { console.log('PowerShell 7.5.0'); process.exit(0); } process.exit(1);`,
    )

    const result = await probeWindowsAppExecutionAlias(STORE_PWSH, 'pwsh.exe', {
      readlink: async () => {
        throw errno('EINVAL')
      },
      spawn: spawnViaNode(script),
    })

    expect(result).toEqual({ ok: true, detail: 'PowerShell 7.5.0' })
  })

  it('rejects placeholder stubs that exit non-zero or print unexpected output', async () => {
    const stubScript = await writeScript(
      `console.error('Install from Microsoft Store'); process.exit(9009);`,
    )
    const stubResult = await probeWindowsAppExecutionAlias(STORE_PWSH, 'pwsh.exe', {
      readlink: async () => {
        throw errno('EINVAL')
      },
      spawn: spawnViaNode(stubScript),
    })
    expect(stubResult.ok).toBe(false)
    expect(stubResult.reason).toContain('Install from Microsoft Store')

    const bogusScript = await writeScript(`console.log('not a shell'); process.exit(0);`)
    const bogusResult = await probeWindowsAppExecutionAlias(STORE_PWSH, 'pwsh.exe', {
      readlink: async () => {
        throw errno('EINVAL')
      },
      spawn: spawnViaNode(bogusScript),
    })
    expect(bogusResult).toEqual({ ok: false, reason: 'unexpected version output: not a shell' })
  })

  it('kills a hanging probe on timeout and returns failure without hanging', async () => {
    const hangingScript = await writeScript(`setTimeout(() => {}, 60_000);`)
    const result = await probeWindowsAppExecutionAlias(STORE_PWSH, 'pwsh.exe', {
      timeoutMs: 150,
      readlink: async () => {
        throw errno('EINVAL')
      },
      spawn: spawnViaNode(hangingScript),
    })

    expect(result).toEqual({ ok: false, reason: 'probe timed out after 150ms' })
  })

  it('returns failure cleanly when spawning the target fails', async () => {
    const result = await probeWindowsAppExecutionAlias(
      '/nonexistent-kettu-shell-probe-binary',
      'pwsh.exe',
      {
        readlink: async () => {
          throw errno('ENOENT')
        },
      },
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
  })
})

describe('non-Windows shell detection remains unchanged', () => {
  const dirs: string[] = []

  afterEach(async () => {
    while (dirs.length > 0) {
      await rm(dirs.pop()!, { recursive: true, force: true })
    }
  })

  it('resolves $SHELL as a login shell on macOS and Linux, falling back to platform defaults', async () => {
    const findOnPath = vi.fn(async () => '/usr/local/bin/pwsh')

    expect(
      await resolveShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, null, findOnPath),
    ).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'], name: 'fish' })
    expect(await resolveShell('darwin', { SHELL: 'relative/zsh' }, null, findOnPath)).toEqual({
      file: '/bin/zsh',
      args: ['-l'],
      name: 'zsh',
    })
    expect(await resolveShell('linux', {}, null, findOnPath)).toEqual({
      file: '/bin/bash',
      args: ['-l'],
      name: 'bash',
    })
    expect(findOnPath).not.toHaveBeenCalled()
  })

  it('does not invoke lstat or Windows alias probing on POSIX platforms', async () => {
    const lstatFn = vi.fn(async () => stats('symlink', 0))
    const probeAlias = vi.fn(async () => ({ ok: true }))
    const findOnPath = pathLookup({ PATH: '/Users/alice/WindowsApps:/usr/bin' }, 'darwin', {
      stat: async () => {
        throw errno('EACCES')
      },
      lstat: lstatFn,
      probeAlias,
    })

    expect(await findOnPath('pwsh.exe')).toBeNull()
    expect(lstatFn).not.toHaveBeenCalled()
    expect(probeAlias).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'requires execute permission on real POSIX files during pathLookup',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kettu-shell-posix-'))
      dirs.push(dir)
      const nonExec = join(dir, 'mysh')
      await writeFile(nonExec, '#!/bin/sh\n', 'utf8')
      await chmod(nonExec, 0o644)

      const findOnPath = pathLookup(
        { PATH: dir },
        process.platform === 'darwin' ? 'darwin' : 'linux',
      )
      expect(await findOnPath('mysh')).toBeNull()

      await chmod(nonExec, 0o755)
      expect(await findOnPath('mysh')).toBe(nonExec)
    },
  )
})
