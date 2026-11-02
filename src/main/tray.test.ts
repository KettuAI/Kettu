import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const theme = {
    shouldUseDarkColorsForSystemIntegratedUI: false,
    on: (_event: 'updated', listener: () => void) => listeners.add(listener),
    update: () => listeners.forEach((listener) => listener()),
    reset: () => listeners.clear(),
  }
  const macos = {
    style: '',
    notifications: new Map<string, () => void>(),
    getUserDefault: (key: string) => (key === 'AppleInterfaceStyle' ? macos.style : undefined),
    subscribeNotification: (event: string, listener: () => void) => {
      macos.notifications.set(event, listener)
      return 0
    },
    subscribeWorkspaceNotification: (event: string, listener: () => void) => {
      macos.notifications.set(event, listener)
      return 0
    },
  }
  return {
    theme,
    macos,
    trays: [] as FakeTrayShape[],
    portal: new Map<string, string | null>(),
    templated: [] as string[],
  }
})

interface FakeMenuItem {
  label?: string
  enabled?: boolean
  type?: string
  checked?: boolean
  accelerator?: string
  click?: () => void
}

interface FakeTrayShape {
  image: string
  menu: FakeMenuItem[]
  popped: FakeMenuItem[][]
  tooltip: string
  emit(event: string, ...args: unknown[]): boolean
}

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Tray extends EventEmitter {
    image: string
    menu: unknown[] = []
    popped: unknown[][] = []
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
    popUpContextMenu(menu: unknown[]): void {
      this.popped.push(menu)
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
        setTemplateImage: () => electron.templated.push(path),
      }),
    },
    nativeTheme: electron.theme,
    systemPreferences: electron.macos,
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
const {
  iconState,
  isTemplateImage,
  KettuTray,
  linuxTrayIsWhite,
  parseColorScheme,
  remoteLine,
  stateLine,
  trayImageName,
} = await import('./tray')

const platform = process.platform
const desktop = process.env['XDG_CURRENT_DESKTOP']
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const imageOf = (tray: FakeTrayShape): string => path.basename(tray.image)

const labels = (menu: FakeMenuItem[]) => menu.map((item) => item.label ?? item.type)

function start(system: NodeJS.Platform, { reduced = false, panel = true } = {}) {
  Object.defineProperty(process, 'platform', { value: system })
  const deps = {
    open: vi.fn(),
    quit: vi.fn(),
    newSession: vi.fn(),
    checkForUpdates: vi.fn(),
    setRemoteEnabled: vi.fn(),
    reducedMotion: vi.fn(() => reduced),
    ...(panel ? { togglePanel: vi.fn(), hidePanel: vi.fn() } : {}),
  }
  const tray = new KettuTray(deps)
  tray.start()
  return { tray, deps, fake: electron.trays.at(-1)! }
}

beforeEach(() => {
  electron.trays.length = 0
  electron.portal.clear()
  electron.templated.length = 0
  electron.macos.style = ''
  electron.macos.notifications.clear()
  electron.theme.shouldUseDarkColorsForSystemIntegratedUI = false
  electron.theme.reset()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  if (desktop === undefined) delete process.env['XDG_CURRENT_DESKTOP']
  else process.env['XDG_CURRENT_DESKTOP'] = desktop
  setLocale('en')
})

describe('iconState', () => {
  it('fades while the host is down, and puts a waiting request before running agents', () => {
    expect(iconState(false, { running: 2, waiting: 1 })).toBe('off')
    expect(iconState(true, { running: 2, waiting: 1 })).toBe('waiting')
    expect(iconState(true, { running: 2, waiting: 0 })).toBe('running')
    expect(iconState(true, { running: 0, waiting: 0 })).toBe('idle')
  })
})

describe('trayImageName', () => {
  it('takes the menu bar image shaded for the system appearance on macOS', () => {
    expect(trayImageName('darwin', true, 'idle')).toBe('tray-menubar-on-dark.png')
    expect(trayImageName('darwin', false, 'running', 3)).toBe('tray-menubar-on-light-running-3.png')
    expect(trayImageName('darwin', false, 'waiting')).toBe('tray-menubar-on-light-attention.png')
    expect(trayImageName('darwin', true, 'off')).toBe('tray-menubar-on-dark-off.png')
  })

  it('takes the .ico on Windows and a PNG on Linux, in black or white', () => {
    expect(trayImageName('win32', false, 'idle')).toBe('tray-black.ico')
    expect(trayImageName('win32', true, 'waiting')).toBe('tray-white-dot.ico')
    expect(trayImageName('linux', true, 'running')).toBe('tray-white.png')
    expect(trayImageName('linux', false, 'waiting')).toBe('tray-black-dot.png')
  })

  it('is a template on macOS but for the waiting dot, which keeps its color', () => {
    expect(isTemplateImage('darwin', 'idle')).toBe(true)
    expect(isTemplateImage('darwin', 'off')).toBe(true)
    expect(isTemplateImage('darwin', 'waiting')).toBe(false)
    expect(isTemplateImage('win32', 'idle')).toBe(false)
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

describe('remoteLine', () => {
  it('says how remote access is doing while it is on', () => {
    expect(remoteLine({ state: 'off', online: [] })).toBeNull()
    expect(remoteLine({ state: 'starting', online: [] })).toBe('Remote access is starting')
    expect(remoteLine({ state: 'failed', online: [] })).toBe('Remote access could not start')
    expect(remoteLine({ state: 'on', online: ['a'] })).toBe('Remote access on · 1 device online')
    setLocale('zh-CN')
    expect(remoteLine({ state: 'on', online: ['a', 'b'] })).toBe('远程访问已打开 · 2 台设备在线')
  })
})

describe('KettuTray', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the panel on a left click on macOS and the short menu on a right click', () => {
    const { deps, fake } = start('darwin')
    expect(fake.tooltip).toBe('Kettu')
    expect(fake.menu).toEqual([])
    const bounds = { x: 1, y: 2, width: 3, height: 4 }
    fake.emit('click', { altKey: false, ctrlKey: false }, bounds)
    expect(deps.togglePanel).toHaveBeenCalledWith(bounds)
    fake.emit('right-click')
    fake.emit('click', { altKey: true, ctrlKey: false }, bounds)
    expect(deps.togglePanel).toHaveBeenCalledOnce()
    expect(deps.hidePanel).toHaveBeenCalledTimes(2)
    expect(fake.popped.map(labels)).toEqual([
      [
        'Open Kettu',
        'New session',
        'separator',
        'Remote access',
        'separator',
        'Check for updates…',
        'Quit Kettu',
      ],
      expect.any(Array),
    ])
  })

  it('runs each item of the menu', () => {
    const { tray, deps, fake } = start('darwin')
    fake.emit('right-click')
    const [open, newSession, , remote, , updates, quit] = fake.popped[0]!
    expect(open!.accelerator).toBe('CmdOrCtrl+O')
    for (const item of [open, newSession, updates, quit]) item!.click!()
    expect(deps.open).toHaveBeenCalledOnce()
    expect(deps.newSession).toHaveBeenCalledOnce()
    expect(deps.checkForUpdates).toHaveBeenCalledOnce()
    expect(deps.quit).toHaveBeenCalledOnce()
    expect(remote!.checked).toBe(false)
    remote!.click!()
    expect(deps.setRemoteEnabled).toHaveBeenLastCalledWith(true)
    tray.setRemote({ state: 'on', online: [] })
    fake.emit('right-click')
    expect(fake.popped[1]![3]!.checked).toBe(true)
    fake.popped[1]![3]!.click!()
    expect(deps.setRemoteEnabled).toHaveBeenLastCalledWith(false)
  })

  it('opens the short menu on a left click without a panel', () => {
    const { fake } = start('darwin', { panel: false })
    fake.emit('click', { altKey: false, ctrlKey: false }, { x: 0, y: 0, width: 0, height: 0 })
    expect(fake.popped).toHaveLength(1)
  })

  it('starts the menu with what goes on where no panel shows it', () => {
    const { tray, fake } = start('linux')
    tray.setRemote({ state: 'on', online: [] })
    expect(labels(fake.menu).slice(0, 4)).toEqual([
      'No sessions running',
      'Remote access on · 0 devices online',
      'separator',
      'Open Kettu',
    ])
    expect(fake.menu[1]!.enabled).toBe(false)
    // Only macOS has the keys the labels would name.
    expect(fake.menu.some((item) => item.accelerator)).toBe(false)
    tray.setBusy({ running: 2, waiting: 1 })
    expect(fake.menu[0]!.label).toBe('2 sessions running · 1 needs approval')
    tray.setRemote({ state: 'off', online: [] })
    expect(fake.menu[1]!.type).toBe('separator')
  })

  it('shows the host down, agents running and a waiting request', () => {
    const { tray, fake } = start('darwin', { reduced: true })
    expect(imageOf(fake)).toBe('tray-menubar-on-light-off.png')
    tray.setConnected(true)
    expect(imageOf(fake)).toBe('tray-menubar-on-light.png')
    tray.setBusy({ running: 1, waiting: 0 })
    expect(imageOf(fake)).toBe('tray-menubar-on-light-running-0.png')
    tray.setBusy({ running: 1, waiting: 1 })
    expect(imageOf(fake)).toBe('tray-menubar-on-light-attention.png')
    expect(electron.templated.map((file) => path.basename(file))).not.toContain(
      'tray-menubar-on-light-attention.png',
    )
    tray.setConnected(false)
    expect(imageOf(fake)).toBe('tray-menubar-on-light-off.png')
  })

  it('breathes the running dot, and holds it still while motion is reduced', () => {
    vi.useFakeTimers()
    let reduced = false
    const { tray, deps, fake } = start('darwin')
    deps.reducedMotion.mockImplementation(() => reduced)
    tray.setConnected(true)
    tray.setBusy({ running: 1, waiting: 0 })
    const steps = (count: number) =>
      Array.from({ length: count }, () => {
        vi.advanceTimersByTime(160)
        return imageOf(fake).replace(/^tray-menubar-on-light-running-(\d)\.png$/, '$1')
      }).join('')
    expect(steps(12)).toBe('123454321012')
    reduced = true
    tray.motionChanged()
    expect(imageOf(fake)).toBe('tray-menubar-on-light-running-0.png')
    expect(steps(3)).toBe('000')
    reduced = false
    electron.macos.notifications.get(
      'NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification',
    )!()
    expect(steps(2)).toBe('12')
    tray.setBusy({ running: 0, waiting: 0 })
    vi.advanceTimersByTime(1000)
    expect(imageOf(fake)).toBe('tray-menubar-on-light.png')
  })

  it('is a template on macOS, shaded for the system appearance as it changes', () => {
    electron.macos.style = 'Dark'
    const { tray, fake } = start('darwin')
    tray.setConnected(true)
    expect(imageOf(fake)).toBe('tray-menubar-on-dark.png')
    electron.macos.style = ''
    electron.macos.notifications.get('AppleInterfaceThemeChangedNotification')!()
    expect(imageOf(fake)).toBe('tray-menubar-on-light.png')
    expect(electron.templated.map((file) => path.basename(file))).toEqual([
      'tray-menubar-on-dark-off.png',
      'tray-menubar-on-dark.png',
      'tray-menubar-on-light.png',
    ])
  })

  it('follows the taskbar on Windows, and opens the window on a click', () => {
    electron.theme.shouldUseDarkColorsForSystemIntegratedUI = true
    const { deps, fake } = start('win32')
    expect(imageOf(fake)).toBe('tray-white.ico')
    electron.theme.shouldUseDarkColorsForSystemIntegratedUI = false
    electron.theme.update()
    expect(imageOf(fake)).toBe('tray-black.ico')
    expect(electron.templated).toEqual([])
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
