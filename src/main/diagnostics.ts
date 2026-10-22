import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow, dialog } from 'electron'
import { t } from './i18n'
import { recentLogRecords } from './log'
import type { UtilityHostEvent, UtilityHostState } from './utility-host'

const MAX_BUNDLE_CHARS = 256 * 1024 * 1024

export interface MainDiagnosticsSource {
  agentHost: { state: UtilityHostState; history(): UtilityHostEvent[] }
  terminalHost: { state: UtilityHostState; history(): UtilityHostEvent[] }
  launchToInteractiveMs: number | null
}

/** Main's own part of a diagnostics bundle: versions, platform and host supervision. */
export function mainDiagnostics(source: MainDiagnosticsSource): Record<string, unknown> {
  return {
    app: { name: app.getName(), version: app.getVersion(), isPackaged: app.isPackaged },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    launchToInteractiveMs: source.launchToInteractiveMs,
    agentHost: { state: source.agentHost.state, history: source.agentHost.history() },
    terminalHost: { state: source.terminalHost.state, history: source.terminalHost.history() },
    log: recentLogRecords(),
  }
}

function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** Asks where to save and writes the renderer's bundle with main's section, as pretty JSON. */
export async function saveDiagnostics(
  window: BrowserWindow | null,
  bundle: unknown,
  main: Record<string, unknown>,
): Promise<string | null> {
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    throw new Error('The diagnostics bundle must be an object')
  }
  const text = JSON.stringify({ ...bundle, main }, null, 2)
  if (text.length > MAX_BUNDLE_CHARS) throw new Error('The diagnostics bundle is too large')
  const options: Electron.SaveDialogOptions = {
    title: t('dialogs.exportDiagnostics'),
    defaultPath: join(
      app.getPath('downloads'),
      `overbench-diagnostics-${timestamp(new Date())}.json`,
    ),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, `${text}\n`, 'utf8')
  return result.filePath
}
