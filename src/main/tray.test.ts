import type { EventEmitter } from 'node:events'
import type { MenuItemConstructorOptions, Rectangle } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeTrayInstance extends EventEmitter {
  image: { path: string; setTemplateImage: ReturnType<typeof vi.fn> }
  setToolTip: ReturnType<typeof vi.fn>
  setContextMenu: ReturnType<typeof vi.fn>
  popUpContextMenu: ReturnType<typeof vi.fn>
  setImage: ReturnType<typeof vi.fn>
}

interface BuiltMenu {
  template: MenuItemConstructorOptions[]
}

const state = vi.hoisted(() => ({
  trays: [] as FakeTrayInstance[],
  nativeThemeEmitter: null as EventEmitter | null,
  shouldUseDarkColorsForSystemIntegratedUI: false,
  appleInterfaceStyle: 'Dark',
  subscribeNotification: vi.fn(),
  subscribeWorkspaceNotification: vi.fn(),
  buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]): BuiltMenu => ({ template })),
  execFile: vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      callback(new Error('portal unavailable'), '')
    },
  ),
}))

vi.mock('node:child_process', () => ({
  execFile: (...args: Parameters<typeof state.execFile>) => state.execFile(...args),
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')

  class FakeTray extends Emitter {
    setToolTip = vi.fn()
    setContextMenu = vi.fn()
    popUpContextMenu = vi.fn()
    setImage = vi.fn()

    constructor(public readonly image: FakeTrayInstance['image']) {
      super()
      state.trays.push(this as unknown as FakeTrayInstance)
    }
  }

  const nativeThemeEmitter = (state.nativeThemeEmitter ??= new Emitter())
  const nativeTheme = Object.assign(nativeThemeEmitter, {
    get shouldUseDarkColorsForSystemIntegratedUI(): boolean {
      return state.shouldUseDarkColorsForSystemIntegratedUI
    },
  })

  return {
    app: {
      name: 'Kettu',
      isPackaged: false,
      getAppPath: () => '/app',
    },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) =>
        state.buildFromTemplate(template),
    },
    nativeImage: {
      createFromPath: (path: string) => ({
        path,
        isEmpty: () => false,
        setTemplateImage: vi.fn(),
      }),
    },
    nativeTheme,
    systemPreferences: {
      getUserDefault: () => state.appleInterfaceStyle,
      subscribeNotification: (...args: unknown[]) => state.subscribeNotification(...args),
      subscribeWorkspaceNotification: (...args: unknown[]) =>
        state.subscribeWorkspaceNotification(...args),
    },
    Tray: FakeTray,
  }
})

vi.mock('./debug-mode', () => ({
  isDebugRun: () => false,
}))

vi.mock('./log', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const { KettuTray } = await import('./tray')
type TrayDeps = import('./tray').TrayDeps

function makeDeps(overrides: Partial<TrayDeps> = {}) {
  const open = vi.fn()
  const quit = vi.fn()
  const newSession = vi.fn()
  const checkForUpdates = vi.fn()
  const openDebugMode = vi.fn()
  const setRemoteEnabled = vi.fn()
  const reducedMotion = vi.fn(() => false)
  const deps: TrayDeps = {
    open,
    quit,
    newSession,
    checkForUpdates,
    openDebugMode,
    setRemoteEnabled,
    reducedMotion,
    ...overrides,
  }
  return { deps, open, quit, newSession, checkForUpdates, openDebugMode, setRemoteEnabled }
}

function findMenuItem(menu: BuiltMenu, label: string): MenuItemConstructorOptions | undefined {
  return menu.template.find((item) => item.label === label)
}

describe('KettuTray click and menu behavior', () => {
  beforeEach(() => {
    state.trays.length = 0
    state.nativeThemeEmitter?.removeAllListeners()
    state.shouldUseDarkColorsForSystemIntegratedUI = false
    state.appleInterfaceStyle = 'Dark'
    state.subscribeNotification.mockReset()
    state.subscribeWorkspaceNotification.mockReset()
    state.buildFromTemplate.mockClear()
    state.execFile.mockClear()
  })

  it('opens the window on left click and keeps the Open item in the context menu on Linux', () => {
    const { deps, open } = makeDeps({ platform: 'linux' })
    const tray = new KettuTray(deps)

    tray.start()

    const nativeTray = state.trays[0]
    expect(nativeTray).toBeDefined()
    expect(nativeTray!.setContextMenu).toHaveBeenCalledTimes(1)
    expect(nativeTray!.popUpContextMenu).not.toHaveBeenCalled()
    expect(state.subscribeNotification).not.toHaveBeenCalled()

    nativeTray!.emit('click')
    expect(open).toHaveBeenCalledTimes(1)

    const contextMenu = nativeTray!.setContextMenu.mock.calls[0]![0] as BuiltMenu
    const openItem = findMenuItem(contextMenu, 'Open Kettu')
    expect(openItem).toBeDefined()
    openItem!.click?.(undefined as never, undefined as never, undefined as never)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('opens the window on click and sets the context menu on Windows', () => {
    const { deps, open } = makeDeps({ platform: 'win32' })
    const tray = new KettuTray(deps)

    tray.start()

    const nativeTray = state.trays[0]
    expect(nativeTray).toBeDefined()
    expect(nativeTray!.setContextMenu).toHaveBeenCalledTimes(1)

    nativeTray!.emit('click')
    expect(open).toHaveBeenCalledTimes(1)

    const contextMenu = nativeTray!.setContextMenu.mock.calls[0]![0] as BuiltMenu
    expect(findMenuItem(contextMenu, 'Open Kettu')).toBeDefined()
  })

  it('toggles the panel on left click and pops up the menu on right click or modifier click on macOS', () => {
    const togglePanel = vi.fn(() => true)
    const hidePanel = vi.fn()
    const { deps, open } = makeDeps({ platform: 'darwin', togglePanel, hidePanel })
    const tray = new KettuTray(deps)

    tray.start()

    const nativeTray = state.trays[0]
    expect(nativeTray).toBeDefined()
    expect(nativeTray!.setContextMenu).not.toHaveBeenCalled()

    const bounds: Rectangle = { x: 100, y: 0, width: 22, height: 22 }
    nativeTray!.emit('click', { altKey: false, ctrlKey: false }, bounds)
    expect(togglePanel).toHaveBeenCalledWith(bounds)
    expect(open).not.toHaveBeenCalled()
    expect(nativeTray!.popUpContextMenu).not.toHaveBeenCalled()

    nativeTray!.emit('click', { altKey: true, ctrlKey: false }, bounds)
    expect(hidePanel).toHaveBeenCalledTimes(1)
    expect(nativeTray!.popUpContextMenu).toHaveBeenCalledTimes(1)

    nativeTray!.emit('right-click')
    expect(hidePanel).toHaveBeenCalledTimes(2)
    expect(nativeTray!.popUpContextMenu).toHaveBeenCalledTimes(2)

    togglePanel.mockReturnValueOnce(false)
    nativeTray!.emit('click', { altKey: false, ctrlKey: false }, bounds)
    expect(hidePanel).toHaveBeenCalledTimes(3)
    expect(nativeTray!.popUpContextMenu).toHaveBeenCalledTimes(3)
  })
})
