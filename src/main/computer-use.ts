// Main's side of computer use: where the driver the app ships lies, what the agent host is told
// about Kettu's own processes, and the macOS permissions Kettu holds for the driver, which
// Settings shows and asks for. The driver is Kettu's child, so its grants are Kettu's.

import { app, desktopCapturer, shell, systemPreferences, type Session } from 'electron'
import { access, constants } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  ComputerHold,
  ComputerPermission,
  ComputerPermissionKind,
  ComputerUseStatus,
} from '@shared/computer-use'

const PRIVACY_PANES: Record<ComputerPermissionKind, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

/** The `cua-driver` program: in the app's resources, or where the fetch script puts it. */
export function computerDriverPath(): string {
  const file = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const dir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(dir, 'cua-driver', file)
}

/** What the agent host's `host:init` carries for computer use. */
export function computerHostOptions(): { driverPath: string; selfPid: number; selfIds: string[] } {
  return {
    driverPath: computerDriverPath(),
    selfPid: process.pid,
    // The bundle id on macOS, the executable's name elsewhere, as the host names apps.
    selfIds: ['sh.kettu.app', basename(process.execPath).toLowerCase()],
  }
}

function screenRecording(): ComputerPermission {
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted' || status === 'denied' || status === 'not-determined') return status
  return status === 'restricted' ? 'denied' : 'unknown'
}

function sessionType(): ComputerUseStatus['sessionType'] {
  const type = process.env.XDG_SESSION_TYPE?.toLowerCase()
  if (type === 'x11' || type === 'wayland') return type
  if (process.env.WAYLAND_DISPLAY) return 'wayland'
  return process.env.DISPLAY ? 'x11' : null
}

/** This computer as Settings › Computer use shows it. */
export async function computerUseStatus(): Promise<ComputerUseStatus> {
  const driver = await access(computerDriverPath(), constants.X_OK).then(
    () => true,
    () => false,
  )
  const mac = process.platform === 'darwin'
  const linux = process.platform === 'linux'
  return {
    driver,
    // Without a prompt the check cannot tell a refusal from no answer yet.
    accessibility: mac
      ? systemPreferences.isTrustedAccessibilityClient(false)
        ? 'granted'
        : 'not-determined'
      : null,
    screenRecording: mac ? screenRecording() : null,
    sessionType: linux ? sessionType() : null,
    desktop: linux ? (process.env.XDG_CURRENT_DESKTOP ?? null) : null,
  }
}

/**
 * Asks macOS for a permission: its own prompt the first time, and the pane in System Settings
 * where the user turns Kettu on, since a refused permission is never asked again.
 */
export async function requestComputerPermission(kind: ComputerPermissionKind): Promise<void> {
  if (process.platform !== 'darwin') return
  if (kind === 'accessibility') {
    if (systemPreferences.isTrustedAccessibilityClient(true)) return
  } else {
    const status = screenRecording()
    if (status === 'granted') return
    if (status === 'not-determined') {
      // Asking for the screen's sources is what raises the Screen Recording prompt.
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      })
      return
    }
  }
  await shell.openExternal(PRIVACY_PANES[kind])
}

/** Icons already read, by path: a session's label asks again on every app it moves to. */
const icons = new Map<string, Promise<string | null>>()
const ICONS_KEPT = 64

/** The icon of the app at `path` as a data URL, for a session's label; null when there is none. */
export function computerAppIcon(path: string): Promise<string | null> {
  let icon = icons.get(path)
  if (!icon) {
    icon = app.getFileIcon(path, { size: 'normal' }).then(
      (image) => (image.isEmpty() ? null : image.toDataURL()),
      () => null,
    )
    icons.set(path, icon)
    if (icons.size > ICONS_KEPT) icons.delete(icons.keys().next().value!)
  }
  return icon
}

/**
 * The Computer pane's live picture: a page's request to capture the screen gets the one window the
 * session holding the computer uses, picked here and never by the page, and only the window's own
 * page asks with any effect. The picture stays in that page; nothing sends it on.
 */
export function serveComputerCapture(
  session: Session,
  hold: () => ComputerHold | null,
  isOwnPage: (url: string | undefined) => boolean,
): void {
  session.setDisplayMediaRequestHandler(
    (request, callback) => {
      const window = hold()?.window
      const frame = request.frame
      if (!window || !frame || frame.parent !== null || !isOwnPage(frame.url)) {
        callback(null)
        return
      }
      desktopCapturer
        .getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          // A source is named `window:<id>:<n>`, its id the one the driver gives the window.
          const source = sources.find((found) => found.id.startsWith(`window:${window.id}:`))
          callback(source && hold()?.window?.id === window.id ? { video: source } : null)
        })
        .catch(() => callback(null))
    },
    { useSystemPicker: false },
  )
}
