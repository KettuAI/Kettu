import { i18n } from './i18n'

export const platform = window.kettu.platform
export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'

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
