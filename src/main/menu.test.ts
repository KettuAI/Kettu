import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { ZoomStep } from '@shared/settings'

const electron = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
}))

vi.mock('electron', () => ({
  app: { name: 'Kettu', isPackaged: true },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      electron.template = template
      return template
    },
    setApplicationMenu: () => {},
  },
}))
vi.mock('./events', () => ({ sendCommand: () => {}, sendEvent: () => {} }))
vi.mock('./window', () => ({ currentWindow: () => null }))

const { installMenu } = await import('./menu')
const { setLocale } = await import('./i18n')

const platform = process.platform

function deps(zoom: (step: ZoomStep) => void = () => {}) {
  return { checkForUpdates: () => {}, zoom }
}

function labels(items = electron.template): string[] {
  return items.flatMap((item) => [
    ...(item.label ? [item.label] : []),
    ...(Array.isArray(item.submenu) ? labels(item.submenu) : []),
  ])
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  setLocale('en')
})

describe('the macOS menu', () => {
  it('labels every item, roles included, in the interface language', () => {
    installMenu(deps())
    const english = labels()
    expect(english).toEqual(expect.arrayContaining(['About Kettu', 'Settings…', 'Copy']))

    setLocale('zh-CN')
    installMenu(deps())
    expect(labels()).toEqual(
      expect.arrayContaining(['关于 Kettu', '设置…', '拷贝', '退出 Kettu', '显示']),
    )
    expect(labels()).toHaveLength(english.length)

    const unlabelled = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.flatMap((item) => [
        ...(item.type !== 'separator' && !item.label ? [item] : []),
        ...(Array.isArray(item.submenu) ? unlabelled(item.submenu) : []),
      ])
    expect(unlabelled(electron.template)).toEqual([])
  })

  it('zooms from the View menu with Shift and without', () => {
    const steps: ZoomStep[] = []
    installMenu(deps((step) => steps.push(step)))
    const view = electron.template.find((item) => item.label === 'View')!
    const items = view.submenu as MenuItemConstructorOptions[]
    const zoomItems = items.filter(
      (item) => item.label?.startsWith('Zoom') || item.label === 'Reset Zoom',
    )
    expect(zoomItems.map((item) => [item.accelerator, item.visible ?? true])).toEqual([
      ['Cmd+0', true],
      ['Cmd+=', true],
      ['Cmd+-', true],
      ['Cmd+Plus', false],
      ['Cmd+_', false],
    ])
    for (const item of zoomItems) item.click?.({} as never, undefined, {} as never)
    expect(steps).toEqual([0, 1, -1, 1, -1])
  })
})
