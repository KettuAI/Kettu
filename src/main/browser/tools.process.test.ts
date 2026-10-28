// Process test: main's browser tools in Electron against a local fixture server. Each tool runs on
// a real page over the DevTools protocol; the test checks what it did and what it refused.

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

const FORM = page(
  'Form',
  `
  <h1>Sign in</h1>
  <label>Email <input type="email" id="email"></label>
  <label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
  <button id="add" onclick="addRow()">Add row</button>
  <div id="rows"></div>
  <script>
    console.log('ready')
    console.warn('a warning')
    function addRow() {
      const row = document.createElement('p')
      row.textContent = 'Row added'
      document.getElementById('rows').append(row)
    }
  </script>`,
)

const COVERED = page(
  'Covered',
  `
  <div style="position:relative;width:200px;height:80px">
    <button id="hidden" style="position:absolute;left:0;top:0;width:200px;height:80px">Hidden button</button>
    <div style="position:absolute;left:0;top:0;width:200px;height:80px;background:rgba(0,0,0,.1)">A veil</div>
  </div>`,
)

const FRAME = page('Frame', `<iframe src="/inner" style="width:400px;height:120px"></iframe>`)

const INNER = page('Inner', `<button onclick="document.title='clicked'">Inner button</button>`)

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-browser-tools-'))
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url === '/redirect') {
      // A redirect to the same server under a name that is no dev host: another origin.
      const other = `http://example.org:${(server!.address() as AddressInfo).port}/two`
      response.writeHead(302, { location: other })
      response.end()
      return
    }
    const html = url.startsWith('/inner')
      ? INNER
      : url === '/form'
        ? FORM
        : url === '/covered'
          ? COVERED
          : url === '/frame'
            ? FRAME
            : url === '/alert'
              ? page('Alert', `<script>alert('hi'); document.title = 'after'</script>`)
              : page('Home', '<a href="/two">Two</a>')
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(html)
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
      ssr: path.join(root, 'src/main/browser/testing/tools-harness.ts'),
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

describe('the browser tools', () => {
  it('drives a real page, and refuses what it must', async () => {
    const result = await run()
    const snapshot = result.snapshot as string
    // The outline carries the page, its fields and its buttons, each with a ref.
    expect(snapshot).toContain('- Page: Form (')
    expect(snapshot).toMatch(/heading "Sign in"/)
    expect(snapshot).toMatch(/textbox "Email" \[ref=e\d+\]/)
    expect(snapshot).toMatch(/combobox "Plan" \[value="Free"\] \[ref=e\d+\]/)
    expect(snapshot).toMatch(/button "Add row" \[ref=e\d+\]/)

    expect(result.clicked).toContain('Clicked')
    expect(result.clicked).toContain('Add row')
    const typed = result.typed as string
    expect(typed).toContain('Email')
    expect(result.pressed).toBe('Pressed Tab.')
    expect(result.scrolled).toContain('Scrolled down 1 screen(s).')
    expect(result.selected).toContain('Plan')
    expect(result.waited).toContain('"Row added" appeared.')

    // Console and network keep what the page said and asked for, without headers or bodies.
    const console = result.console as { level: string; text: string }[]
    // Electron's own security note in a development run is not the page's.
    const fromPage = console.filter(
      (message) => !message.text.includes('Electron Security Warning'),
    )
    expect(fromPage).toEqual([
      { level: 'log', text: 'ready' },
      { level: 'warn', text: 'a warning' },
    ])
    const network = result.network as { method: string; url: string; status: number | null }[]
    expect(network).toContainEqual({ method: 'GET', url: `${fixture}/form`, status: 200 })

    expect(result.evaluated).toBe('"Form"')

    // A screenshot is a PNG image block, whole page or one element.
    expect((result.shot as { image: number }).image).toBeGreaterThan(100)
    expect(result.elementShot as number).toBeGreaterThan(100)

    expect(result.stale).toBe('stale_ref')

    // A click whose centre is covered names what covers it.
    expect(result.covered).toContain('covered by')

    // An agent's call shows as driving while it runs, and nobody drives between calls.
    expect(result.drivingDuringCall).toEqual({ kind: 'agent' })
    expect(result.drivingAfterCall).toEqual({ kind: 'none' })

    // Any input in the page takes control, and Hand back returns it.
    expect(result.controlAfterTake).toMatchObject({ kind: 'user' })
    expect(result.control).toBe('user_has_control')

    // A dialog is answered at once, and the call still ends.
    expect(result.dialog as string).toContain('An alert dialog was accepted.')
    // A same-origin frame shows under its iframe node.
    expect(result.frame as string).toMatch(/iframe/)
    expect(result.frame as string).toMatch(/button "Inner button"/)

    // A new origin asks, and refused the call fails not_allowed with the page where it was.
    const other = `http://example.com:${new URL(fixture).port}`
    const redirected = `http://example.org:${new URL(fixture).port}`
    expect(result.originAsked).toBe(other)
    expect(result.originDenied).toBe('not_allowed')
    expect(result.originStayed).toBe(`${fixture}/frame`)
    // Allowed for the session, it opens, and a later navigation to it asks no longer.
    expect(result.originOpened).toBe(`${other}/two`)
    expect(result.originOpenedAgain).toBe(`${other}/form`)
    expect(result.originAskedAgain).toBe(false)
    // A redirect during an agent's call asks too, and refused it fails the same way.
    expect(result.redirectAsked).toBe(redirected)
    expect(result.redirectDenied).toBe('not_allowed')
    expect(result.redirectStayed).toBe(`${other}/form`)
    // Unanswered, the site fails the call not_allowed once its wait ends.
    expect(result.originTimedOut).toBe('not_allowed')
    // The user's own navigation opens the site without asking.
    expect(result.userAsked).toBe(false)
    expect(result.userOpened).toBe(`${other}/two`)
  }, 120_000)
})
