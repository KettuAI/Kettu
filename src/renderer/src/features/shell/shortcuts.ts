// The keyboard shortcuts the dialog lists, and their key caps.

import { HISTORY_SHORTCUTS } from '@renderer/app/history'
import { formatShortcut, shortcutKeys } from '@renderer/lib/platform'

export type ShortcutGroupName = 'general' | 'sessions' | 'composer' | 'terminal'

export type ShortcutAction =
  | 'newSession'
  | 'searchSessions'
  | 'openProject'
  | 'settings'
  | 'toggleSidebar'
  | 'back'
  | 'forward'
  | 'history'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'showShortcuts'
  | 'previousSession'
  | 'nextSession'
  | 'focusPane'
  | 'answerPermission'
  | 'cancelTurn'
  | 'send'
  | 'sendNow'
  | 'newLine'
  | 'focusComposer'
  | 'addFiles'
  | 'toggleTerminal'
  | 'newTerminal'
  | 'askSelection'

export interface Shortcut {
  group: ShortcutGroupName
  action: ShortcutAction
  /** Keys joined by "+"; the last may be a range of keys such as "1-9". */
  keys: string
}

/** Every shortcut the app has, in the dialog's order; the composer's follow the send key setting. */
export function shortcutList(sendKey: 'enter' | 'mod-enter'): Shortcut[] {
  return [
    { group: 'general', action: 'newSession', keys: 'Mod+N' },
    { group: 'general', action: 'searchSessions', keys: 'Mod+K' },
    { group: 'general', action: 'openProject', keys: 'Mod+O' },
    { group: 'general', action: 'settings', keys: 'Mod+,' },
    { group: 'general', action: 'toggleSidebar', keys: 'Mod+B' },
    { group: 'general', action: 'back', keys: HISTORY_SHORTCUTS.back },
    { group: 'general', action: 'forward', keys: HISTORY_SHORTCUTS.forward },
    { group: 'general', action: 'history', keys: HISTORY_SHORTCUTS.all },
    { group: 'general', action: 'zoomIn', keys: 'Mod+=' },
    { group: 'general', action: 'zoomOut', keys: 'Mod+-' },
    { group: 'general', action: 'resetZoom', keys: 'Mod+0' },
    { group: 'general', action: 'showShortcuts', keys: 'Mod+/' },
    { group: 'sessions', action: 'previousSession', keys: 'Mod+Shift+[' },
    { group: 'sessions', action: 'nextSession', keys: 'Mod+Shift+]' },
    { group: 'sessions', action: 'focusPane', keys: 'Mod+1-9' },
    { group: 'sessions', action: 'answerPermission', keys: '1-9' },
    { group: 'sessions', action: 'cancelTurn', keys: 'Esc' },
    { group: 'composer', action: 'send', keys: sendKey === 'enter' ? 'Enter' : 'Mod+Enter' },
    {
      group: 'composer',
      action: 'sendNow',
      keys: sendKey === 'enter' ? 'Mod+Enter' : 'Mod+Shift+Enter',
    },
    { group: 'composer', action: 'newLine', keys: sendKey === 'enter' ? 'Shift+Enter' : 'Enter' },
    { group: 'composer', action: 'focusComposer', keys: 'Mod+L' },
    { group: 'composer', action: 'addFiles', keys: 'Mod+U' },
    { group: 'terminal', action: 'toggleTerminal', keys: 'Ctrl+`' },
    { group: 'terminal', action: 'newTerminal', keys: 'Ctrl+Shift+`' },
    { group: 'terminal', action: 'askSelection', keys: 'Mod+L' },
  ]
}

const KEY_RANGE = /^(\d)-(\d)$/

/** One key cap per key: the platform's symbols on macOS, words elsewhere. */
export function keyCaps(keys: string): string[] {
  return shortcutKeys(keys).flatMap((key) => {
    const range = KEY_RANGE.exec(key)
    if (range) return [`${range[1]}–${range[2]}`]
    if (key === 'Enter') return ['↵']
    return [formatShortcut(key)]
  })
}
