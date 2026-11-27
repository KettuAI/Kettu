import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: {
    openPath: vi.fn(async () => ''),
  },
}))

const { isBlockedExecutablePath, openLocalFile } = await import('./open-file')

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-open-file-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('openLocalFile', () => {
  it('opens an existing regular local file, including spaces and CJK characters in the name', async () => {
    const dir = await makeTempDir()
    const md = path.join(dir, 'README.md')
    const xlsx = path.join(dir, 'reports', '2026 财报 sample.xlsx')
    const sql = path.join(dir, 'db', 'schema.sql')
    await mkdir(path.dirname(xlsx), { recursive: true })
    await mkdir(path.dirname(sql), { recursive: true })
    await writeFile(md, '# Hello\n', { mode: 0o644 })
    await writeFile(xlsx, 'xlsx-bytes', { mode: 0o644 })
    await writeFile(sql, 'select 1;\n', { mode: 0o644 })

    const openPath = vi.fn<(file: string) => Promise<string>>(async () => '')
    for (const file of [md, xlsx, sql]) {
      await openLocalFile(file, { openPath })
    }

    expect(openPath).toHaveBeenCalledTimes(3)
    expect(openPath.mock.calls[0]![0]).toMatch(/README\.md$/)
    expect(openPath.mock.calls[1]![0]).toMatch(/2026 财报 sample\.xlsx$/)
    expect(openPath.mock.calls[2]![0]).toMatch(/schema\.sql$/)
  })

  it.each([
    null,
    undefined,
    42,
    '',
    'README.md',
    './src/index.ts',
    '../outside.md',
    'file:///Users/dev/README.md',
    'kettu-host:0123456789abcdef0123456789abcdef:/home/dev/README.md',
    '/tmp/evil\0.md',
    `/${'a'.repeat(4_097)}`,
    '//server/share/doc.md',
  ])('rejects invalid or non-local path %j on POSIX without invoking openPath', async (input) => {
    const openPath = vi.fn(async () => '')
    await expect(openLocalFile(input, { platform: 'darwin', openPath })).rejects.toThrow()
    expect(openPath).not.toHaveBeenCalled()
  })

  it.each([
    '\\\\server\\share\\report.xlsx',
    '//server/share/report.xlsx',
    '\\temp\\report.xlsx',
    '/temp/report.xlsx',
    'reports\\sample.xlsx',
    'kettu-host:0123456789abcdef0123456789abcdef:C:\\Work\\README.md',
  ])('rejects UNC, drive-relative, and remote path %j on Windows', async (input) => {
    const openPath = vi.fn(async () => '')
    await expect(openLocalFile(input, { platform: 'win32', openPath })).rejects.toThrow()
    expect(openPath).not.toHaveBeenCalled()
  })

  it('rejects missing files with a clear error naming the file', async () => {
    const dir = await makeTempDir()
    const missing = path.join(dir, 'moved-report.xlsx')
    const openPath = vi.fn(async () => '')

    await expect(openLocalFile(missing, { openPath })).rejects.toThrow(/moved-report\.xlsx/)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('rejects directories including macOS .app bundles', async () => {
    const dir = await makeTempDir()
    const sub = path.join(dir, 'docs')
    const appBundle = path.join(dir, 'Calculator.app')
    await mkdir(sub)
    await mkdir(appBundle)
    const openPath = vi.fn(async () => '')

    await expect(openLocalFile(sub, { openPath })).rejects.toThrow(/docs.*only files/i)
    await expect(openLocalFile(appBundle, { openPath })).rejects.toThrow(
      /Calculator\.app.*only files/i,
    )
    expect(openPath).not.toHaveBeenCalled()
  })

  it('rejects POSIX files with execute permission bits even when the extension looks benign', async () => {
    const dir = await makeTempDir()
    const binary = path.join(dir, 'run-tool')
    const execMd = path.join(dir, 'notes.md')
    await writeFile(binary, '#!/bin/sh\necho hi\n')
    await writeFile(execMd, '#!/bin/sh\necho hi\n')
    await chmod(binary, 0o755)
    await chmod(execMd, 0o755)

    const openPath = vi.fn(async () => '')
    await expect(openLocalFile(binary, { platform: 'darwin', openPath })).rejects.toThrow(
      /run-tool.*executable/i,
    )
    await expect(openLocalFile(execMd, { platform: 'linux', openPath })).rejects.toThrow(
      /notes\.md.*executable/i,
    )
    expect(openPath).not.toHaveBeenCalled()
  })

  it.each([
    'deploy.sh',
    'DEPLOY.SH',
    'start.command',
    'build.bat',
    'setup.cmd',
    'installer.exe',
    'script.ps1',
    'launcher.desktop',
    'shortcut.lnk',
    'site.webloc',
    'site.url',
    'macro.vbs',
    'tool.jar',
  ])('rejects blocked executable or script file %s even without execute bits', async (filename) => {
    const dir = await makeTempDir()
    const file = path.join(dir, filename)
    await writeFile(file, 'echo hi\n', { mode: 0o644 })

    const openPath = vi.fn(async () => '')
    await expect(openLocalFile(file, { openPath })).rejects.toThrow(/executable/i)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('blocks .js and PATHEXT extensions on Windows while allowing non-executable .js on POSIX', async () => {
    const dir = await makeTempDir()
    const jsFile = path.join(dir, 'index.js')
    await writeFile(jsFile, 'export const ok = true\n', { mode: 0o644 })

    const openPath = vi.fn(async () => '')
    await openLocalFile(jsFile, { platform: 'darwin', openPath })
    expect(openPath).toHaveBeenCalledTimes(1)

    const winOpenPath = vi.fn(async () => '')
    const winStat = vi.fn(async () => ({
      isFile: () => true,
      isDirectory: () => false,
      mode: 0o666,
    }))
    await expect(
      openLocalFile('C:\\Work\\index.js', {
        platform: 'win32',
        stat: winStat,
        realpath: async (p) => p,
        openPath: winOpenPath,
      }),
    ).rejects.toThrow(/index\.js.*executable/i)

    expect(isBlockedExecutablePath('C:\\Work\\custom.xyz', 'win32', { PATHEXT: '.EXE;.XYZ' })).toBe(
      true,
    )
    expect(
      isBlockedExecutablePath('C:\\Work\\report.xlsx', 'win32', { PATHEXT: '.EXE;.BAT;.JS' }),
    ).toBe(false)
    expect(winOpenPath).not.toHaveBeenCalled()
  })

  it('follows safe symlinks and rejects symlinks to directories, missing files, executables, or UNC paths', async () => {
    const dir = await makeTempDir()
    const targetMd = path.join(dir, 'real.md')
    const targetSh = path.join(dir, 'script.sh')
    const targetDir = path.join(dir, 'folder')
    await writeFile(targetMd, '# Real\n', { mode: 0o644 })
    await writeFile(targetSh, 'echo hi\n', { mode: 0o644 })
    await mkdir(targetDir)

    const safeLink = path.join(dir, 'alias.md')
    const disguisedScript = path.join(dir, 'harmless.md')
    const dirLink = path.join(dir, 'folder-link.md')
    const danglingLink = path.join(dir, 'dangling.md')
    await symlink(targetMd, safeLink)
    await symlink(targetSh, disguisedScript)
    await symlink(targetDir, dirLink)
    await symlink(path.join(dir, 'gone.md'), danglingLink)

    const openPath = vi.fn<(file: string) => Promise<string>>(async () => '')
    await openLocalFile(safeLink, { openPath })
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(openPath.mock.calls[0]![0]).toMatch(/real\.md$/)

    openPath.mockClear()
    await expect(openLocalFile(disguisedScript, { openPath })).rejects.toThrow(
      /harmless\.md.*executable/i,
    )
    await expect(openLocalFile(dirLink, { openPath })).rejects.toThrow(
      /folder-link\.md.*only files/i,
    )
    await expect(openLocalFile(danglingLink, { openPath })).rejects.toThrow(
      /dangling\.md.*no longer exists/i,
    )
    await expect(
      openLocalFile('C:\\Work\\link.md', {
        platform: 'win32',
        realpath: async () => '\\\\evil\\share\\link.md',
        stat: async () => ({ isFile: () => true, isDirectory: () => false, mode: 0o666 }),
        openPath,
      }),
    ).rejects.toThrow(/link\.md/)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports the filename when shell.openPath returns an OS error string or throws', async () => {
    const dir = await makeTempDir()
    const file = path.join(dir, 'schema.sql')
    await writeFile(file, 'select 1;\n', { mode: 0o644 })

    await expect(
      openLocalFile(file, { openPath: async () => 'No application knows how to open this file' }),
    ).rejects.toThrow(/schema\.sql.*No application knows how to open this file/)

    await expect(
      openLocalFile(file, {
        openPath: async () => {
          throw new Error('Launch Services failed')
        },
      }),
    ).rejects.toThrow(/schema\.sql.*Launch Services failed/)
  })
})
