import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultDataFolder,
  expectedMode,
  namesDmg,
  packageArgs,
  pickInstaller,
  processesUnder,
  readAppState,
  windowsInstallFolder,
} from './run.mjs'

describe('pickInstaller', () => {
  it('finds the NSIS setup for the version and architecture', () => {
    const files = [
      'builder-effective-config.yaml',
      'Kettu-0.0.900-x64-setup.exe',
      'Kettu-0.0.900-x64-setup.exe.blockmap',
      'latest.yml',
    ]
    expect(pickInstaller(files, { platform: 'win32', version: '0.0.900', arch: 'x64' })).toBe(
      'Kettu-0.0.900-x64-setup.exe',
    )
    expect(
      pickInstaller(files, { platform: 'win32', version: '0.0.900', arch: 'arm64' }),
    ).toBeNull()
  })

  it('finds the dmg for the architecture', () => {
    const files = ['Kettu-0.0.900-arm64.dmg', 'Kettu-0.0.900-x64.dmg', 'latest-mac.yml']
    expect(pickInstaller(files, { platform: 'darwin', version: '0.0.900', arch: 'arm64' })).toBe(
      'Kettu-0.0.900-arm64.dmg',
    )
  })

  it('finds the AppImage, whose name carries no version', () => {
    const files = ['Kettu-x86_64.AppImage', 'latest-linux.yml']
    expect(pickInstaller(files, { platform: 'linux', version: '0.0.900', arch: 'x64' })).toBe(
      'Kettu-x86_64.AppImage',
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
    ).toBe(join('/Users/a', 'Library', 'Application Support', 'Kettu'))
    expect(
      defaultDataFolder({
        platform: 'win32',
        home: 'C:\\Users\\a',
        appData: 'C:\\Users\\a\\AppData\\Roaming',
        xdgConfigHome: undefined,
      }),
    ).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'Kettu'))
    expect(
      defaultDataFolder({
        platform: 'linux',
        home: '/home/a',
        appData: undefined,
        xdgConfigHome: '',
      }),
    ).toBe(join('/home/a', '.config', 'Kettu'))
    expect(
      defaultDataFolder({
        platform: 'linux',
        home: '/home/a',
        appData: undefined,
        xdgConfigHome: '/home/a/.config-xdg',
      }),
    ).toBe(join('/home/a/.config-xdg', 'Kettu'))
  })
})

describe('windowsInstallFolder', () => {
  it('is the per-user Programs folder', () => {
    expect(
      windowsInstallFolder({
        home: 'C:\\Users\\a',
        localAppData: 'C:\\Users\\a\\AppData\\Local',
      }),
    ).toBe(join('C:\\Users\\a\\AppData\\Local', 'Programs', 'kettu'))
  })
})

describe('namesDmg', () => {
  it('accepts the release link to the dmg for the architecture', () => {
    expect(
      namesDmg(
        'https://github.com/KettuAI/Kettu/releases/download/v0.0.901/Kettu-0.0.901-arm64.dmg',
        { version: '0.0.901', arch: 'arm64' },
      ),
    ).toBe(true)
  })

  it('rejects another architecture, version or link', () => {
    const href =
      'https://github.com/KettuAI/Kettu/releases/download/v0.0.901/Kettu-0.0.901-arm64.dmg'
    expect(namesDmg(href, { version: '0.0.901', arch: 'x64' })).toBe(false)
    expect(namesDmg(href, { version: '0.0.902', arch: 'arm64' })).toBe(false)
    expect(
      namesDmg('https://github.com/KettuAI/Kettu/releases/tag/v0.0.901', {
        version: '0.0.901',
        arch: 'arm64',
      }),
    ).toBe(false)
    expect(namesDmg(null, { version: '0.0.901', arch: 'arm64' })).toBe(false)
  })
})

describe('packageArgs', () => {
  const feed = { version: '0.0.900', output: '/tmp/build', feedUrl: 'http://127.0.0.1:5000/' }

  it('packages the release Developer ID build without notarizing it', () => {
    const { args, env } = packageArgs({ platform: 'darwin', signed: true, ...feed })
    expect(args).toEqual([
      '--publish',
      'never',
      '--config',
      'electron-builder.mac-signed.yml',
      '-c.mac.notarize=false',
      '-c.extraMetadata.version=0.0.900',
      '-c.mac.publish.provider=generic',
      '-c.mac.publish.url=http://127.0.0.1:5000/',
      '-c.directories.output=/tmp/build',
    ])
    expect(env).toEqual({})
  })

  it('keeps an ad-hoc build from picking an identity from the keychain', () => {
    const { args, env } = packageArgs({ platform: 'darwin', signed: false, ...feed })
    expect(args).not.toContain('--config')
    expect(args).toContain('-c.mac.publish.url=http://127.0.0.1:5000/')
    expect(env).toEqual({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  })

  it("points each platform's own publish settings at the feed", () => {
    expect(packageArgs({ platform: 'win32', signed: false, ...feed }).args).toContain(
      '-c.win.publish.provider=generic',
    )
    expect(packageArgs({ platform: 'linux', signed: false, ...feed }).args).toContain(
      '-c.linux.publish.url=http://127.0.0.1:5000/',
    )
  })
})

describe('expectedMode', () => {
  it('installs everywhere but on an ad-hoc signed Mac', () => {
    expect(expectedMode({ platform: 'darwin', signed: true })).toBe('install')
    expect(expectedMode({ platform: 'darwin', signed: false })).toBe('link')
    expect(expectedMode({ platform: 'win32', signed: false })).toBe('install')
    expect(expectedMode({ platform: 'linux', signed: false })).toBe('install')
  })
})

describe('processesUnder', () => {
  it('finds every process running from inside the app, ShipIt included', () => {
    const output = [
      '  1 /sbin/launchd',
      '412 /Applications/Kettu.app/Contents/MacOS/Kettu',
      '415 /Applications/Kettu.app/Contents/Frameworks/Kettu Helper (Renderer).app/Contents/MacOS/Kettu Helper (Renderer)',
      '520 /Applications/Kettu.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt',
      '611 /Applications/Kettu Beta.app/Contents/MacOS/Kettu Beta',
      '700 /Applications/Kettu.app.old/Contents/MacOS/Kettu',
      '',
    ].join('\n')
    expect(processesUnder(output, '/Applications/Kettu.app')).toEqual([412, 415, 520])
  })

  it('finds nothing when no process runs from it', () => {
    expect(processesUnder('  1 /sbin/launchd\n', '/Applications/Kettu.app')).toEqual([])
    expect(processesUnder('', '/Applications/Kettu.app')).toEqual([])
  })
})
