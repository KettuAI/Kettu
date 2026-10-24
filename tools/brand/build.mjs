// Builds the app icons and the brand images from src/shared/brand.ts, as docs/design/brand.md
// specifies them, with `pnpm exec electron tools/brand/build.mjs`; Chromium draws every size from the
// vector source. No dependencies.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import {
  lockupGeometry,
  MARK_BOX,
  MARK_CENTER_Y,
  MARK_PATHS,
  markVersionFor,
  WORDMARK,
} from '../../src/shared/brand.ts'

const root = resolve(import.meta.dirname, '../..')
const INK = '#1c1b18'
const PAPER = '#f4f3ee'
// The dark macOS tile's gradient, top to bottom.
const TILE_TOP = '#2c2b28'
const TILE_BOTTOM = '#161513'

const n = (v) => +v.toFixed(3)
const VIEW_BOX = `${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`

/** The mark `width` wide with its artboard's top left at x, y. */
function mark(x, y, width, color, version = markVersionFor(width)) {
  const height = (width * MARK_BOX.height) / MARK_BOX.width
  return `<svg x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" viewBox="${VIEW_BOX}"><path fill="${color}" d="${MARK_PATHS[version]}"/></svg>`
}

/** The mark centred on cx, cy by its outer box, as icon tiles place it. */
function centredMark(cx, cy, width, version) {
  const scale = width / MARK_BOX.width
  const y = cy - (MARK_CENTER_Y[version] - MARK_BOX.y) * scale
  return mark(cx - width / 2, y, width, PAPER, version)
}

function svg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

/** A lockup with the wordmark at `fontSize`, on a transparent ground. */
function lockup(layout, fontSize, color) {
  const g = lockupGeometry(layout)
  const s = fontSize / 100
  const markWidth = g.mark.width * s
  const body =
    mark(g.mark.x * s, g.mark.y * s, markWidth, color) +
    `<path fill="${color}" transform="translate(${n(g.text.x * s)} ${n(g.text.y * s)}) scale(${s})" d="${WORDMARK.path}"/>`
  return { width: g.width * s, height: g.height * s, body }
}

function lockupSvg(layout, fontSize, color) {
  const l = lockup(layout, fontSize, color)
  return svg(n(l.width), n(l.height), l.body)
}

// Below 48 px the small version takes over, on every platform's tile.
const versionForCanvas = (size) => (size >= 48 ? 'standard' : 'small')

/**
 * The macOS icon on Apple's grid: an 824 px tile on a 1024 px canvas, a 22.5% corner radius, the
 * dark gradient with a lit top edge, and a soft shadow. The mark is 62% of the tile's width.
 */
function macIcon(size) {
  const k = size / 1024
  const x = 100 * k
  const w = 824 * k
  const r = 0.225 * w
  const lit = (w / 200) * 1
  const tile = `x="${n(x)}" y="${n(x)}" width="${n(w)}" height="${n(w)}" rx="${n(r)}"`
  const body = `
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TILE_TOP}"/><stop offset="1" stop-color="${TILE_BOTTOM}"/></linearGradient>
  <clipPath id="c"><rect ${tile}/></clipPath>
  <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${n(10 * k)}" stdDeviation="${n(12 * k)}" flood-color="#000" flood-opacity="0.3"/></filter>
</defs>
<rect ${tile} fill="${TILE_BOTTOM}" filter="url(#s)"/>
<g clip-path="url(#c)">
  <rect ${tile} fill="#fff" fill-opacity="0.12"/>
  <rect x="${n(x)}" y="${n(x + lit)}" width="${n(w)}" height="${n(w)}" rx="${n(r)}" fill="url(#g)"/>
</g>
${centredMark(size / 2, size / 2, 0.62 * w, versionForCanvas(size))}`
  return svg(size, size, body)
}

/** A colour as Icon Composer writes it. */
function srgb(hex) {
  const c = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5))
  return `srgb:${c.join(',')},1.00000`
}

/**
 * The macOS icon as an Icon Composer document, which macOS 26 draws in Liquid Glass and actool
 * compiles for older versions. The system draws the tile, so the 1024 px canvas is the tile: the
 * tile's gradient as the fill and the mark, flat and without a shadow, as the one layer.
 */
function iconComposer(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'Assets'), { recursive: true })
  writeFileSync(
    join(dir, 'Assets', 'mark.svg'),
    `${svg(1024, 1024, centredMark(512, 512, 0.62 * 1024, 'standard'))}\n`,
  )
  const document = {
    fill: {
      'linear-gradient': [srgb(TILE_TOP), srgb(TILE_BOTTOM)],
      orientation: { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 1 } },
    },
    groups: [
      {
        layers: [{ glass: false, 'image-name': 'mark.svg', name: 'mark' }],
        shadow: { kind: 'none', opacity: 0.5 },
      },
    ],
    'supported-platforms': { squares: 'shared' },
  }
  writeFileSync(join(dir, 'icon.json'), `${JSON.stringify(document, null, 2)}\n`)
}

/** The Windows icon: a flat square tile filling the canvas with a 12% corner radius. */
function windowsIcon(size) {
  // At 16 px the mark grows a little so its two cuts still show.
  const share = size <= 16 ? 0.6875 : 0.62
  const body =
    `<rect width="${size}" height="${size}" rx="${n(0.12 * size)}" fill="${INK}"/>` +
    centredMark(size / 2, size / 2, share * size, versionForCanvas(size))
  return svg(size, size, body)
}

/** The 1280 x 640 GitHub and website preview: the horizontal lockup on paper. */
function socialPreview() {
  const l = lockup('horizontal', 84, INK)
  const body = `<rect width="1280" height="640" fill="${PAPER}"/><g transform="translate(${n((1280 - l.width) / 2)} ${n((640 - l.height) / 2)})">${l.body}</g>`
  return svg(1280, 640, body)
}

let window
async function render(svgText, width, height) {
  window.setContentSize(width, height)
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svgText}</body></html>`
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  // Lets the page paint before the capture.
  await window.webContents.executeJavaScript(
    'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))',
  )
  const image = await window.webContents.capturePage({ x: 0, y: 0, width, height })
  const { width: w, height: h } = image.getSize()
  if (w !== width || h !== height)
    throw new Error(`Captured ${w}x${h}, expected ${width}x${height}`)
  return image.toPNG()
}

/** An .ico holding each size as a PNG, which Windows reads from Vista on. */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...pngs.map((p) => p.data)])
}

async function main() {
  window = new BrowserWindow({
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  })

  const brand = join(root, 'docs', 'brand')
  const build = join(root, 'build')
  mkdirSync(brand, { recursive: true })

  // Vector masters.
  const write = (path, text) => writeFileSync(path, `${text}\n`)
  write(join(brand, 'mark.svg'), svg(80, 52, mark(0, 0, 80, INK, 'standard')))
  write(join(brand, 'mark-small.svg'), svg(80, 52, mark(0, 0, 80, INK, 'small')))
  write(join(brand, 'lockup-horizontal.svg'), lockupSvg('horizontal', 100, INK))
  write(join(brand, 'lockup-horizontal-dark.svg'), lockupSvg('horizontal', 100, PAPER))
  write(join(brand, 'lockup-vertical.svg'), lockupSvg('vertical', 100, INK))
  write(join(brand, 'lockup-vertical-dark.svg'), lockupSvg('vertical', 100, PAPER))
  write(join(brand, 'icon-macos.svg'), macIcon(1024))
  write(join(brand, 'icon-windows.svg'), windowsIcon(256))

  iconComposer(join(build, 'icon.icon'))

  // Linux takes the macOS tile, which has the rounded corners its desktops expect.
  writeFileSync(join(build, 'icon.png'), await render(macIcon(1024), 1024, 1024))

  const windowsSizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = []
  for (const size of windowsSizes) {
    pngs.push({ size, data: await render(windowsIcon(size), size, size) })
  }
  writeFileSync(join(build, 'icon.ico'), ico(pngs))

  writeFileSync(join(brand, 'social-preview.png'), await render(socialPreview(), 1280, 640))
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
