import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const theme = {
    shouldUseDarkColorsForSystemIntegratedUI: false,
    on: (_event: 'updated', listener: () => void) => listeners.add(listener),
    update: () => listeners.forEach((listener) => listener()),
    reset: () => listeners.clear(),
  }
  return {
    theme,
    trays: [] as FakeTrayShape[],
    portal: new Map<string, string | null>(),
  }
})

interface FakeTrayShape {
  image: string
  menu: { label?: string; enabled?: boolean; type?: string; click?: () => void }[]
  tooltip: string
  emit(event: string): boolean
}

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Tray extends EventEmitter {
    image: string
    menu: unknown[] = []
    tooltip = ''
    constructor(image: { path: string }) {
      super()
      this.image = image.path
      electron.trays.push(this as never)
    }
    setImage(image: { path: string }): void {
      this.image = image.path
    }
    setContextMenu(menu: unknown[]): void {
      this.menu = menu
    }
    setToolTip(tooltip: string): void {
      this.tooltip = tooltip
    }
  }
  return {
    app: { name: 'Kettu', isPackaged: false, getAppPath: () => '/app' },
    Menu: { buildFromTemplate: (template: unknown[]) => template },
    nativeImage: {
      createFromPath: (path: string) => ({
        path,
        isEmpty: () => false,
        setTemplateImage: () => {},
      }),
    },
    nativeTheme: electron.theme,
    Tray,
  }
})

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    const method = args.find((arg) => arg.startsWith('org.freedesktop.portal.Settings.'))!
    const reply = electron.portal.get(method.slice('org.freedesktop.portal.Settings.'.length))
    queueMicrotask(() => callback(reply ? null : new Error('no portal'), reply ?? ''))
  },
}))

const { setLocale } = await import('./i18n')
const { KettuTray, linuxTrayIsWhite, parseColorScheme, stateLine, trayImageName } =
  await import('./tray')

const platform = process.platform
const desktop = process.env['XDG_CURRENT_DESKTOP']
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const imageOf = (tray: FakeTrayShape): string => tray.image.slice(tray.image.lastIndexOf('/') + 1)

function start(system: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: system })
  const deps = { open: vi.fn(), quit: vi.fn() }
  const tray = new KettuTray(deps)
  tray.start()
  return { tray, deps, fake: electron.trays.at(-1)! }
}

beforeEach(() => {
  electron.trays.length = 0
  electron.portal.clear()
  electron.theme.shouldUseDarkColorsForSystemIntegratedUI = false
  electron.theme.reset()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  if (desktop === undefined) delete process.env['XDG_CURRENT_DESKTOP']
  else process.env['XDG_CURRENT_DESKTOP'] = desktop
  setLocale('en')
})

describe('trayImageName', () => {
  it('takes the template image on macOS, which tints it itself', () => {
    expect(trayImageName('darwin', true, false)).toBe('trayTemplate.png')
    expect(trayImageName('darwin', false, true)).toBe('trayDotTemplate.png')
  })

  it('takes the .ico on Windows and a PNG on Linux, in black or white', () => {
    expect(trayImageName('win32', false, false)).toBe('tray-black.ico')
    expect(trayImageName('win32', true, true)).toBe('tray-white-dot.ico')
    expect(trayImageName('linux', true, false)).toBe('tray-white.png')
    expect(trayImageName('linux', false, true)).toBe('tray-black-dot.png')
  })
})

describe('parseColorScheme', () => {
  it('reads the value of ReadOne and of the older Read', () => {
    expect(parseColorScheme('(<uint32 2>,)\n')).toBe(2)
    expect(parseColorScheme('(<<uint32 1>>,)\n')).toBe(1)
    expect(parseColorScheme('()\n')).toBeNull()
  })
})

describe('linuxTrayIsWhite', () => {
  it('is black only where the desktop prefers light and is not GNOME', () => {
    expect(linuxTrayIsWhite('KDE', 2)).toBe(false)
    expect(linuxTrayIsWhite('KDE', 1)).toBe(true)
    expect(linuxTrayIsWhite('KDE', 0)).toBe(true)
    expect(linuxTrayIsWhite('ubuntu:GNOME', 2)).toBe(true)
    expect(linuxTrayIsWhite(undefined, null)).toBe(true)
  })
})

describe('stateLine', () => {
  it('counts the sessions running and those that need approval', () => {
    expect(stateLine({ running: 0, waiting: 0 })).toBe('No sessions running')
    expect(stateLine({ running: 1, waiting: 0 })).toBe('1 session running')
    expect(stateLine({ running: 2, waiting: 1 })).toBe('2 sessions running · 1 needs approval')
    expect(stateLine({ running: 3, waiting: 2 })).toBe('3 sessions running · 2 need approval')
  })

  it('follows the interface language', () => {
    setLocale('zh-CN')
    expect(stateLine({ running: 0, waiting: 0 })).toBe('没有正在运行的会话')
    expect(stateLine({ running: 2, waiting: 1 })).toBe('2 个会话正在运行 · 1 个需要批准')
  })
})

describe('KettuTray', () => {
  it('shows its menu and puts the dot on while a request waits', () => {
    const { tray, deps, fake } = start('darwin')
    expect(imageOf(fake)).toBe('trayTemplate.png')
    expect(fake.tooltip).toBe('Kettu')
    expect(fake.menu.map((item) => item.label ?? item.type)).toEqual([
      'No sessions running',
      'separator',
      'Open Kettu',
      'Quit Kettu',
    ])
    expect(fake.menu[0]!.enabled).toBe(false)
    fake.menu[2]!.click!()
    fake.menu[3]!.click!()
    expect(deps.open).toHaveBeenCalledOnce()
    expect(deps.quit).toHaveBeenCalledOnce()
    tray.setDot(true)
    expect(imageOf(fake)).toBe('trayDotTemplate.png')
    tray.setBusy({ running: 2, waiting: 1 })
    expect(fake.menu[0]!.label).toBe('2 sessions running · 1 needs approval')
  })

  it('follows the taskbar on Windows, and opens the window on a click', () => {
    electron.theme.shouldUseDarkColorsForSystemIntegratedUI = true
    const { deps, fake } = start('win32')
    expect(imageOf(fake)).toBe('tray-white.ico')
    electron.theme.shouldUseDarkColorsForSystemIntegratedUI = false
    electron.theme.update()
    expect(imageOf(fake)).toBe('tray-black.ico')
    fake.emit('click')
    expect(deps.open).toHaveBeenCalledOnce()
  })

  it('follows the portal on Linux, white until it answers or without one', async () => {
    process.env['XDG_CURRENT_DESKTOP'] = 'KDE'
    electron.portal.set('ReadOne', '(<uint32 2>,)\n')
    const { fake } = start('linux')
    expect(imageOf(fake)).toBe('tray-white.png')
    await settle()
    expect(imageOf(fake)).toBe('tray-black.png')
    electron.portal.clear()
    electron.theme.update()
    await settle()
    expect(imageOf(fake)).toBe('tray-white.png')
  })

  it('falls back to Read on an older portal, and stays white on GNOME', async () => {
    process.env['XDG_CURRENT_DESKTOP'] = 'KDE'
    electron.portal.set('Read', '(<<uint32 2>>,)\n')
    const { fake } = start('linux')
    await settle()
    expect(imageOf(fake)).toBe('tray-black.png')
    process.env['XDG_CURRENT_DESKTOP'] = 'ubuntu:GNOME'
    electron.theme.update()
    await settle()
    expect(imageOf(fake)).toBe('tray-white.png')
  })
})
