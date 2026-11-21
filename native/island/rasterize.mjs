// Draws SVG documents to square PNGs with Chromium, which draws them as the window does, for the
// island's drawings CoreSVG cannot draw or draws slowly. generate.mjs runs it as
// `electron rasterize.mjs <input.json> <output.json>`: the input maps a name to an SVG document,
// the output maps it to a base64 PNG `SIZE` pixels square.

import { Buffer } from 'node:buffer'
import console from 'node:console'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { app, BrowserWindow } from 'electron'

// Three times the largest the island draws an image, 30 pt, rounded up.
const SIZE = 96

async function main() {
  const [input, output] = process.argv.slice(-2)
  const svgs = JSON.parse(readFileSync(input, 'utf8'))
  const window = new BrowserWindow({
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    width: SIZE,
    height: SIZE,
    webPreferences: { offscreen: true },
  })
  const out = {}
  for (const [name, svg] of Object.entries(svgs)) {
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"><img src="${src}" width="${SIZE}" height="${SIZE}" style="display:block"></body></html>`
    await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
    // The image decoded and painted twice before the capture.
    await window.webContents.executeJavaScript(
      `document.images[0].decode().then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))`,
    )
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
    const { width, height } = image.getSize()
    if (width !== SIZE || height !== SIZE)
      throw new Error(`${name}: captured ${width}x${height}, expected ${SIZE}x${SIZE}`)
    out[name] = image.toPNG().toString('base64')
  }
  writeFileSync(output, JSON.stringify(out))
}

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.dock?.hide()
app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    },
  )
