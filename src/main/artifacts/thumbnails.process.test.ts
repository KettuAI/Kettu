// Process test: a canvas's thumbnail in Electron, with main's real artifacts, protocol and thumbnail
// renderer, for a canvas whose pages load slowly. Every page the viewer would show has painted.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ThumbnailPage } from '@shared/artifacts'
import type { ThumbnailRunConfig, ThumbnailRunResult } from './thumbnails.harness'

const electron: string = createRequire(import.meta.url)('electron')
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const ID = 'art_01JB2QZ8X4K7M9N3P5R6S8T0V3'
const PAGES = 24

// Each page is a frame that loads the whole canvas, so the 250 ms of script before each load adds up
// to more than a single page's wait.
function slowCanvas(): string {
  const pages = Array.from(
    { length: PAGES },
    (_, i) =>
      `<section data-page="Page ${i + 1}" data-page-size="1280x720" ` +
      'style="width:1280px;height:720px;background:#2563eb"></section>',
  )
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Canvas</title>' +
    '<script>const end = performance.now() + 250; while (performance.now() < end) {}</script>' +
    `</head><body>${pages.join('')}</body></html>`
  )
}

// Six across and four down, 80 px apart.
const layout: ThumbnailPage[] = Array.from({ length: PAGES }, (_, i) => ({
  group: 0,
  index: i + 1,
  x: (i % 6) * 1360,
  y: Math.floor(i / 6) * 800,
  width: 1280,
  height: 720,
}))

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-thumbnails-'))
  // Main's own modules, as the app bundles them.
  await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    ssr: { noExternal: true },
    build: {
      ssr: path.join(root, 'src/main/artifacts/thumbnails.harness.ts'),
      outDir: path.join(dir, 'harness'),
      emptyOutDir: true,
      minify: false,
      rolldownOptions: {
        external: ['electron', /^node:/],
        output: { format: 'cjs', entryFileNames: 'main.cjs' },
      },
    },
  })
}, 120_000)

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function render(html: string): Promise<ThumbnailRunResult> {
  const contentDir = path.join(dir, 'data', 'artifacts', 'content')
  const hash = createHash('sha256').update(html).digest('hex')
  const file = path.join(contentDir, hash.slice(0, 2), `${hash}.html`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, html)
  const config: ThumbnailRunConfig = {
    resultFile: path.join(dir, 'result.json'),
    contentDir,
    thumbnailDir: path.join(dir, 'data', 'artifacts', 'thumbnails'),
    id: ID,
    file,
    layout,
  }
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== 'ELECTRON_RUN_AS_NODE' && name !== 'ELECTRON_RENDERER_URL',
    ),
  )
  env.OVERBENCH_THUMBNAILS = path.join(dir, 'config.json')
  env.OVERBENCH_THUMBNAILS_PARENT = String(process.pid)
  const args = [
    path.join(dir, 'harness', 'main.cjs'),
    `--user-data-dir=${path.join(dir, 'data')}`,
    '--enable-logging=stderr',
    // CI's Ubuntu restricts the user namespaces Chromium's sandbox needs.
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ]
  // Without a display it runs under Xvfb in a D-Bus session of its own, as the isolation probe does.
  const headless = process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
  const [command, commandArgs]: [string, string[]] = headless
    ? ['dbus-run-session', ['--', 'xvfb-run', '-a', electron, ...args]]
    : [electron, args]
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, commandArgs, { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, stderr }))
    },
  )
  const text = await readFile(config.resultFile, 'utf8').catch((): never => {
    throw new Error(`Electron exited with ${code} and no result:\n${stderr}`)
  })
  const result = JSON.parse(text) as ThumbnailRunResult
  if (result.error) throw new Error(`${result.error}\n${stderr}`)
  return result
}

it('captures a canvas only once every page has loaded and painted', async () => {
  const result = await render(slowCanvas())
  console.log(`A thumbnail of ${PAGES} slow pages took ${result.ms} ms`)
  expect(result.white).toEqual([])
}, 60_000)
