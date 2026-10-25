import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultDataFolder,
  namesDmg,
  pickInstaller,
  readAppState,
  windowsInstallFolder,
} from './run.mjs'

describe('pickInstaller', () => {
  it('finds the NSIS setup for the version and architecture', () => {
    const files = [
      'builder-effective-config.yaml',
      'OverBench-0.0.900-x64-setup.exe',
      'OverBench-0.0.900-x64-setup.exe.blockmap',
      'latest.yml',
    ]
    expect(pickInstaller(files, { platform: 'win32', version: '0.0.900', arch: 'x64' })).toBe(
      'OverBench-0.0.900-x64-setup.exe',
    )
    expect(
      pickInstaller(files, { platform: 'win32', version: '0.0.900', arch: 'arm64' }),
    ).toBeNull()
  })

  it('finds the dmg for the architecture', () => {
    const files = ['OverBench-0.0.900-arm64.dmg', 'OverBench-0.0.900-x64.dmg', 'latest-mac.yml']
    expect(pickInstaller(files, { platform: 'darwin', version: '0.0.900', arch: 'arm64' })).toBe(
      'OverBench-0.0.900-arm64.dmg',
    )
  })

  it('finds the AppImage, whose name carries no version', () => {
    const files = ['OverBench-x86_64.AppImage', 'latest-linux.yml']
    expect(pickInstaller(files, { platform: 'linux', version: '0.0.900', arch: 'x64' })).toBe(
      'OverBench-x86_64.AppImage',
    )
  })
})

describe('readAppState', () => {
  it('reads the version that ran last', () => {
    expect(readAppState('{"version":1,"lastRunVersion":"0.0.901","dismissedUpdate":null}')).toEqual(
      { lastRunVersion: '0.0.901' },
    )
  })

  it('treats a missing or foreign file as no state', () => {
    expect(readAppState('')).toBeNull()
    expect(readAppState('{"version":2,"lastRunVersion":"0.0.901"}')).toBeNull()
    expect(readAppState('{"version":1}')).toEqual({ lastRunVersion: null })
  })
})

describe('defaultDataFolder', () => {
  it('follows each platform', () => {
    expect(
      defaultDataFolder({ platform: 'darwin', home: '/Users/a', appData: '', xdgConfigHome: '' }),
    ).toBe(join('/Users/a', 'Library', 'Application Support', 'OverBench'))
    expect(
      defaultDataFolder({
        platform: 'win32',
        home: 'C:\\Users\\a',
        appData: 'C:\\Users\\a\\AppData\\Roaming',
        xdgConfigHome: undefined,
      }),
    ).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'OverBench'))
    expect(
      defaultDataFolder({
        platform: 'linux',
        home: '/home/a',
        appData: undefined,
        xdgConfigHome: '',
      }),
    ).toBe(join('/home/a', '.config', 'OverBench'))
    expect(
      defaultDataFolder({
        platform: 'linux',
        home: '/home/a',
        appData: undefined,
        xdgConfigHome: '/home/a/.config-xdg',
      }),
    ).toBe(join('/home/a/.config-xdg', 'OverBench'))
  })
})

describe('windowsInstallFolder', () => {
  it('is the per-user Programs folder', () => {
    expect(
      windowsInstallFolder({
        home: 'C:\\Users\\a',
        localAppData: 'C:\\Users\\a\\AppData\\Local',
      }),
    ).toBe(join('C:\\Users\\a\\AppData\\Local', 'Programs', 'overbench'))
  })
})

describe('namesDmg', () => {
  it('accepts the release link to the dmg for the architecture', () => {
    expect(
      namesDmg(
        'https://github.com/overbench/overbench/releases/download/v0.0.901/OverBench-0.0.901-arm64.dmg',
        { version: '0.0.901', arch: 'arm64' },
      ),
    ).toBe(true)
  })

  it('rejects another architecture, version or link', () => {
    const href =
      'https://github.com/overbench/overbench/releases/download/v0.0.901/OverBench-0.0.901-arm64.dmg'
    expect(namesDmg(href, { version: '0.0.901', arch: 'x64' })).toBe(false)
    expect(namesDmg(href, { version: '0.0.902', arch: 'arm64' })).toBe(false)
    expect(
      namesDmg('https://github.com/overbench/overbench/releases/tag/v0.0.901', {
        version: '0.0.901',
        arch: 'arm64',
      }),
    ).toBe(false)
    expect(namesDmg(null, { version: '0.0.901', arch: 'arm64' })).toBe(false)
  })
})
