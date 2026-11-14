// Puts bringing sign-ins together for main: the worker that reads the user's browsers, the record
// of brought sites and the cookies of Kettu's browser.

import { join } from 'node:path'
import { app, nativeImage } from 'electron'
import type { BroughtSite } from '@shared/signins'
import { createLogger, describeError } from '../../log'
import { BroughtStore } from './brought'
import { SignInWorkers } from './runner'
import { SignIns } from './service'
import type { CookieJar } from './write'

const log = createLogger('sign-ins')

/**
 * Development only: a folder standing in for the home folder, whose browsers are read instead of
 * the user's own, with their Safe Storage passwords in `safe-storage.json` instead of the keychain.
 * A packaged app ignores it.
 */
const DEV_HOME_ENV = 'KETTU_DEV_SIGNIN_HOME'

// Drawn at up to 22 px, so 48 px is sharp on a 2x display.
const ICON_SIZE = 48
const icons = new Map<string, Promise<string | null>>()

/** A browser app's icon as a data URL; null on Linux, where GTK gives only a generic one. */
function browserIcon(path: string): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return Promise.resolve(null)
  let icon = icons.get(path)
  if (!icon) {
    // macOS's file icon is the generic one for every app; a thumbnail is the app's own.
    const read =
      process.platform === 'darwin'
        ? nativeImage.createThumbnailFromPath(path, { width: ICON_SIZE, height: ICON_SIZE })
        : app.getFileIcon(path, { size: 'normal' })
    icon = read.then(
      (image) => (image.isEmpty() ? null : image.toDataURL()),
      (error: unknown) => {
        log.info(`No icon for ${path}: ${describeError(error)}`)
        return null
      },
    )
    icons.set(path, icon)
  }
  return icon
}

export async function startSignIns(
  userDataPath: string,
  jar: CookieJar,
  changed: (sites: BroughtSite[]) => void,
): Promise<{ signIns: SignIns; store: BroughtStore }> {
  const devHome = app.isPackaged ? null : process.env[DEV_HOME_ENV] || null
  if (devHome) log.info(`Reading browsers under ${devHome} instead of the home folder`)
  const workers = new SignInWorkers(
    {
      platform: process.platform,
      home: devHome ?? app.getPath('home'),
      localAppData: process.env.LOCALAPPDATA ?? null,
      appData: process.env.APPDATA ?? null,
      configHome: process.env.XDG_CONFIG_HOME ?? null,
      programFiles: [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
        (dir): dir is string => !!dir,
      ),
      tmp: app.getPath('temp'),
    },
    devHome ? join(devHome, 'safe-storage.json') : null,
  )
  const store = await BroughtStore.load(userDataPath, log)
  const signIns: SignIns = new SignIns({
    run: (request) => workers.run(request),
    cancel: () => workers.cancel(),
    jar,
    store,
    icon: browserIcon,
    changed: () => {
      void signIns.brought().then(changed, () => {})
    },
    log,
  })
  return { signIns, store }
}
