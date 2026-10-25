// Builds the app icons, the README's lockups and the macOS disk image's backgrounds from
// src/shared/brand.ts, with `pnpm exec electron tools/brand/build.mjs`; Chromium draws every size
// from the vector source. No dependencies but the Inter font the backgrounds' text is set in.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
import { DMG_LAYOUT } from './dmg-layout.mjs'

const root = resolve(import.meta.dirname, '../..')
const INK = '#1c1b18'
const PAPER = '#f4f3ee'
// The dark macOS tile's gradient, top to bottom.
const TILE_TOP = '#2c2b28'
const TILE_BOTTOM = '#161513'
// The disk image's bench, ink at 4.5% over paper, and the ink of its lines, 5.1:1 on the bench.
const BENCH = '#eae9e4'
const BENCH_TEXT = '#62615d'

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

// On macOS 27 the app icon's tile ends this far above the bottom of its box.
const TILE_INSET = 12
// The first-launch lines of a build that is not signed with a Developer ID, on their baselines.
const FIRST_LAUNCH_LINES = [
  {
    y: 267.6,
    text: 'Blocked on first launch? System Settings › Privacy & Security › Open Anyway',
  },
  { y: 286.6, text: '首次打开被阻止？系统设置 › 隐私与安全性 › 仍要打开' },
]
// Ink at 22%, 50% and 100%, so the arrows grow toward the Applications folder.
const CHEVRON_OPACITY = [0.22, 0.5, 1]

/** Right-pointing chevrons with the mark's 60 degree peak, centred on cx, cy. */
function chevrons(cx, cy) {
  const height = 16
  const gap = 15
  const width = (height / 2) * Math.sqrt(3)
  const left = cx - ((CHEVRON_OPACITY.length - 1) * gap + width) / 2
  return CHEVRON_OPACITY.map((opacity, i) => {
    const tip = left + width + i * gap
    const d = `M${n(tip - width)} ${n(cy - height / 2)}L${n(tip)} ${n(cy)}L${n(tip - width)} ${n(cy + height / 2)}`
    return `<path d="${d}" fill="none" stroke="${INK}" stroke-opacity="${opacity}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
  }).join('')
}

/** The Inter the interface is set in, embedded so the page needs no font on the machine. */
function interFace() {
  const file = createRequire(import.meta.url).resolve(
    '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  )
  const data = readFileSync(file).toString('base64')
  return `<style>@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(data:font/woff2;base64,${data}) format('woff2')}</style>`
}

/**
 * The disk image's background at `scale` pixels to the point, drawn for the Finder window in
 * DMG_LAYOUT: paper above and a bench below, which the two icons stand on, with chevrons between
 * them. `firstLaunch` adds the lines that tell how to open a build macOS does not trust yet.
 */
function dmgBackground(scale, firstLaunch) {
  const { width, height, iconSize, app, applications } = DMG_LAYOUT
  const edge = app.y + iconSize / 2 - TILE_INSET
  const style = `font-family:'Inter Variable','PingFang SC',sans-serif;font-size:12px;font-weight:400;fill:${BENCH_TEXT}`
  const lines = FIRST_LAUNCH_LINES.map(
    ({ y, text }) =>
      `<text x="${width / 2}" y="${y}" text-anchor="middle" style="${style}">${text.replaceAll('&', '&amp;')}</text>`,
  )
  const body =
    `<rect width="${width}" height="${height}" fill="${PAPER}"/>` +
    `<rect y="${edge}" width="${width}" height="${height - edge}" fill="${BENCH}"/>` +
    `<rect y="${edge}" width="${width}" height="0.5" fill="${INK}" fill-opacity="0.16"/>` +
    chevrons((app.x + applications.x) / 2, app.y) +
    (firstLaunch ? interFace() + lines.join('') : '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

let window
async function render(svgText, width, height) {
  window.setContentSize(width, height)
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent;overflow:hidden">${svgText}</body></html>`
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
  // Lets the page lay out, load the fonts it uses and paint again before the capture.
  const frames = 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))'
  await window.webContents.executeJavaScript(
    `${frames}.then(() => document.fonts.ready).then(() => ${frames})`,
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

  const assets = join(root, 'assets')
  const build = join(root, 'build')

  // The README's lockups, ink or paper with the reader's color scheme.
  const write = (path, text) => writeFileSync(path, `${text}\n`)
  write(join(assets, 'lockup-horizontal.svg'), lockupSvg('horizontal', 100, INK))
  write(join(assets, 'lockup-horizontal-dark.svg'), lockupSvg('horizontal', 100, PAPER))

  iconComposer(join(build, 'icon.icon'))

  // Linux takes the macOS tile, which has the rounded corners its desktops expect.
  writeFileSync(join(build, 'icon.png'), await render(macIcon(1024), 1024, 1024))

  const windowsSizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = []
  for (const size of windowsSizes) {
    pngs.push({ size, data: await render(windowsIcon(size), size, size) })
  }
  writeFileSync(join(build, 'icon.ico'), ico(pngs))

  // The Chinese line is set in PingFang SC, which only macOS has; elsewhere the files stay as is.
  if (process.platform !== 'darwin') {
    console.warn('Left the disk image backgrounds as they are: they are drawn on macOS only.')
    return
  }
  // electron-builder joins each name with its @2x into one HiDPI image.
  for (const [name, firstLaunch] of [
    ['dmg-background', true],
    ['dmg-background-signed', false],
  ]) {
    for (const scale of [1, 2]) {
      const file = `${name}${scale === 1 ? '' : '@2x'}.png`
      const { width, height } = DMG_LAYOUT
      const png = await render(dmgBackground(scale, firstLaunch), width * scale, height * scale)
      writeFileSync(join(build, file), png)
    }
  }
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
