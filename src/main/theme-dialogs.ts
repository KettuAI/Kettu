// The desktop app's system dialogs and file manager for the themes folder, which the daemon has none
// of; the store checks and writes the files.

import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import type { ThemeInstallResult } from '@shared/themes'
import { safeName } from '@shared/file-name'
import { t } from './i18n'
import { readThemeFile, type ThemeStore } from './themes'

const JSON_FILTER = { name: 'JSON', extensions: ['json'] }

/** `themes:install`: asks for a file, checks it and installs it, or names what it would replace. */
export async function installThemeFile(
  store: ThemeStore,
  window: BrowserWindow | null,
): Promise<ThemeInstallResult> {
  const options: Electron.OpenDialogOptions = {
    title: t('dialogs.installTheme'),
    properties: ['openFile', 'dontAddToRecent'],
    filters: [JSON_FILTER],
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  const [path] = result.filePaths
  if (result.canceled || !path) return { status: 'cancelled' }
  return store.add(basename(path), await readThemeFile(path))
}

/** `themes:export`: checks the file the renderer built, then saves it where the user says. */
export async function exportThemeFile(
  store: ThemeStore,
  window: BrowserWindow | null,
  text: unknown,
): Promise<string | null> {
  const name = store.exportName(text)
  const options: Electron.SaveDialogOptions = {
    title: t('dialogs.exportTheme'),
    defaultPath: join(app.getPath('downloads'), `${safeName(name, 'theme')}.json`),
    filters: [JSON_FILTER],
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, text as string, 'utf8')
  return result.filePath
}

/** `themes:reveal`: selects the theme's file in the file manager. */
export function revealThemeFile(store: ThemeStore, id: unknown): void {
  shell.showItemInFolder(store.fileOf(id))
}
