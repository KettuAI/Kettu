// Process test: the browser's views in Electron. A fixture server stands in for a dev server; main's
// real BrowserViews opens its pages, goes back and forward, refuses a download, opens a window's
// link in place, answers an alert, and closes the least recently used page when a fifth opens.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const electron: string = createRequire(import.meta.url)('electron')
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

let server: Server | null = null
let dir: string | null = null
let fixture = ''

function page(title: string, body = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-browser-'))
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url === '/download') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="fixture.txt"',
      })
      response.end('blocked')
      return
    }
    if (url === '/popup') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(page('Popup', `<script>window.open('/two')</script>`))
      return
    }
    if (url === '/alert') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(page('Alert', `<script>alert('hi'); document.title = 'after'</script>`))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(url === '/two' ? page('Two', '<p>Two</p>') : page('One', '<a href="/two">Two</a>'))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  fixture = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    ssr: { noExternal: true },
    build: {
      ssr: path.join(root, 'src/main/browser/testing/harness.ts'),
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
  server?.close()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function run(): Promise<Record<string, unknown>> {
  const data = path.join(dir!, 'data')
  const result = path.join(dir!, 'result.json')
  await writeFile(result, '{}')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE'),
  )
  env.OVERBENCH_BROWSER_RESULT = result
  env.OVERBENCH_BROWSER_FIXTURE = fixture
  const args = [
    path.join(dir!, 'harness', 'main.cjs'),
    `--user-data-dir=${data}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ]
  // Electron's window needs a display; CI's Ubuntu has none.
  const headless = process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
  const [command, commandArgs]: [string, string[]] = headless
    ? ['dbus-run-session', ['--', 'xvfb-run', '-a', electron, ...args]]
    : [electron, args]
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, commandArgs, { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, stderr }))
    },
  )
  // The harness writes the result just before it quits; a run that died leaves the file empty.
  let text = ''
  for (let attempt = 0; attempt < 40 && !text; attempt += 1) {
    text = await readFile(result, 'utf8').catch(() => '')
    if (!text) await new Promise((done) => setTimeout(done, 50))
  }
  if (!text) throw new Error(`Electron exited with ${code} and wrote no result\n${stderr}`)
  const written = JSON.parse(text) as Record<string, unknown>
  if (written.error) throw new Error(`${written.error}\n${stderr}`)
  if (code !== 0) throw new Error(`Electron exited with ${code}\n${stderr}`)
  return written
}

describe('the browser views', () => {
  it('opens a page, goes back and forward, and holds the browser to its rules', async () => {
    const result = await run()
    expect(result).toMatchObject({
      one: 'One',
      two: 'Two',
      back: `${fixture}/one`,
      forward: `${fixture}/two`,
      download: 'download-blocked',
      popup: `${fixture}/two`,
      dialog: 'after',
      evicted: 'evicted',
      forbidden: true,
    })
  }, 120_000)
})
