export const platform = window.overbench.platform
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
export function isMod(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export const fileManagerName = isMac ? 'Finder' : isWindows ? 'Explorer' : 'the file manager'
