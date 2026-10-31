// The tray icon: Kettu's glyph in the macOS menu bar, the Windows notification area and the Linux
// tray, from launch until it quits, with a dot while a permission request waits.

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app, Menu, nativeImage, nativeTheme, Tray } from 'electron'
import type { BusyCounts } from '@shared/host-control'
import type { RemoteStatus } from '@shared/remote/status'
import { t } from './i18n'
import { createLogger } from './log'

const log = createLogger('tray')

const PORTAL_TIMEOUT_MS = 2000
// The light value of the XDG desktop portal's org.freedesktop.appearance color-scheme.
const PREFERS_LIGHT = 2

/**
 * Which of resources/tray's images the icon shows. The macOS menu bar always takes the white
 * glyph untinted: a template image carries one opacity map, and the shading that reads right in
 * white turns a murky black on light bars.
 */
export function trayImageName(platform: NodeJS.Platform, white: boolean, dot: boolean): string {
  if (platform === 'darwin') return dot ? 'tray-menubar-dot.png' : 'tray-menubar.png'
  const name = `tray-${white ? 'white' : 'black'}${dot ? '-dot' : ''}`
  return platform === 'win32' ? `${name}.ico` : `${name}.png`
}

/** The color scheme in gdbus's reply to the portal, or null when it holds none. */
export function parseColorScheme(reply: string): number | null {
  const match = /uint32 (\d+)/.exec(reply)
  return match ? Number(match[1]) : null
}

/**
 * Linux trays tint nothing, so the glyph is black only where the desktop prefers light and is not
 * GNOME, whose top bar is dark in both schemes.
 */
export function linuxTrayIsWhite(
  currentDesktop: string | undefined,
  scheme: number | null,
): boolean {
  const gnome = (currentDesktop ?? '').split(':').some((name) => name.toUpperCase() === 'GNOME')
  return gnome || scheme !== PREFERS_LIGHT
}

/** The menu's first line: how many sessions run and how many of them need approval. */
export function stateLine(counts: BusyCounts): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(t('tray.running', { count: counts.running }))
  if (counts.waiting > 0) parts.push(t('tray.waiting', { count: counts.waiting }))
  return parts.length > 0 ? parts.join(' · ') : t('tray.noneRunning')
}

/** Remote access's line while it is on: whether it runs and how many devices are online. */
export function remoteLine(status: Pick<RemoteStatus, 'state' | 'online'>): string | null {
  switch (status.state) {
    case 'off':
      return null
    case 'starting':
      return t('tray.remoteStarting')
    case 'failed':
      return t('tray.remoteFailed')
    case 'on':
      return t('tray.remoteOn', { count: status.online.length })
  }
}

function callPortal(method: 'ReadOne' | 'Read'): Promise<string | null> {
  const args = [
    'call',
    '--session',
    '--dest',
    'org.freedesktop.portal.Desktop',
    '--object-path',
    '/org/freedesktop/portal/desktop',
    '--method',
    `org.freedesktop.portal.Settings.${method}`,
    'org.freedesktop.appearance',
    'color-scheme',
  ]
  return new Promise((resolve) => {
    execFile('gdbus', args, { timeout: PORTAL_TIMEOUT_MS }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })
}

/**
 * Kettu's own theme sets `nativeTheme.themeSource`, so `shouldUseDarkColors` cannot tell the
 * desktop's scheme; the portal can. Portals before version 2 have only the deprecated Read.
 */
async function readColorScheme(): Promise<number | null> {
  const reply = (await callPortal('ReadOne')) ?? (await callPortal('Read'))
  return reply === null ? null : parseColorScheme(reply)
}

/** Windows follows the taskbar's mode, the system's rather than the apps'; macOS tints it itself. */
function whiteGlyph(platform: NodeJS.Platform, scheme: number | null): boolean {
  if (platform === 'win32') return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
  if (platform === 'linux') return linuxTrayIsWhite(process.env['XDG_CURRENT_DESKTOP'], scheme)
  return false
}

function imagesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray')
    : join(app.getAppPath(), 'resources', 'tray')
}

export interface TrayDeps {
  /** Shows the last window, or opens one when none is left. */
  open(): void
  /** Runs the quit flow, as `Cmd+Q` does. */
  quit(): void
}

export class KettuTray {
  private tray: Tray | null = null
  private counts: BusyCounts = { running: 0, waiting: 0 }
  private remote: Pick<RemoteStatus, 'state' | 'online'> = { state: 'off', online: [] }
  private dot = false
  private white = false
  // Only the latest theme reading applies, since the portal answers out of order.
  private reading = 0

  constructor(private readonly deps: TrayDeps) {}

  start(): void {
    // Until the portal answers, Linux takes the white glyph it falls back to.
    this.white = whiteGlyph(process.platform, null)
    this.tray = new Tray(this.image())
    this.tray.setToolTip(app.name)
    // A click on the Windows icon opens the window; the menu takes a right click there.
    if (process.platform === 'win32') this.tray.on('click', () => this.deps.open())
    this.updateMenu()
    nativeTheme.on('updated', () => void this.readTheme())
    void this.readTheme()
  }

  setBusy(counts: BusyCounts): void {
    if (counts.running === this.counts.running && counts.waiting === this.counts.waiting) return
    this.counts = counts
    this.updateMenu()
  }

  setRemote(remote: Pick<RemoteStatus, 'state' | 'online'>): void {
    if (remoteLine(remote) === remoteLine(this.remote)) return
    this.remote = remote
    this.updateMenu()
  }

  setDot(dot: boolean): void {
    if (dot === this.dot) return
    this.dot = dot
    this.tray?.setImage(this.image())
  }

  /** The menu's text follows a change of language. */
  updateMenu(): void {
    const remote = remoteLine(this.remote)
    this.tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: stateLine(this.counts), enabled: false },
        ...(remote ? [{ label: remote, enabled: false }] : []),
        { type: 'separator' },
        { label: t('tray.open', { name: app.name }), click: () => this.deps.open() },
        { label: t('tray.quit', { name: app.name }), click: () => this.deps.quit() },
      ]),
    )
  }

  private image(): Electron.NativeImage {
    const image = nativeImage.createFromPath(
      join(imagesDir(), trayImageName(process.platform, this.white, this.dot)),
    )
    if (image.isEmpty()) log.warn('The tray image is missing')
    return image
  }

  private async readTheme(): Promise<void> {
    if (process.platform === 'darwin') return
    const reading = ++this.reading
    const scheme = process.platform === 'linux' ? await readColorScheme() : null
    const white = whiteGlyph(process.platform, scheme)
    if (reading !== this.reading || white === this.white) return
    this.white = white
    this.tray?.setImage(this.image())
  }
}
