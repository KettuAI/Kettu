import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

const electron = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
}))

vi.mock('electron', () => ({
  app: { name: 'OverBench', isPackaged: true },
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
    installMenu({ checkForUpdates: () => {} })
    const english = labels()
    expect(english).toEqual(expect.arrayContaining(['About OverBench', 'Settings…', 'Copy']))

    setLocale('zh-CN')
    installMenu({ checkForUpdates: () => {} })
    expect(labels()).toEqual(
      expect.arrayContaining(['关于 OverBench', '设置…', '拷贝', '退出 OverBench', '显示']),
    )
    expect(labels()).toHaveLength(english.length)

    const unlabelled = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.flatMap((item) => [
        ...(item.type !== 'separator' && !item.label ? [item] : []),
        ...(Array.isArray(item.submenu) ? unlabelled(item.submenu) : []),
      ])
    expect(unlabelled(electron.template)).toEqual([])
  })
})
