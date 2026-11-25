// Export conversation: the renderer writes the Markdown from the thread, and main saves it where
// the user says.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow, dialog } from 'electron'
import { safeName } from '@shared/file-name'
import { t } from './i18n'

const MAX_TITLE_CHARS = 1000
// Far beyond any thread's text, to refuse a runaway string before it reaches the disk.
const MAX_CONVERSATION_CHARS = 256 * 1024 * 1024

/** Asks where to save the file, named after the session; the path written, false if cancelled. */
export async function exportConversationFile(
  window: BrowserWindow | null,
  title: unknown,
  markdown: unknown,
): Promise<string | false> {
  if (typeof title !== 'string' || title.length > MAX_TITLE_CHARS) {
    throw new Error(`A title must be a string of at most ${MAX_TITLE_CHARS} characters`)
  }
  if (typeof markdown !== 'string' || markdown.length > MAX_CONVERSATION_CHARS) {
    throw new Error('A conversation must be a string within the export limit')
  }
  const options: Electron.SaveDialogOptions = {
    title: t('dialogs.exportConversation'),
    defaultPath: join(app.getPath('downloads'), `${safeName(title, 'conversation')}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, markdown, 'utf8')
  return result.filePath
}
