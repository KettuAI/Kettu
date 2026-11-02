import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'

const electron = vi.hoisted(() => {
  const made: unknown[] = []
  return { made, focused: null as unknown }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Notification extends EventEmitter {
    static isSupported = (): boolean => true
    shown = false
    closed = false
    constructor(readonly options: Record<string, unknown>) {
      super()
      electron.made.push(this)
    }
    show(): void {
      this.shown = true
    }
    close(): void {
      this.closed = true
    }
  }
  return {
    BrowserWindow: { getFocusedWindow: () => electron.focused },
    Notification,
  }
})

const sendCommand = vi.fn()
vi.mock('./events', () => ({ sendCommand }))
vi.mock('./i18n', () => ({ t: (key: string) => key }))
vi.mock('./log', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }))

const { notifyAttention } = await import('./notifications')

type Shown = EventEmitter & { options: Record<string, unknown>; shown: boolean }

const permission = {
  type: 'host:attention' as const,
  sessionId: 's1',
  kind: 'permission' as const,
  title: 'Fix doubled days in usage',
  body: 'Wants to run pnpm vitest run src/usage',
  allowOnce: { requestId: 'pab-1', optionId: 'allow-once' },
}

describe('notifyAttention', () => {
  beforeEach(() => {
    electron.made.length = 0
    electron.focused = null
    sendCommand.mockReset()
  })

  it('offers Allow once and Open for a request it can allow, and answers from the first', () => {
    const allowOnce = vi.fn()
    notifyAttention(permission, DEFAULT_SETTINGS, allowOnce)
    const shown = electron.made.at(-1) as Shown
    expect(shown.shown).toBe(true)
    expect(shown.options).toMatchObject({
      title: 'Fix doubled days in usage',
      body: 'Wants to run pnpm vitest run src/usage',
      actions: [
        { type: 'button', text: 'notifications.allowOnce' },
        { type: 'button', text: 'notifications.open' },
      ],
    })
    shown.emit('action', { actionIndex: 0 })
    expect(allowOnce).toHaveBeenCalledWith('s1', 'pab-1', 'allow-once')
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('opens the session from Open or a click', () => {
    const allowOnce = vi.fn()
    notifyAttention(permission, DEFAULT_SETTINGS, allowOnce)
    ;(electron.made.at(-1) as Shown).emit('action', { actionIndex: 1 })
    notifyAttention(permission, DEFAULT_SETTINGS, allowOnce)
    ;(electron.made.at(-1) as Shown).emit('click')
    expect(allowOnce).not.toHaveBeenCalled()
    expect(sendCommand).toHaveBeenCalledTimes(2)
    expect(sendCommand).toHaveBeenCalledWith({ kind: 'open-session', sessionId: 's1' })
  })

  it('offers no actions without a request to allow, or with a malformed one', () => {
    notifyAttention({ ...permission, allowOnce: undefined }, DEFAULT_SETTINGS, vi.fn())
    expect((electron.made.at(-1) as Shown).options.actions).toBeUndefined()
    const long = { requestId: 'p'.repeat(201), optionId: 'allow-once' }
    notifyAttention({ ...permission, allowOnce: long }, DEFAULT_SETTINGS, vi.fn())
    expect((electron.made.at(-1) as Shown).options.actions).toBeUndefined()
  })

  it('stays quiet while a window is focused', () => {
    electron.focused = {}
    notifyAttention(permission, DEFAULT_SETTINGS, vi.fn())
    expect(electron.made).toEqual([])
  })
})
