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

function setup(options: { busy?: boolean; confirm?: boolean; window?: boolean } = {}) {
  const settings: SettingsFile = structuredClone(DEFAULT_SETTINGS)
  settings.general.confirmQuitWhileRunning = options.confirm ?? true
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

describe('QuitFlow', () => {
  beforeEach(() => {
    electron.app.quit.mockReset()
    electron.dialog.showMessageBox.mockReset()
    electron.focused = null
  })
  afterEach(() => vi.useRealTimers())

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
      message: 'Quit OverBench?',
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
