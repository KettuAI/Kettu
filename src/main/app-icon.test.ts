import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import { APP_ICONS, type AppIcon } from '@shared/settings'
import {
  AppIconController,
  appIconFileName,
  appIconPath,
  appIconsDir,
  type AppIconDeps,
  type WindowIconTarget,
} from './app-icon'

function fakeImage(label: string, empty = false): NativeImage {
  return {
    isEmpty: () => empty,
    label,
  } as unknown as NativeImage
}

function makeDeps(
  overrides: Partial<AppIconDeps> & {
    missing?: readonly AppIcon[]
    windows?: readonly WindowIconTarget[]
  } = {},
) {
  const missing = new Set(overrides.missing ?? [])
  const setDockIcon = vi.fn<(image: NativeImage) => void>()
  const warn = vi.fn<(message: string) => void>()
  const loadImage = vi.fn<(filePath: string) => NativeImage>((filePath) => {
    const isMissing = [...missing].some(
      (id) => filePath.endsWith(`/${id}.png`) || filePath.endsWith(`/${id}.ico`),
    )
    return fakeImage(filePath, isMissing)
  })
  const emptyImage = fakeImage('empty', true)
  const createEmptyImage = vi.fn(() => emptyImage)
  const windows = overrides.windows ?? []
  const deps: AppIconDeps = {
    platform: overrides.platform ?? 'darwin',
    isPackaged: overrides.isPackaged ?? true,
    resolvePath:
      overrides.resolvePath ?? ((icon, platform) => `/icons/${appIconFileName(icon, platform)}`),
    loadImage: overrides.loadImage ?? loadImage,
    createEmptyImage: overrides.createEmptyImage ?? createEmptyImage,
    setDockIcon: overrides.setDockIcon ?? setDockIcon,
    getWindows: overrides.getWindows ?? (() => windows),
    warn: overrides.warn ?? warn,
  }
  return { deps, setDockIcon, warn, loadImage, createEmptyImage, emptyImage }
}

function fakeWindow(destroyed = false) {
  const setIcon = vi.fn<(icon: string | NativeImage) => void>()
  return {
    isDestroyed: () => destroyed,
    setIcon,
  }
}

describe('app icon resource paths', () => {
  it('resolves dev and packaged directories and platform-specific extensions', () => {
    expect(
      appIconsDir({ isPackaged: false, appPath: '/repo', resourcesPath: '/app/Resources' }),
    ).toBe(join('/repo', 'resources', 'app-icons'))
    expect(
      appIconsDir({ isPackaged: true, appPath: '/repo', resourcesPath: '/app/Resources' }),
    ).toBe(join('/app/Resources', 'app-icons'))

    expect(appIconFileName('ink-sheets', 'darwin')).toBe('ink-sheets.png')
    expect(appIconFileName('ink-sheets', 'linux')).toBe('ink-sheets.png')
    expect(appIconFileName('ink-sheets', 'win32')).toBe('ink-sheets.ico')

    expect(
      appIconPath('paper', 'win32', {
        isPackaged: true,
        appPath: '/repo',
        resourcesPath: '/app/Resources',
      }),
    ).toBe(join('/app/Resources', 'app-icons', 'paper.ico'))
  })

  it('ships non-empty PNG and ICO assets for all six app icons', () => {
    const repoRoot = resolve(import.meta.dirname, '../..')
    for (const icon of APP_ICONS) {
      for (const platform of ['darwin', 'win32'] as const) {
        const file = appIconPath(icon, platform, {
          isPackaged: false,
          appPath: repoRoot,
          resourcesPath: repoRoot,
        })
        expect(existsSync(file), `missing ${file}`).toBe(true)
        expect(statSync(file).size).toBeGreaterThan(0)
      }
    }
  })
})

describe('AppIconController on macOS', () => {
  it('keeps the signed bundle icon on packaged startup with kettu and restores it on reset', () => {
    const { deps, setDockIcon, emptyImage, loadImage } = makeDeps({
      platform: 'darwin',
      isPackaged: true,
    })
    const controller = new AppIconController(deps)

    controller.apply('kettu')
    expect(setDockIcon).not.toHaveBeenCalled()
    expect(controller.windowIcon()).toBeNull()

    controller.apply('ink')
    expect(setDockIcon).toHaveBeenCalledTimes(1)
    expect((setDockIcon.mock.calls[0]![0] as unknown as { label: string }).label).toBe(
      '/icons/ink.png',
    )

    controller.apply('kettu')
    expect(setDockIcon).toHaveBeenCalledTimes(2)
    expect(setDockIcon.mock.calls[1]![0]).toBe(emptyImage)

    // Already restored to default: no redundant reset call.
    controller.apply('default')
    expect(setDockIcon).toHaveBeenCalledTimes(2)
    expect(loadImage).toHaveBeenCalledTimes(1)
  })

  it('applies a persisted non-default icon on packaged startup and caches loaded images', () => {
    const { deps, setDockIcon, loadImage } = makeDeps({
      platform: 'darwin',
      isPackaged: true,
    })
    const controller = new AppIconController(deps)

    controller.apply('paper-sheets')
    controller.apply('orange-flat')
    controller.apply('paper-sheets')

    expect(setDockIcon).toHaveBeenCalledTimes(3)
    expect(loadImage).toHaveBeenCalledTimes(2)
  })

  it('always sets the kettu Dock icon in unpackaged dev builds', () => {
    const { deps, setDockIcon } = makeDeps({
      platform: 'darwin',
      isPackaged: false,
    })
    const controller = new AppIconController(deps)

    controller.apply('kettu')
    expect(setDockIcon).toHaveBeenCalledTimes(1)
    expect((setDockIcon.mock.calls[0]![0] as unknown as { label: string }).label).toBe(
      '/icons/kettu.png',
    )

    controller.apply('ink')
    controller.apply('kettu')
    expect(setDockIcon).toHaveBeenCalledTimes(3)
    expect((setDockIcon.mock.calls[2]![0] as unknown as { label: string }).label).toBe(
      '/icons/kettu.png',
    )
  })
})

describe('AppIconController on Windows and Linux', () => {
  it('updates every live window with .ico on Windows and provides the matching creation icon', () => {
    const liveA = fakeWindow(false)
    const dead = fakeWindow(true)
    const liveB = fakeWindow(false)
    const { deps, setDockIcon } = makeDeps({
      platform: 'win32',
      isPackaged: true,
      windows: [liveA, dead, liveB],
    })
    const controller = new AppIconController(deps)

    controller.apply('ink-sheets')
    expect(setDockIcon).not.toHaveBeenCalled()
    expect(liveA.setIcon).toHaveBeenCalledTimes(1)
    expect(liveB.setIcon).toHaveBeenCalledTimes(1)
    expect(dead.setIcon).not.toHaveBeenCalled()
    expect((liveA.setIcon.mock.calls[0]![0] as unknown as { label: string }).label).toBe(
      '/icons/ink-sheets.ico',
    )

    const initial = controller.windowIcon()
    expect((initial as unknown as { label: string }).label).toBe('/icons/ink-sheets.ico')

    controller.apply('kettu')
    expect(liveA.setIcon).toHaveBeenCalledTimes(2)
    expect((liveA.setIcon.mock.calls[1]![0] as unknown as { label: string }).label).toBe(
      '/icons/kettu.ico',
    )
  })

  it('uses PNG icons on Linux and falls back to kettu if an alternate file is missing', () => {
    const win = fakeWindow(false)
    const { deps, warn } = makeDeps({
      platform: 'linux',
      isPackaged: true,
      windows: [win],
      missing: ['paper'],
    })
    const controller = new AppIconController(deps)

    controller.apply('paper')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(win.setIcon).toHaveBeenCalledTimes(1)
    expect((win.setIcon.mock.calls[0]![0] as unknown as { label: string }).label).toBe(
      '/icons/kettu.png',
    )
  })
})
