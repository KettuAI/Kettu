// The tray icon: Kettu's glyph in the macOS menu bar, the Windows notification area and the Linux
// tray, from launch until it quits. It shows whether agents run, a request waits or the host is
// down; on macOS a left click opens the menu bar panel and a right click the short menu.

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import {
  app,
  Menu,
  nativeImage,
  nativeTheme,
  systemPreferences,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron'
import type { BusyCounts } from '@shared/host-control'
import type { RemoteStatus } from '@shared/remote/status'
import { t } from './i18n'
import { createLogger } from './log'

const log = createLogger('tray')

const PORTAL_TIMEOUT_MS = 2000
// The light value of the XDG desktop portal's org.freedesktop.appearance color-scheme.
const PREFERS_LIGHT = 2
// The running dot's opacity steps in resources/tray, from full to faintest, and how long each shows.
const BREATH_STEPS = 6
const BREATH_MS = 160
// One breath: down through the steps and back up.
const BREATH = [
  ...Array.from({ length: BREATH_STEPS }, (_, i) => i),
  ...Array.from({ length: BREATH_STEPS - 2 }, (_, i) => BREATH_STEPS - 2 - i),
]

/**
 * What the icon says: nothing going on, agents running, a request waiting for the user, or the
 * agent host down.
 */
export type TrayIconState = 'idle' | 'running' | 'waiting' | 'off'

export function iconState(connected: boolean, counts: BusyCounts): TrayIconState {
  if (!connected) return 'off'
  if (counts.waiting > 0) return 'waiting'
  return counts.running > 0 ? 'running' : 'idle'
}

/**
 * Which of resources/tray's images the icon shows, `step` the running dot's step on macOS. There
 * it is a template image the system tints for each menu bar; a template carries one opacity map,
 * and the shading that reads right in white turns a murky black, so the map follows the system
 * appearance, the nearest guess at the bar's color. A template cannot carry the waiting dot's
 * fox orange, so that one image is drawn in the bar's ink for the same guess.
 */
export function trayImageName(
  platform: NodeJS.Platform,
  white: boolean,
  state: TrayIconState,
  step = 0,
): string {
  if (platform === 'darwin') {
    const ground = `tray-menubar-on-${white ? 'dark' : 'light'}`
    if (state === 'running') return `${ground}-running-${step}.png`
    if (state === 'waiting') return `${ground}-attention.png`
    return state === 'off' ? `${ground}-off.png` : `${ground}.png`
  }
  const name = `tray-${white ? 'white' : 'black'}${state === 'waiting' ? '-dot' : ''}`
  return platform === 'win32' ? `${name}.ico` : `${name}.png`
}

/** Whether `trayImageName`'s image is a template, which macOS tints for the menu bar. */
export function isTemplateImage(platform: NodeJS.Platform, state: TrayIconState): boolean {
  return platform === 'darwin' && state !== 'waiting'
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

/**
 * Windows follows the taskbar's mode, the system's rather than the apps'. macOS follows the
 * system's mode, which Kettu's own theme hides from `nativeTheme`.
 */
function whiteGlyph(platform: NodeJS.Platform, scheme: number | null): boolean {
  if (platform === 'win32') return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
  if (platform === 'linux') return linuxTrayIsWhite(process.env['XDG_CURRENT_DESKTOP'], scheme)
  if (platform === 'darwin')
    return systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'
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
  /** Brings the window forward on New session. */
  newSession(): void
  checkForUpdates(): void
  setRemoteEnabled(enabled: boolean): void
  /** Whether motion is reduced, by the setting or the system; the running dot then holds still. */
  reducedMotion(): boolean
  /** Opens or closes the menu bar panel under the icon, on macOS. */
  togglePanel?(bounds: Electron.Rectangle): void
}

export class KettuTray {
  private tray: Tray | null = null
  private counts: BusyCounts = { running: 0, waiting: 0 }
  private remote: Pick<RemoteStatus, 'state' | 'online'> = { state: 'off', online: [] }
  private connected = false
  private white = false
  private breath = 0
  private breathing: ReturnType<typeof setInterval> | null = null
  // Read once each: an image comes from disk, which the running dot would read several times a second.
  private readonly images = new Map<string, Electron.NativeImage>()
  // Only the latest theme reading applies, since the portal answers out of order.
  private reading = 0

  constructor(private readonly deps: TrayDeps) {}

  start(): void {
    // Until the portal answers, Linux takes the white glyph it falls back to.
    this.white = whiteGlyph(process.platform, null)
    this.tray = new Tray(this.image())
    this.tray.setToolTip(app.name)
    if (process.platform === 'darwin') {
      // No context menu is set, since macOS would open it on a left click as well.
      this.tray.on('click', (event, bounds) => {
        if (event.altKey || event.ctrlKey || !this.deps.togglePanel) this.popUpMenu()
        else this.deps.togglePanel(bounds)
      })
      this.tray.on('right-click', () => this.popUpMenu())
      systemPreferences.subscribeNotification(
        'AppleInterfaceThemeChangedNotification',
        () => void this.readTheme(),
      )
      systemPreferences.subscribeWorkspaceNotification(
        'NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification',
        () => this.motionChanged(),
      )
    } else if (process.platform === 'win32') {
      // A click on the Windows icon opens the window; the menu takes a right click there.
      this.tray.on('click', () => this.deps.open())
    }
    this.updateMenu()
    nativeTheme.on('updated', () => void this.readTheme())
    void this.readTheme()
  }

  setBusy(counts: BusyCounts): void {
    if (counts.running === this.counts.running && counts.waiting === this.counts.waiting) return
    this.counts = counts
    this.updateMenu()
    this.showState()
  }

  setRemote(remote: Pick<RemoteStatus, 'state' | 'online'>): void {
    if (remoteLine(remote) === remoteLine(this.remote)) return
    this.remote = remote
    this.updateMenu()
  }

  /** Whether the agent host runs; while it does not, the icon fades. */
  setConnected(connected: boolean): void {
    if (connected === this.connected) return
    this.connected = connected
    this.showState()
  }

  /** The Reduce motion setting or the system's changed. */
  motionChanged(): void {
    this.showState()
  }

  /** The menu's text follows a change of language. */
  updateMenu(): void {
    if (process.platform !== 'darwin') this.tray?.setContextMenu(this.menu())
  }

  private menu(): Menu {
    const remote = remoteLine(this.remote)
    // Where no panel shows what goes on, the menu's first lines do.
    const status: MenuItemConstructorOptions[] =
      process.platform === 'darwin'
        ? []
        : [
            { label: stateLine(this.counts), enabled: false },
            ...(remote ? [{ label: remote, enabled: false }] : []),
            { type: 'separator' },
          ]
    // The panel's and the window's own keys; a tray menu's accelerators only label the items.
    const key = (accelerator: string) => ({ accelerator, registerAccelerator: false })
    return Menu.buildFromTemplate([
      ...status,
      {
        label: t('tray.open', { name: app.name }),
        ...key('CmdOrCtrl+O'),
        click: () => this.deps.open(),
      },
      { label: t('tray.newSession'), ...key('CmdOrCtrl+N'), click: () => this.deps.newSession() },
      { type: 'separator' },
      {
        label: t('tray.remoteAccess'),
        type: 'checkbox',
        checked: remote !== null,
        click: () => this.deps.setRemoteEnabled(remote === null),
      },
      { type: 'separator' },
      { label: t('tray.checkForUpdates'), click: () => this.deps.checkForUpdates() },
      {
        label: t('tray.quit', { name: app.name }),
        ...key('CmdOrCtrl+Q'),
        click: () => this.deps.quit(),
      },
    ])
  }

  private popUpMenu(): void {
    this.tray?.popUpContextMenu(this.menu())
  }

  private state(): TrayIconState {
    return iconState(this.connected, this.counts)
  }

  /** Shows the state's image, and breathes the running dot unless motion is reduced. */
  private showState(): void {
    const breathe =
      process.platform === 'darwin' && this.state() === 'running' && !this.deps.reducedMotion()
    if (breathe && !this.breathing) {
      this.breathing = setInterval(() => {
        this.breath = (this.breath + 1) % BREATH.length
        this.tray?.setImage(this.image())
      }, BREATH_MS)
    } else if (!breathe && this.breathing) {
      clearInterval(this.breathing)
      this.breathing = null
      this.breath = 0
    }
    this.tray?.setImage(this.image())
  }

  private image(): Electron.NativeImage {
    const state = this.state()
    const name = trayImageName(process.platform, this.white, state, BREATH[this.breath])
    const cached = this.images.get(name)
    if (cached) return cached
    const image = nativeImage.createFromPath(join(imagesDir(), name))
    if (image.isEmpty()) log.warn(`The tray image ${name} is missing`)
    if (isTemplateImage(process.platform, state)) image.setTemplateImage(true)
    this.images.set(name, image)
    return image
  }

  private async readTheme(): Promise<void> {
    const reading = ++this.reading
    const scheme = process.platform === 'linux' ? await readColorScheme() : null
    const white = whiteGlyph(process.platform, scheme)
    if (reading !== this.reading || white === this.white) return
    this.white = white
    this.tray?.setImage(this.image())
  }
}
