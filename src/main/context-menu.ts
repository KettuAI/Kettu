// Native edit and copy context menu for desktop app windows.

import {
  BrowserWindow,
  clipboard,
  Menu,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { t } from './i18n'

const MAX_SPELLING_SUGGESTIONS = 5

export interface ContextMenuClipboardState {
  /** Whether the clipboard holds any pasteable content (text, HTML, image, or file URIs). */
  hasContent: boolean
  /** Whether the clipboard holds text or rich text suitable for Paste and Match Style. */
  hasText: boolean
}

export interface ContextMenuActions {
  undo(): void
  redo(): void
  cut(): void
  copy(): void
  paste(): void
  pasteAndMatchStyle(): void
  delete(): void
  selectAll(): void
  replaceMisspelling(suggestion: string): void
}

export interface ContextMenuLabels {
  undo: string
  redo: string
  cut: string
  copy: string
  paste: string
  pasteAndMatchStyle: string
  delete: string
  selectAll: string
}

export type ContextMenuInput = Pick<
  ContextMenuParams,
  'isEditable' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'
>

export interface BuildContextMenuOptions {
  actions: ContextMenuActions
  labels?: ContextMenuLabels
  clipboard?: ContextMenuClipboardState
}

/**
 * Inspects MIME types from `clipboard.read()` so Paste stays enabled when the clipboard carries
 * only images or copied files (where Chromium may report `editFlags.canPaste === false`).
 */
export function inspectClipboardTypes(types: readonly string[]): ContextMenuClipboardState {
  let hasContent = false
  let hasText = false
  for (const raw of types) {
    const mime = raw.split(';', 1)[0]!.trim().toLowerCase()
    if (!mime) continue
    hasContent = true
    if (mime === 'text/plain' || mime === 'text/html' || mime === 'text/rtf') hasText = true
  }
  return { hasContent, hasText }
}

/** Reads available clipboard MIME types, falling back safely if the clipboard cannot be queried. */
export async function readClipboardState(
  read: () => Promise<readonly { readonly types: readonly string[] }[]> = () => clipboard.read(),
): Promise<ContextMenuClipboardState> {
  try {
    const items = await read()
    return inspectClipboardTypes(items.flatMap((item) => item.types))
  } catch {
    return { hasContent: false, hasText: false }
  }
}

/** Localized labels for native context menu edit actions, read in the active main-process locale. */
export function contextMenuLabels(): ContextMenuLabels {
  return {
    undo: t('menu.undo'),
    redo: t('menu.redo'),
    cut: t('menu.cut'),
    copy: t('menu.copy'),
    paste: t('menu.paste'),
    pasteAndMatchStyle: t('menu.pasteAndMatchStyle'),
    delete: t('menu.delete'),
    selectAll: t('menu.selectAll'),
  }
}

/**
 * Builds the native context menu template for a right-click event, or returns `null` when no menu
 * should open. Uses explicit click handlers rather than Electron roles so custom localized labels
 * are preserved and edit actions work uniformly on Windows and Linux where the application menu is
 * null.
 */
export function buildContextMenuTemplate(
  params: ContextMenuInput,
  options: BuildContextMenuOptions,
): MenuItemConstructorOptions[] | null {
  const labels = options.labels ?? contextMenuLabels()
  const { actions } = options

  if (params.isEditable) {
    const clipboardState = options.clipboard ?? { hasContent: false, hasText: false }
    const items: MenuItemConstructorOptions[] = []
    const suggestions = params.misspelledWord
      ? params.dictionarySuggestions.slice(0, MAX_SPELLING_SUGGESTIONS)
      : []

    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        items.push({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        })
      }
      items.push({ type: 'separator' })
    }

    const { editFlags } = params
    items.push(
      {
        label: labels.undo,
        enabled: editFlags.canUndo,
        click: () => actions.undo(),
      },
      {
        label: labels.redo,
        enabled: editFlags.canRedo,
        click: () => actions.redo(),
      },
      { type: 'separator' },
      {
        label: labels.cut,
        enabled: editFlags.canCut,
        click: () => actions.cut(),
      },
      {
        label: labels.copy,
        enabled: editFlags.canCopy,
        click: () => actions.copy(),
      },
      {
        label: labels.paste,
        enabled: editFlags.canPaste || clipboardState.hasContent,
        click: () => actions.paste(),
      },
      {
        label: labels.pasteAndMatchStyle,
        enabled: editFlags.canPaste || clipboardState.hasText,
        click: () => actions.pasteAndMatchStyle(),
      },
      {
        label: labels.delete,
        enabled: editFlags.canDelete,
        click: () => actions.delete(),
      },
      { type: 'separator' },
      {
        label: labels.selectAll,
        enabled: editFlags.canSelectAll,
        click: () => actions.selectAll(),
      },
    )
    return items
  }

  if (params.selectionText.trim().length > 0 && params.editFlags.canCopy) {
    return [
      {
        label: labels.copy,
        enabled: true,
        click: () => actions.copy(),
      },
    ]
  }

  return null
}

function webContentsActions(contents: WebContents): ContextMenuActions {
  const run = (fn: () => void): void => {
    if (!contents.isDestroyed()) fn()
  }
  return {
    undo: () => run(() => contents.undo()),
    redo: () => run(() => contents.redo()),
    cut: () => run(() => contents.cut()),
    copy: () => run(() => contents.copy()),
    paste: () => run(() => contents.paste()),
    pasteAndMatchStyle: () => run(() => contents.pasteAndMatchStyle()),
    delete: () => run(() => contents.delete()),
    selectAll: () => run(() => contents.selectAll()),
    replaceMisspelling: (suggestion) => run(() => contents.replaceMisspelling(suggestion)),
  }
}

/**
 * Installs the native edit/copy context menu on an app window's webContents.
 * Electron does not emit `context-menu` when the renderer calls `event.preventDefault()` on
 * `contextmenu`, so custom renderer context menus remain untouched.
 */
export function attachContextMenu(
  contents: WebContents,
  readClipboard: () => Promise<ContextMenuClipboardState> = () => readClipboardState(),
): void {
  const actions = webContentsActions(contents)
  let requestId = 0

  const show = (params: ContextMenuParams, clipboardState?: ContextMenuClipboardState): void => {
    if (contents.isDestroyed()) return
    const template = buildContextMenuTemplate(params, {
      actions,
      clipboard: clipboardState,
    })
    if (!template || template.length === 0) return
    const window = BrowserWindow.fromWebContents(contents)
    if (window?.isDestroyed()) return
    const frame =
      params.frame && !params.frame.isDestroyed() && !params.frame.detached
        ? params.frame
        : undefined
    Menu.buildFromTemplate(template).popup({
      window: window ?? undefined,
      frame,
      sourceType: params.menuSourceType,
    })
  }

  contents.on('context-menu', (_event, params) => {
    const current = ++requestId
    if (!params.isEditable) {
      show(params)
      return
    }
    void readClipboard().then((clipboardState) => {
      if (current !== requestId) return
      show(params, clipboardState)
    })
  })
}
