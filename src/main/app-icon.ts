// Runtime app icon management: updates the macOS Dock icon and Windows/Linux window icons without
// modifying signed application bundles on disk.

import { join } from 'node:path'
import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { DEFAULT_SETTINGS, normalizeAppIcon, type AppIcon } from '@shared/settings'
import { createLogger } from './log'

const log = createLogger('app-icon')

export interface AppIconPaths {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

/** Directory containing the runtime app icon assets in both dev and packaged builds. */
export function appIconsDir(paths?: Partial<AppIconPaths>): string {
  const isPackaged = paths?.isPackaged ?? app.isPackaged
  return isPackaged
    ? join(paths?.resourcesPath ?? process.resourcesPath, 'app-icons')
    : join(paths?.appPath ?? app.getAppPath(), 'resources', 'app-icons')
}

/** File name for `icon` on `platform`: multi-size `.ico` on Windows, 512 px PNG elsewhere. */
export function appIconFileName(icon: AppIcon, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${icon}.ico` : `${icon}.png`
}

/** Full path on disk for `icon` on `platform`. */
export function appIconPath(
  icon: AppIcon,
  platform: NodeJS.Platform,
  paths?: Partial<AppIconPaths>,
): string {
  return join(appIconsDir(paths), appIconFileName(icon, platform))
}

export type WindowIconTarget = Pick<BrowserWindow, 'isDestroyed' | 'setIcon'>

export interface AppIconDeps {
  platform: NodeJS.Platform
  isPackaged: boolean
  resolvePath: (icon: AppIcon, platform: NodeJS.Platform) => string
  loadImage: (filePath: string) => NativeImage
  createEmptyImage: () => NativeImage
  setDockIcon: (image: NativeImage) => void
  getWindows: () => readonly WindowIconTarget[]
  warn: (message: string) => void
}

/**
 * Applies the selected app icon to the macOS Dock or to every live Windows/Linux app window, and
 * supplies the matching initial icon when creating new windows.
 */
export class AppIconController {
  private selected: AppIcon = DEFAULT_SETTINGS.appearance.appIcon
  private dockCustomized = false
  private readonly cache = new Map<string, NativeImage>()

  constructor(private readonly deps: AppIconDeps) {}

  current(): AppIcon {
    return this.selected
  }

  /** Icon image for a newly constructed BrowserWindow on Windows and Linux; null on macOS. */
  windowIcon(icon: AppIcon = this.selected): NativeImage | null {
    if (this.deps.platform === 'darwin') return null
    return this.loadWithFallback(icon)
  }

  /** Updates the Dock icon on macOS, or every open app window's icon on Windows and Linux. */
  apply(raw: AppIcon | string): void {
    const icon = normalizeAppIcon(raw) ?? DEFAULT_SETTINGS.appearance.appIcon
    this.selected = icon

    if (this.deps.platform === 'darwin') {
      if (icon === 'kettu' && this.deps.isPackaged) {
        // Leave the signed bundle icon untouched at startup; clear any prior override when
        // returning to default so macOS restores the bundle's native icon (including Liquid Glass).
        if (this.dockCustomized) {
          this.deps.setDockIcon(this.deps.createEmptyImage())
          this.dockCustomized = false
        }
        return
      }
      const image = this.loadWithFallback(icon)
      if (!image) return
      this.deps.setDockIcon(image)
      this.dockCustomized = icon !== 'kettu' || !this.deps.isPackaged
      return
    }

    const image = this.loadWithFallback(icon)
    if (!image) return
    for (const window of this.deps.getWindows()) {
      if (!window.isDestroyed()) window.setIcon(image)
    }
  }

  private load(icon: AppIcon): NativeImage | null {
    const key = `${this.deps.platform}:${icon}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const filePath = this.deps.resolvePath(icon, this.deps.platform)
    const image = this.deps.loadImage(filePath)
    if (image.isEmpty()) {
      this.deps.warn(`App icon image is missing or empty: ${filePath}`)
      return null
    }
    this.cache.set(key, image)
    return image
  }

  private loadWithFallback(icon: AppIcon): NativeImage | null {
    const image = this.load(icon)
    if (image) return image
    return icon === 'kettu' ? null : this.load('kettu')
  }
}

let controller: AppIconController | null = null

export function initAppIcon(getWindows: () => readonly WindowIconTarget[]): AppIconController {
  controller = new AppIconController({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resolvePath: (icon, platform) => appIconPath(icon, platform),
    loadImage: (filePath) => nativeImage.createFromPath(filePath),
    createEmptyImage: () => nativeImage.createEmpty(),
    setDockIcon: (image) => app.dock?.setIcon(image),
    getWindows,
    warn: (message) => log.warn(message),
  })
  return controller
}

export function applyAppIcon(icon: AppIcon): void {
  controller?.apply(icon)
}

export function currentWindowIcon(): NativeImage | null {
  return controller?.windowIcon() ?? null
}
