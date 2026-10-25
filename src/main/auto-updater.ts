// A test runs this file unbuilt in Electron, so it keeps to erasable syntax and type-only imports.

import type { AppUpdater, CancellationToken } from 'electron-updater'

interface UpdaterExports {
  autoUpdater: AppUpdater
  CancellationToken: typeof CancellationToken
}

type UpdaterNamespace = Partial<UpdaterExports> & { default?: Partial<UpdaterExports> }

/**
 * Loads electron-updater with a native `import()`, which the main bundle keeps as it is. Node
 * names a CommonJS module's exports only where it can find them in the source, and
 * electron-updater defines autoUpdater with a getter, so only the default export carries it.
 */
export async function loadAutoUpdater(): Promise<UpdaterExports> {
  const loaded: UpdaterNamespace = await import('electron-updater')
  const autoUpdater = loaded.autoUpdater ?? loaded.default?.autoUpdater
  if (!autoUpdater) throw new Error('electron-updater has no autoUpdater export')
  const CancellationToken = loaded.CancellationToken ?? loaded.default?.CancellationToken
  if (!CancellationToken) throw new Error('electron-updater has no CancellationToken export')
  return { autoUpdater, CancellationToken }
}
