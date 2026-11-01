import type { Platform } from '@shared/platform'
import { i18n } from './i18n'

export const platform = window.kettu.platform
export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'

/** The web client in a browser: no main process, no window of its own to frame. */
export const isWeb = window.kettu.client === 'web'

/**
 * The window's frame: macOS's traffic lights over the content, the band beside the window controls
 * on Windows and Linux, or none in a browser.
 */
export const windowFrame: 'mac' | 'band' | 'none' = isWeb ? 'none' : isMac ? 'mac' : 'band'

/**
 * Whether a band runs across the top for the window controls, as on Windows and Linux; without
 * one, headers take the top corner as on macOS, where the traffic lights take no room in a browser.
 */
export const hasBand = windowFrame === 'band'

/** The system of the host whose paths the page shows, which in the web client is another's. */
export function hostPlatform(): Platform {
  return window.kettu.hostPlatform()
}

/** The label of the platform's main modifier, as shown in menus and tooltips. */
export const modLabel = isMac ? '⌘' : 'Ctrl+'

/** Formats a shortcut such as `Mod+Shift+[` for the platform: `⌘⇧[` or `Ctrl+Shift+[`. */
export function formatShortcut(shortcut: string): string {
  const parts = shortcut.split('+')
  if (isMac) {
    return parts
      .map((part) => {
        switch (part) {
          case 'Mod':
            return '⌘'
          case 'Shift':
            return '⇧'
          case 'Alt':
            return '⌥'
          case 'Ctrl':
            return '⌃'
          case 'Enter':
            return '↩'
          case 'Esc':
            return 'Esc'
          default:
            return part
        }
      })
      .join('')
  }
  return parts.map((part) => (part === 'Mod' ? 'Ctrl' : part)).join('+')
}

/** Whether the event carries the platform's main modifier and no other. */
export function isMod(
  event: Pick<KeyboardEvent | MouseEvent | React.KeyboardEvent, 'metaKey' | 'ctrlKey'>,
): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** The platform's file manager, in the interface language: Finder, Explorer or the file manager. */
export function fileManagerName(): string {
  return i18n.t(isMac ? 'fileManager.mac' : isWindows ? 'fileManager.windows' : 'fileManager.linux')
}
