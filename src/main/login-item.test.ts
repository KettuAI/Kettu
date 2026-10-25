import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  setLoginItemSettings: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/home/test',
    setLoginItemSettings: electron.setLoginItemSettings,
    getLoginItemSettings: () => ({ status: 'enabled' }),
  },
}))

const {
  OPENED_AT_LOGIN_FLAG,
  applyLoginItem,
  autostartEntry,
  autostartPath,
  isOpenedAtLogin,
  linuxExecPath,
  startMode,
} = await import('./login-item')

let home: string | null = null

afterEach(async () => {
  electron.setLoginItemSettings.mockClear()
  if (home) await rm(home, { recursive: true, force: true })
  home = null
})

async function temporaryHome(): Promise<string> {
  home = await mkdtemp(join(os.tmpdir(), 'overbench-login-'))
  return home
}

function context(platform: NodeJS.Platform, overrides = {}) {
  return {
    platform,
    packaged: true,
    execPath: '/opt/overbench',
    home: '/home/test',
    appImage: undefined,
    ...overrides,
  }
}

describe('startMode', () => {
  it.each([
    ['darwin', true, 'hidden'],
    ['win32', true, 'minimized'],
    ['linux', true, 'minimized'],
    ['darwin', false, 'window'],
    ['win32', false, 'window'],
    ['linux', false, 'window'],
  ] as const)('opens %s at login %s as %s', (platform, atLogin, expected) => {
    expect(startMode(platform, atLogin)).toBe(expected)
  })
})

describe('isOpenedAtLogin', () => {
  it('reads the flag on Windows and Linux', () => {
    expect(isOpenedAtLogin('win32', ['overbench.exe', OPENED_AT_LOGIN_FLAG], false)).toBe(true)
    expect(isOpenedAtLogin('linux', ['overbench'], false)).toBe(false)
  })

  it('asks macOS how it was opened', () => {
    expect(isOpenedAtLogin('darwin', [OPENED_AT_LOGIN_FLAG], false)).toBe(false)
    expect(isOpenedAtLogin('darwin', [], true)).toBe(true)
  })
})

describe('the Linux desktop entry', () => {
  it('lives in the autostart folder of the home directory', () => {
    expect(autostartPath('/home/ana')).toBe('/home/ana/.config/autostart/overbench.desktop')
  })

  it('starts the app with the flag that marks a login start', () => {
    expect(autostartEntry('/opt/OverBench/overbench')).toBe(
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=OverBench',
        'Exec="/opt/OverBench/overbench" --opened-at-login',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n'),
    )
  })

  it('quotes a path with spaces and escapes what the entry format reserves', () => {
    expect(autostartEntry('/home/ana/My Apps/$bench`"')).toContain(
      'Exec="/home/ana/My Apps/\\$bench\\`\\"" --opened-at-login',
    )
  })

  it('runs the AppImage itself when the app was started from one', () => {
    expect(linuxExecPath('/tmp/.mount_OverBench/overbench', '/home/ana/OverBench.AppImage')).toBe(
      '/home/ana/OverBench.AppImage',
    )
    expect(linuxExecPath('/opt/overbench', '')).toBe('/opt/overbench')
  })

  it('writes and deletes the entry', async () => {
    const dir = await temporaryHome()
    await applyLoginItem(
      true,
      context('linux', { home: dir, appImage: '/home/ana/OverBench.AppImage' }),
    )
    expect(await readFile(autostartPath(dir), 'utf8')).toBe(
      autostartEntry('/home/ana/OverBench.AppImage'),
    )
    await applyLoginItem(false, context('linux', { home: dir }))
    await expect(readFile(autostartPath(dir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('applyLoginItem', () => {
  it('registers macOS without extra arguments', async () => {
    await applyLoginItem(true, context('darwin'))
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })

  it('registers Windows with the login start flag', async () => {
    await applyLoginItem(true, context('win32'))
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: [OPENED_AT_LOGIN_FLAG],
    })
  })

  it('does nothing in a development build', async () => {
    const dir = await temporaryHome()
    await applyLoginItem(true, context('linux', { packaged: false, home: dir }))
    await expect(readFile(autostartPath(dir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
  })
})
