import type { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'

const state = vi.hoisted(() => ({
  appEmitter: null as EventEmitter | null,
  quit: vi.fn(),
  relaunch: vi.fn(),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number }>>(async () => ({
    response: 1,
  })),
  sendEvent: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const emitter = (state.appEmitter ??= new Emitter())
  const app = Object.assign(emitter, {
    name: 'Kettu',
    quit: (...args: unknown[]) => state.quit(...args),
    relaunch: (...args: unknown[]) => state.relaunch(...args),
  })
  return {
    app,
    BrowserWindow: {
      getAllWindows: () => [],
      getFocusedWindow: () => null,
    },
    dialog: {
      showMessageBox: (...args: unknown[]) => state.showMessageBox(...args),
    },
  }
})

vi.mock('./events', () => ({
  sendEvent: (...args: unknown[]) => state.sendEvent(...args),
}))

vi.mock('./window', () => ({
  currentWindow: () => null,
  hideOnClose: vi.fn(),
  hidesOnClose: () => false,
  isHiddenOnClose: () => false,
}))

const { QuitFlow } = await import('./quit')

function makeSettings(overrides?: Partial<SettingsFile['general']>): SettingsFile {
  return {
    ...DEFAULT_SETTINGS,
    general: {
      ...DEFAULT_SETTINGS.general,
      ...overrides,
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}

const BUSY_SESSION = {
  sessionId: 's1',
  agentId: 'codex' as const,
  title: 'Working',
  turnStartedAt: 1,
  background: null,
}

describe('QuitFlow clean-exit hook', () => {
  beforeEach(() => {
    state.appEmitter?.removeAllListeners()
    state.quit.mockReset()
    state.relaunch.mockReset()
    state.showMessageBox.mockReset()
    state.sendEvent.mockReset()
  })

  it('does not call onCleanExit when the user cancels quitting', async () => {
    state.showMessageBox.mockResolvedValue({ response: 0 })
    const onCleanExit = vi.fn()
    const shutDown = vi.fn(async () => {})
    const flow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: true }),
      busySessions: async () => [BUSY_SESSION],
      busyTerminals: async () => [],
      shutDown,
      onCleanExit,
      installUpdate: async () => {},
      moveApp: async () => false,
      restartWhenIdle: vi.fn(),
    })

    expect(flow.request('quit')).toBe(true)
    await flushMicrotasks()

    expect(onCleanExit).not.toHaveBeenCalled()
    expect(shutDown).not.toHaveBeenCalled()
    expect(state.quit).not.toHaveBeenCalled()
    expect(flow.quitting).toBe(false)
  })

  it('does not call onCleanExit when quitting turns into running in the background', async () => {
    state.showMessageBox.mockResolvedValue({ response: 2 })
    const onCleanExit = vi.fn()
    const flow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: true }),
      busySessions: async () => [BUSY_SESSION],
      busyTerminals: async () => [],
      shutDown: vi.fn(async () => {}),
      onCleanExit,
      installUpdate: async () => {},
      moveApp: async () => false,
      restartWhenIdle: vi.fn(),
    })

    flow.request('quit')
    await flushMicrotasks()

    expect(onCleanExit).not.toHaveBeenCalled()
    expect(flow.staysInBackground).toBe(true)
    expect(flow.quitting).toBe(false)
  })

  it('does not call onCleanExit when moving the app is cancelled', async () => {
    const onCleanExit = vi.fn()
    const flow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: false }),
      busySessions: async () => [],
      busyTerminals: async () => [],
      shutDown: vi.fn(async () => {}),
      onCleanExit,
      installUpdate: async () => {},
      moveApp: async () => false,
      restartWhenIdle: vi.fn(),
    })

    flow.request('move', true)
    await flushMicrotasks()

    expect(onCleanExit).not.toHaveBeenCalled()
    expect(flow.quitting).toBe(false)
  })

  it('calls onCleanExit after shutDown and before installUpdate during an update restart', async () => {
    const order: string[] = []
    const flow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: false }),
      busySessions: async () => [],
      busyTerminals: async () => [],
      shutDown: async () => {
        order.push('shutDown')
      },
      onCleanExit: () => {
        order.push('onCleanExit')
      },
      installUpdate: async () => {
        order.push('installUpdate')
      },
      moveApp: async () => false,
      restartWhenIdle: vi.fn(),
    })

    flow.request('update', true)
    await flushMicrotasks()

    expect(order).toEqual(['shutDown', 'onCleanExit', 'installUpdate'])
    expect(flow.quitting).toBe(true)
  })

  it('skips confirmation prompts after systemShutdown and calls onCleanExit before app.quit', async () => {
    const order: string[] = []
    const busySessions = vi.fn(async () => [BUSY_SESSION])
    const flow = new QuitFlow({
      settings: () => makeSettings({ confirmQuitWhileRunning: true }),
      busySessions,
      busyTerminals: async () => [],
      shutDown: async () => {
        order.push('shutDown')
      },
      onCleanExit: () => {
        order.push('onCleanExit')
      },
      installUpdate: async () => {},
      moveApp: async () => false,
      restartWhenIdle: vi.fn(),
    })

    flow.systemShutdown()
    flow.request('quit')
    await flushMicrotasks()

    expect(busySessions).not.toHaveBeenCalled()
    expect(order).toEqual(['shutDown', 'onCleanExit'])
    expect(state.quit).toHaveBeenCalledTimes(1)
  })
})
