import type { Session, WebContents } from 'electron'

// The only permissions the renderer uses: the clipboard buttons write text and the terminal's
// paste reads it.
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
])

export interface PermissionContext {
  /** The URL of the frame that asks, when Electron knows it. */
  url: string | undefined
  isMainFrame: boolean
  /** The devices a `media` request asks for: none when it captures a window or a screen. */
  mediaTypes?: readonly string[]
}

/**
 * Whether a web permission is granted: only the clipboard ones, and only to the app's own page,
 * in its main frame. Everything else, such as notifications, media and geolocation, is denied.
 * While an agent uses the computer (`capturing`), that page may also capture what is on screen,
 * never a camera or a microphone, for the pane that shows the agent's window; which window it
 * gets is the display media handler's choice.
 */
export function isPermissionAllowed(
  permission: string,
  context: PermissionContext,
  isOwnUrl: (url: string | undefined) => boolean,
  capturing = false,
): boolean {
  if (!context.isMainFrame || !isOwnUrl(context.url)) return false
  if (ALLOWED_PERMISSIONS.has(permission)) return true
  return permission === 'media' && capturing && context.mediaTypes?.length === 0
}

/**
 * Denies every permission the app does not need. Electron grants all of them to a session that
 * has no handler, and the check handler is the one the web APIs ask first. A page the frame guard
 * does not trust now, as while a new frame is pending, gets nothing; nor does an artifact's frame,
 * which is never the app's page.
 */
export function restrictPermissions(
  session: Session,
  isOwnUrl: (url: string | undefined) => boolean,
  isFramed: (webContents: WebContents) => boolean,
  capturing: () => boolean = () => false,
): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(
      !isFramed(webContents) &&
        isPermissionAllowed(
          permission,
          { url: details.requestingUrl, isMainFrame: details.isMainFrame, mediaTypes },
          isOwnUrl,
          capturing(),
        ),
    )
  })
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return (
      webContents !== null &&
      !isFramed(webContents) &&
      isPermissionAllowed(
        permission,
        { url: details.requestingUrl ?? requestingOrigin, isMainFrame: details.isMainFrame },
        isOwnUrl,
      )
    )
  })
  // Devices (USB, HID, serial) are never granted, whatever was chosen before.
  session.setDevicePermissionHandler(() => false)
}
