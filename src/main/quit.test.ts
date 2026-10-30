import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import type { QuitRequest } from '@shared/ipc'

const electron = vi.hoisted(() => {
  const appEvents = new Map<string, (event: { preventDefault(): void }) => void>()
  return {
    appEvents,
    windows: [] as unknown[],
    focused: null as unknown,
    app: {
      name: 'Kettu',
      isPackaged: false,
      on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
        appEvents.set(name, listener)
      },
      quit: vi.fn(),
    },
    dialog: { showMessageBox: vi.fn() },
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  dialog: electron.dialog,
  BrowserWindow: {
    getAllWindows: () => electron.windows,
    getFocusedWindow: () => electron.focused,
  },
  nativeTheme: {},
  screen: {},
  shell: {},
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const { describeWork, QuitFlow } = await import('./quit')

class FakeContents extends EventEmitter {
  id = 1
  sent: [string, unknown][] = []
  destroyed = false
  send(channel: string, payload: unknown): void {
    this.sent.push([channel, payload])
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isLoadingMainFrame(): boolean {
    return false
  }
}

class FakeWindow extends EventEmitter {
  webContents = new FakeContents()
  isDestroyed(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  restore(): void {}
  show(): void {}
  focus(): void {}
}

const session = { sessionId: 's1', agentId: 'codex' as const, title: 'Fix the flaky test' }
const terminal = { id: 't1', projectPath: '/p', title: 'node' }
const unsaved = { projectPath: '/p', path: 'src/a.ts' }

function setup(
  options: {
    busy?: boolean
    confirm?: boolean
    window?: boolean
    moves?: boolean
    background?: boolean
  } = {},
) {
  const settings: SettingsFile = structuredClone(DEFAULT_SETTINGS)
  settings.general.confirmQuitWhileRunning = options.confirm ?? true
  settings.general.background = options.background ?? false
  const window = new FakeWindow()
  electron.windows = options.window === false ? [] : [window]
  const calls: string[] = []
  const flow = new QuitFlow({
    settings: () => settings,
    busySessions: async () => (options.busy ? [session] : []),
    busyTerminals: async () => (options.busy ? [terminal] : []),
    shutDown: async () => {
      calls.push('shutDown')
    },
    installUpdate: async () => {
      calls.push('installUpdate')
    },
    moveApp: async () => {
      // Electron's move fires before-quit itself, as a quit from the menu would.
      calls.push(beforeQuit() ? 'moveApp, before-quit held' : 'moveApp, before-quit passed')
      return options.moves ?? true
    },
  })
  const beforeQuit = (): boolean => {
    let prevented = false
    electron.appEvents.get('before-quit')!({ preventDefault: () => (prevented = true) })
    return prevented
  }
  const question = (): QuitRequest | undefined =>
    window.webContents.sent.find(([channel]) => channel === 'app:confirm-quit')?.[1] as
      QuitRequest | undefined
  return { flow, window, calls, beforeQuit, question }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const platform = process.platform

describe('QuitFlow', () => {
  beforeEach(() => {
    electron.app.quit.mockReset()
    electron.dialog.showMessageBox.mockReset()
    electron.focused = null
  })
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('stops the hosts and quits when nothing is running', async () => {
    const { calls, beforeQuit, question } = setup()
    expect(beforeQuit()).toBe(true)
    await settle()
    expect(question()).toBeUndefined()
    expect(calls).toEqual(['shutDown'])
    expect(electron.app.quit).toHaveBeenCalledOnce()
    expect(beforeQuit()).toBe(false)
  })

  it('asks the window while work is running and quits once confirmed', async () => {
    const { flow, calls, beforeQuit, question } = setup({ busy: true })
    beforeQuit()
    await settle()
    expect(question()).toEqual({
      id: 1,
      reason: 'quit',
      sessions: [session],
      terminals: [terminal],
      unsaved: [],
    })
    expect(calls).toEqual([])
    flow.respond(1, true)
    await settle()
    expect(calls).toEqual(['shutDown'])
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })

  it('stays open when the user cancels, and can ask again', async () => {
    const { flow, window, calls, beforeQuit } = setup({ busy: true })
    beforeQuit()
    await settle()
    flow.respond(1, false)
    await settle()
    expect(calls).toEqual([])
    expect(electron.app.quit).not.toHaveBeenCalled()
    beforeQuit()
    await settle()
    expect(
      window.webContents.sent.filter(([channel]) => channel === 'app:confirm-quit'),
    ).toHaveLength(2)
  })

  it('ignores a second quit while it is asking, and stale answers', async () => {
    const { flow, window, calls, beforeQuit } = setup({ busy: true })
    beforeQuit()
    await settle()
    beforeQuit()
    await settle()
    expect(window.webContents.sent).toHaveLength(1)
    flow.respond(99, true)
    await settle()
    expect(calls).toEqual([])
  })

  it('does not ask when the setting is off', async () => {
    const { calls, beforeQuit, question } = setup({ busy: true, confirm: false })
    beforeQuit()
    await settle()
    expect(question()).toBeUndefined()
    expect(calls).toEqual(['shutDown'])
  })

  it('does not ask while the system shuts down', async () => {
    const { flow, calls, beforeQuit, question } = setup({ busy: true })
    flow.systemShutdown()
    beforeQuit()
    await settle()
    expect(question()).toBeUndefined()
    expect(calls).toEqual(['shutDown'])
  })

  it('asks natively without a window', async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const { calls, beforeQuit } = setup({ busy: true, window: false })
    beforeQuit()
    await settle()
    await settle()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(electron.dialog.showMessageBox.mock.calls[0][0]).toMatchObject({
      message: 'Quit Kettu?',
      buttons: ['Cancel', 'Quit'],
    })
    expect(calls).toEqual(['shutDown'])
  })

  it('asks natively when the page has no listener', async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    const { flow, window, calls, beforeQuit } = setup({ busy: true })
    beforeQuit()
    await settle()
    flow.unhandled(1, window.webContents as never)
    await settle()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(calls).toEqual([])
  })

  it('asks natively when the page goes away before answering', async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const { window, calls, beforeQuit } = setup({ busy: true })
    beforeQuit()
    await settle()
    window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    await settle()
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await settle()
    await settle()
    expect(calls).toEqual(['shutDown'])
  })

  it('installs the update instead of quitting for a restart', async () => {
    const { flow, calls, question } = setup({ busy: true })
    flow.request('update')
    await settle()
    expect(question()?.reason).toBe('update')
    flow.respond(1, true)
    await settle()
    expect(calls).toEqual(['shutDown', 'installUpdate'])
    expect(electron.app.quit).not.toHaveBeenCalled()
  })

  it('moves the app before the hosts stop, asking as a restart to update does', async () => {
    const { flow, calls, question } = setup({ busy: true })
    flow.request('move')
    await settle()
    expect(question()?.reason).toBe('update')
    expect(calls).toEqual([])
    flow.respond(1, true)
    await settle()
    expect(calls).toEqual(['moveApp, before-quit held', 'shutDown'])
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })

  it('stops nothing when the app is not moved, and can quit later', async () => {
    const { flow, calls, beforeQuit } = setup({ moves: false })
    flow.request('move')
    await settle()
    expect(calls).toEqual(['moveApp, before-quit held'])
    expect(electron.app.quit).not.toHaveBeenCalled()
    expect(beforeQuit()).toBe(true)
    await settle()
    expect(calls).toEqual(['moveApp, before-quit held', 'shutDown'])
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })

  it('asks about unsaved files whatever the setting says, until the page goes away', async () => {
    const { flow, window, calls, beforeQuit, question } = setup({ confirm: false })
    flow.setUnsaved(window.webContents as never, [unsaved])
    beforeQuit()
    await settle()
    expect(question()).toMatchObject({ reason: 'quit', sessions: [], unsaved: [unsaved] })
    flow.respond(1, false)
    await settle()
    expect(calls).toEqual([])
    window.webContents.emit('destroyed')
    beforeQuit()
    await settle()
    expect(calls).toEqual(['shutDown'])
  })

  it('names unsaved files when it asks natively', async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const { flow, window, calls, beforeQuit } = setup()
    flow.setUnsaved(window.webContents as never, [unsaved])
    electron.windows = []
    beforeQuit()
    await settle()
    await settle()
    expect(electron.dialog.showMessageBox.mock.calls[0][0]).toMatchObject({
      detail: '1 file has unsaved changes: a.ts.\nQuitting loses them.',
      buttons: ['Cancel', 'Quit without saving'],
    })
    expect(calls).toEqual(['shutDown'])
  })

  // On macOS closing the window keeps the app running, but drops the page's unsaved edits.
  it.runIf(process.platform === 'darwin')(
    'asks before closing a window with unsaved files, and closes it once confirmed',
    async () => {
      const { flow, window, calls, question } = setup()
      const close = vi.fn(() => window.emit('close', { preventDefault: () => {} }))
      Object.assign(window, { close })
      flow.watchWindow(window as never)
      let prevented = false
      window.emit('close', { preventDefault: () => (prevented = true) })
      expect(prevented).toBe(false)
      flow.setUnsaved(window.webContents as never, [unsaved])
      window.emit('close', { preventDefault: () => (prevented = true) })
      await settle()
      expect(prevented).toBe(true)
      expect(question()).toMatchObject({ reason: 'close', unsaved: [unsaved] })
      flow.respond(1, true)
      await settle()
      expect(close).toHaveBeenCalledOnce()
      expect(calls).toEqual([])
    },
  )

  // Closing the last window only closes it on macOS, where the app keeps running.
  it.skipIf(process.platform === 'darwin')(
    'routes closing the last window through the flow',
    () => {
      const { flow, window } = setup()
      flow.watchWindow(window as never)
      let prevented = false
      window.emit('close', { preventDefault: () => (prevented = true) })
      expect(prevented).toBe(true)
    },
  )

  it.each(['win32', 'linux'] as const)(
    'on %s quits as the last window closes only while Kettu does not run in the background',
    (system) => {
      Object.defineProperty(process, 'platform', { value: system })
      for (const background of [false, true]) {
        const { flow, window, calls } = setup({ background })
        flow.watchWindow(window as never)
        let prevented = false
        window.emit('close', { preventDefault: () => (prevented = true) })
        expect(prevented).toBe(!background)
        expect(calls).toEqual([])
      }
    },
  )

  it.each(['win32', 'linux'] as const)(
    'on %s asks before the last window closes with unsaved files while in the background',
    async (system) => {
      Object.defineProperty(process, 'platform', { value: system })
      const { flow, window, calls, question } = setup({ background: true })
      const close = vi.fn(() => window.emit('close', { preventDefault: () => {} }))
      Object.assign(window, { close })
      flow.watchWindow(window as never)
      flow.setUnsaved(window.webContents as never, [unsaved])
      let prevented = false
      window.emit('close', { preventDefault: () => (prevented = true) })
      await settle()
      expect(prevented).toBe(true)
      expect(question()).toMatchObject({ reason: 'close', unsaved: [unsaved] })
      flow.respond(1, true)
      await settle()
      expect(close).toHaveBeenCalledOnce()
      expect(calls).toEqual([])
      expect(electron.app.quit).not.toHaveBeenCalled()
    },
  )
})

describe('describeWork', () => {
  it('names the sessions and terminals', () => {
    expect(describeWork([session], [terminal, { ...terminal, title: 'pnpm' }], false)).toBe(
      '1 session is working: Fix the flaky test.\n2 terminals are running: node, pnpm.\n' +
        'Quitting stops them.',
    )
    expect(describeWork([{ ...session, title: null }], [], true)).toBe(
      '1 session is working: Untitled session.\n' +
        'They stop for the restart. Your sessions and drafts come back after it.',
    )
  })
})
