// Electron's main process for the thumbnail test (thumbnails.process.test.ts), bundled by the test:
// main's real artifacts, protocol and thumbnail renderer render one canvas, and it writes which of
// the canvas's pages are white at their centre in the thumbnail to a file.

import { readFileSync, writeFileSync } from 'node:fs'
import { app, nativeImage, protocol, session } from 'electron'
import { fitThumbnail, THUMBNAIL_WIDTH, type ThumbnailPage } from '@shared/artifacts'
import { Artifacts } from '.'
import { artifactScheme } from './protocol'

export interface ThumbnailRunConfig {
  resultFile: string
  contentDir: string
  thumbnailDir: string
  id: string
  /** The canvas's version file, named by its hash as the host stores it. */
  file: string
  layout: ThumbnailPage[]
}

export interface ThumbnailRunResult {
  error?: string
  /** How long the thumbnail took. */
  ms?: number
  /** The pages, from 1, whose centre is white in the thumbnail: a frame that never painted. */
  white?: number[]
}

const config = JSON.parse(
  readFileSync(process.env.OVERBENCH_THUMBNAILS ?? '', 'utf8'),
) as ThumbnailRunConfig

// Before the app is ready, as main registers its schemes.
protocol.registerSchemesAsPrivileged([artifactScheme])
// No Dock icon, and no activation that would take the user's focus.
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
// The thumbnail's window is the only one, and Electron quits once it closes unless told otherwise.
app.on('window-all-closed', () => {})

function report(result: ThumbnailRunResult): void {
  try {
    writeFileSync(config.resultFile, JSON.stringify(result))
    app.exit(0)
  } catch {
    // The test gave up on the run and took its folder away.
    app.exit(1)
  }
}

// It reports before the test's own timeout, and ends when the test's process does.
setTimeout(() => report({ error: 'The thumbnail did not finish within 50 s' }), 50_000)
const parent = Number(process.env.OVERBENCH_THUMBNAILS_PARENT)
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    app.exit(1)
  }
}, 500)

async function run(): Promise<ThumbnailRunResult> {
  const artifacts = new Artifacts({
    content: () =>
      Promise.resolve({ kind: 'found', path: config.file, version: 1, title: 'Canvas' }),
    contentDir: config.contentDir,
    thumbnailDir: config.thumbnailDir,
    importFile: () => Promise.resolve({ failed: 'unavailable' }),
  })
  await artifacts.install(session.defaultSession)
  const started = Date.now()
  const url = await artifacts.thumbnail(config.id, 1, config.layout)
  const ms = Date.now() - started
  if (!url) return { error: 'No thumbnail', ms }
  const image = nativeImage.createFromDataURL(url)
  const { width } = image.getSize()
  const bitmap = image.toBitmap()
  const fit = fitThumbnail(config.layout)
  const scale = width / THUMBNAIL_WIDTH
  const white = config.layout.flatMap((page, i) => {
    const x = Math.round((fit.x + (page.x + page.width / 2) * fit.scale) * scale)
    const y = Math.round((fit.y + (page.y + page.height / 2) * fit.scale) * scale)
    const at = (y * width + x) * 4
    // White in any channel order: the bitmap is in the platform's own order.
    return [0, 1, 2].every((channel) => bitmap[at + channel]! >= 250) ? [i + 1] : []
  })
  return { ms, white }
}

void app
  .whenReady()
  .then(() => run().then(report, (error: unknown) => report({ error: String(error) })))
