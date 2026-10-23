import type { Session } from 'electron'

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
}

/**
 * Whether a web permission is granted: only the clipboard ones, and only to the app's own page,
 * in its main frame. Everything else, such as notifications, media and geolocation, is denied.
 */
export function isPermissionAllowed(
  permission: string,
  context: PermissionContext,
  isOwnUrl: (url: string | undefined) => boolean,
): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && context.isMainFrame && isOwnUrl(context.url)
}

/**
 * Denies every permission the app does not need. Electron grants all of them to a session that
 * has no handler, and the check handler is the one the web APIs ask first.
 */
export function restrictPermissions(
  session: Session,
  isOwnUrl: (url: string | undefined) => boolean,
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(
      isPermissionAllowed(
        permission,
        { url: details.requestingUrl, isMainFrame: details.isMainFrame },
        isOwnUrl,
      ),
    )
  })
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return (
      webContents !== null &&
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
