import { describe, expect, it, vi } from 'vitest'
import type { AppCommand } from '@shared/ipc'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import {
  notificationsProblem,
  notifyAttention,
  notifyTest,
  type BrowserNotifications,
} from './notifications'

/** The browser's notifications with `permission`, recording what it shows. */
function fakeNotifications(permission: NotificationPermission, granted = permission) {
  const shown: {
    title: string
    options?: NotificationOptions
    close: () => void
    click: () => void
  }[] = []
  class Fake {
    static permission = permission
    static requestPermission = vi.fn(async () => {
      Fake.permission = granted
      return granted
    })
    onclick: ((event: Event) => void) | null = null
    close = vi.fn()
    constructor(title: string, options?: NotificationOptions) {
      shown.push({
        title,
        options,
        close: this.close,
        click: () => this.onclick?.(new Event('click')),
      })
    }
  }
  return { notifications: Fake as unknown as BrowserNotifications, shown, Fake }
}

const ended = { kind: 'turn-ended', sessionId: 's1', title: 'Fix the build', body: 'Done' } as const

function deps(overrides: {
  notifications: BrowserNotifications | null
  settings?: SettingsFile
  inFront?: boolean
}) {
  const opened: AppCommand[] = []
  return {
    opened,
    deps: {
      notifications: overrides.notifications,
      settings: () => overrides.settings ?? DEFAULT_SETTINGS,
      inFront: () => overrides.inFront ?? false,
      open: (command: AppCommand) => void opened.push(command),
    },
  }
}

describe("the web client's notifications", () => {
  it('shows what needs the user while the page is away, and opens its session on a click', () => {
    const { notifications, shown } = fakeNotifications('granted')
    const { deps: d, opened } = deps({ notifications })
    expect(notifyAttention(ended, d)).toBe(true)
    expect(shown).toEqual([
      expect.objectContaining({
        title: 'Fix the build',
        options: { body: 'Done', tag: 's1', silent: !DEFAULT_SETTINGS.notifications.sound },
      }),
    ])
    shown[0]!.click()
    expect(shown[0]!.close).toHaveBeenCalled()
    expect(opened).toEqual([{ kind: 'open-session', sessionId: 's1' }])
  })

  it('shows nothing in front, with its switch off, or without the permission', () => {
    const granted = fakeNotifications('granted')
    expect(
      notifyAttention(ended, deps({ notifications: granted.notifications, inFront: true }).deps),
    ).toBe(false)
    const off: SettingsFile = {
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications, turnEnded: false },
    }
    expect(
      notifyAttention(ended, deps({ notifications: granted.notifications, settings: off }).deps),
    ).toBe(false)
    expect(
      notifyAttention(
        ended,
        deps({ notifications: fakeNotifications('default').notifications }).deps,
      ),
    ).toBe(false)
    expect(notifyAttention(ended, deps({ notifications: null }).deps)).toBe(false)
    expect(granted.shown).toEqual([])
  })

  it('says why a browser shows none: plain http, or blocked for the page', () => {
    expect(notificationsProblem(null)).toBe('insecure')
    expect(notificationsProblem(fakeNotifications('denied').notifications)).toBe('denied')
    expect(notificationsProblem(fakeNotifications('granted').notifications)).toBeNull()
  })

  it('asks the browser the first time the sample is shown', async () => {
    const asked = fakeNotifications('default', 'granted')
    const text = { title: 'Kettu', body: 'On' }
    expect(await notifyTest(deps({ notifications: asked.notifications }).deps, text)).toBe(true)
    expect(asked.Fake.requestPermission).toHaveBeenCalledTimes(1)
    expect(asked.shown.map(({ title }) => title)).toEqual(['Kettu'])
    const refused = fakeNotifications('default', 'denied')
    expect(await notifyTest(deps({ notifications: refused.notifications }).deps, text)).toBe(false)
    expect(refused.shown).toEqual([])
    expect(await notifyTest(deps({ notifications: null }).deps, text)).toBe(false)
  })
})
