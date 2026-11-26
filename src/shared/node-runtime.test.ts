import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { electronNodeRuntime, resolveElectronNodeExecutable } from './node-runtime'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('resolveElectronNodeExecutable', () => {
  it('resolves a packaged macOS app binary to its companion Helper binary when present', () => {
    const mainExec = '/Applications/Kettu.app/Contents/MacOS/Kettu'
    const helperExec =
      '/Applications/Kettu.app/Contents/Frameworks/Kettu Helper.app/Contents/MacOS/Kettu Helper'
    const exists = vi.fn((file: string) => file === helperExec)

    expect(resolveElectronNodeExecutable(mainExec, { platform: 'darwin', exists })).toBe(helperExec)
    expect(exists).toHaveBeenCalledWith(helperExec)
  })

  it('resolves the Electron dev bundle binary to Electron Helper', () => {
    const mainExec =
      '/repo/node_modules/.pnpm/electron@44.9.2/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    const helperExec =
      '/repo/node_modules/.pnpm/electron@44.9.2/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper'

    expect(
      resolveElectronNodeExecutable(mainExec, {
        platform: 'darwin',
        exists: (file) => file === helperExec,
      }),
    ).toBe(helperExec)
  })

  it('handles custom app names and spaces in both bundle folder and executable name', () => {
    const mainExec = '/Users/me/My Apps/Kettu Dev.app/Contents/MacOS/Kettu Dev'
    const helperExec =
      '/Users/me/My Apps/Kettu Dev.app/Contents/Frameworks/Kettu Dev Helper.app/Contents/MacOS/Kettu Dev Helper'

    expect(
      resolveElectronNodeExecutable(mainExec, {
        platform: 'darwin',
        exists: (file) => file === helperExec,
      }),
    ).toBe(helperExec)
  })

  it('uses the executable name when the outer .app bundle folder was renamed', () => {
    const mainExec = '/Applications/Kettu Copy.app/Contents/MacOS/Kettu'
    const helperExec =
      '/Applications/Kettu Copy.app/Contents/Frameworks/Kettu Helper.app/Contents/MacOS/Kettu Helper'

    expect(
      resolveElectronNodeExecutable(mainExec, {
        platform: 'darwin',
        exists: (file) => file === helperExec,
      }),
    ).toBe(helperExec)
  })

  it('leaves paths already pointing to a Helper binary unchanged without probing disk', () => {
    const exists = vi.fn(() => true)
    const helpers = [
      '/Applications/Kettu.app/Contents/Frameworks/Kettu Helper.app/Contents/MacOS/Kettu Helper',
      '/Applications/Kettu.app/Contents/Frameworks/Kettu Helper (Plugin).app/Contents/MacOS/Kettu Helper (Plugin)',
      '/Applications/Kettu.app/Contents/Frameworks/Kettu Helper (Renderer).app/Contents/MacOS/Kettu Helper (Renderer)',
      '/repo/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper',
    ]

    for (const helperExec of helpers) {
      expect(resolveElectronNodeExecutable(helperExec, { platform: 'darwin', exists })).toBe(
        helperExec,
      )
    }
    expect(exists).not.toHaveBeenCalled()
  })

  it('leaves non-macOS platforms unchanged without probing disk', () => {
    const exists = vi.fn(() => true)

    expect(
      resolveElectronNodeExecutable('C:\\Program Files\\Kettu\\Kettu.exe', {
        platform: 'win32',
        exists,
      }),
    ).toBe('C:\\Program Files\\Kettu\\Kettu.exe')
    expect(
      resolveElectronNodeExecutable('/opt/Kettu/kettu', {
        platform: 'linux',
        exists,
      }),
    ).toBe('/opt/Kettu/kettu')
    expect(
      resolveElectronNodeExecutable('/Applications/Kettu.app/Contents/MacOS/Kettu', {
        platform: 'linux',
        exists,
      }),
    ).toBe('/Applications/Kettu.app/Contents/MacOS/Kettu')
    expect(exists).not.toHaveBeenCalled()
  })

  it('leaves standalone Node.js and non-bundle paths unchanged', () => {
    const exists = vi.fn(() => true)

    for (const execPath of [
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/Applications/Kettu/Contents/MacOS/Kettu',
      '/.app/Contents/MacOS/Kettu',
      '/Applications/Kettu.app/Contents/MacOS/',
      '',
    ]) {
      expect(resolveElectronNodeExecutable(execPath, { platform: 'darwin', exists })).toBe(execPath)
    }
    expect(exists).not.toHaveBeenCalled()
  })

  it('falls back to the original executable when the Helper binary does not exist', () => {
    const mainExec = '/Applications/Kettu.app/Contents/MacOS/Kettu'
    const exists = vi.fn(() => false)

    expect(resolveElectronNodeExecutable(mainExec, { platform: 'darwin', exists })).toBe(mainExec)
    expect(exists).toHaveBeenCalledWith(
      '/Applications/Kettu.app/Contents/Frameworks/Kettu Helper.app/Contents/MacOS/Kettu Helper',
    )
  })

  it('checks the real filesystem with fs.existsSync by default', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'kettu-node-runtime-'))
    tempDirs.push(root)
    const appDir = path.join(root, 'Kettu Dev.app')
    const mainExec = path.join(appDir, 'Contents', 'MacOS', 'Kettu Dev')
    const helperExec = path.join(
      appDir,
      'Contents',
      'Frameworks',
      'Kettu Dev Helper.app',
      'Contents',
      'MacOS',
      'Kettu Dev Helper',
    )
    mkdirSync(path.dirname(mainExec), { recursive: true })
    writeFileSync(mainExec, '')

    // Helper missing on disk -> falls back to mainExec.
    const posixMain = mainExec.split(path.sep).join('/')
    const posixHelper = helperExec.split(path.sep).join('/')
    expect(resolveElectronNodeExecutable(posixMain, { platform: 'darwin' })).toBe(posixMain)

    // Helper present on disk -> resolves to helperExec.
    mkdirSync(path.dirname(helperExec), { recursive: true })
    writeFileSync(helperExec, '')
    expect(resolveElectronNodeExecutable(posixMain, { platform: 'darwin' })).toBe(posixHelper)
  })
})

describe('electronNodeRuntime', () => {
  it('returns the resolved executable with ELECTRON_RUN_AS_NODE=1', () => {
    const mainExec = '/Applications/Kettu.app/Contents/MacOS/Kettu'
    const helperExec =
      '/Applications/Kettu.app/Contents/Frameworks/Kettu Helper.app/Contents/MacOS/Kettu Helper'

    expect(
      electronNodeRuntime(mainExec, {
        platform: 'darwin',
        exists: (file) => file === helperExec,
      }),
    ).toEqual({
      command: helperExec,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('is used at every Electron ELECTRON_RUN_AS_NODE runtime call site across src/', () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const expectedSites = [
      'src/main/agent-host.ts',
      'src/main/device-host.ts',
      'src/device-host/runtime.ts',
      'src/agent-host/testing/harness.ts',
    ]

    for (const rel of expectedSites) {
      const content = readFileSync(path.join(root, rel), 'utf8')
      expect(content, `${rel} should use electronNodeRuntime`).toContain('electronNodeRuntime(')
    }

    // Guard against any production file introducing raw process.execPath + ELECTRON_RUN_AS_NODE.
    for (const file of walkTsFiles(path.join(root, 'src'))) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      if (rel === 'src/shared/node-runtime.ts') continue
      const content = readFileSync(file, 'utf8')
      expect(
        content,
        `${rel} should use electronNodeRuntime instead of raw process.execPath + ELECTRON_RUN_AS_NODE`,
      ).not.toMatch(/process\.execPath[^\n]*ELECTRON_RUN_AS_NODE/)
      expect(
        content,
        `${rel} should use electronNodeRuntime instead of raw ELECTRON_RUN_AS_NODE + process.execPath`,
      ).not.toMatch(/ELECTRON_RUN_AS_NODE[^\n]*process\.execPath/)
    }
  })
})
