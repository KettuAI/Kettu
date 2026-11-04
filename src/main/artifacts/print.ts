// A typed artifact's PDF: its viewer laid out for print, every page on a sheet of the page's own
// size, printed by Chromium in a hidden window of the thumbnails' session.

import { BrowserWindow, type Session } from 'electron'
import { createLogger } from '../log'

const log = createLogger('artifacts')

/** How long the viewer has to lay out its pages and load their pictures. */
const READY_WAIT_MS = 20_000
const POLL_MS = 150

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The viewer at `page` (a version's entry URL) printed as a PDF. */
export async function printViewer(session: Session, page: string): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      disableDialogs: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })
  try {
    const contents = window.webContents
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    await contents.loadURL(`${page}?view=print`)
    // The viewer marks its root once its pages and pictures are in; what it says only decides
    // when its own PDF is taken.
    const until = Date.now() + READY_WAIT_MS
    for (;;) {
      if (window.isDestroyed()) throw new Error('The print window closed')
      const ready = await Promise.race([
        contents.executeJavaScript("document.documentElement.dataset.ready === 'true'", true).then(
          (value: unknown) => value === true,
          () => false,
        ),
        delay(1_000).then(() => false),
      ])
      if (ready) break
      if (Date.now() > until) {
        log.warn('The viewer did not say it was ready to print; printing what it shows')
        break
      }
      await delay(POLL_MS)
    }
    return await contents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}
