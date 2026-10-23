// Process test: the isolation probe. A page in the viewer's frame tries to reach what an artifact
// must not, in Electron with main's real protocol, guards and frame guard; then the frame guard
// meets frames it must refuse. It runs once with the policy and once without, so main's own guards
// are shown to hold on their own. See docs/design/artifacts.md#security.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProbeConfig } from './isolation.harness'
import { artifactUrl } from './origins'

const electron: string = createRequire(import.meta.url)('electron')
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const ids = {
  probe: 'art_01JB2QZ8X4K7M9N3P5R6S8T0V1',
  other: 'art_01JB2QZ8X4K7M9N3P5R6S8T0V2',
  canvas: 'art_01JB2QZ8X4K7M9N3P5R6S8T0V3',
  hang: 'art_01JB2QZ8X4K7M9N3P5R6S8T0V4',
  unopened: 'art_01JB2QZ8X4K7M9N3P5R6S8T0V5',
}

// Runs in the page; every attempt reports whether it held. What reaches the test's server is
// checked as well, since a request can leave even where the page sees a failure.
function probePage(server: string, secret: string, image: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Probe</title></head>
<body><iframe name="sink" style="display: none"></iframe>
<script>
const SERVER = ${JSON.stringify(server)}
const DEV_SERVER = ${JSON.stringify(server.replace('127.0.0.1', 'localhost'))}
const OTHER = ${JSON.stringify(artifactUrl(ids.other))}
const SECRET = ${JSON.stringify(secret)}
const IMAGE = ${JSON.stringify(image)}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fails = (promise) => promise.then(() => false, () => true)
const loads = (element) => new Promise((resolve) => {
  element.onload = () => resolve(true)
  element.onerror = () => resolve(false)
})
const notServed = async (path) => {
  const response = await fetch(path)
  return response.status === 404 && !(await response.text()).includes('SECRET')
}
const fromWorker = (code, shared) => new Promise((resolve) => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  const worker = shared ? new SharedWorker(url) : new Worker(url)
  const port = shared ? worker.port : worker
  port.onmessage = (event) => resolve(event.data)
  worker.onerror = () => resolve(true)
})
const attempts = {
  "the app's API": () => typeof window.overbench === 'undefined',
  'require': () => typeof require === 'undefined',
  'process': () => typeof process === 'undefined',
  "the app's DOM": () => { try { parent.document.body; return false } catch { return true } },
  "the app's API through its frame": () => { try { return parent.overbench === undefined } catch { return true } },
  "the app's frame's location": async () => {
    try { top.location.href = SERVER + '/top' } catch {}
    await sleep(300)
    return true
  },
  'a file above its folder': () => notServed('/../../secret.txt'),
  'an encoded ..': () => notServed('/%2e%2e/%2e%2e/secret.txt'),
  'an encoded separator': () => notServed('/..%2f..%2fsecret.txt'),
  'a dotfile': () => notServed('/.env'),
  'file: by fetch': () => fails(fetch(SECRET)),
  'file: as an image': async () => {
    const img = new Image()
    const loaded = loads(img)
    img.src = IMAGE
    return !(await loaded)
  },
  "another artifact's origin by fetch": () => fails(fetch(OTHER)),
  "another artifact's origin in a frame": async () => {
    const frame = document.createElement('iframe')
    frame.src = OTHER
    document.body.append(frame)
    await sleep(800)
    return true
  },
  'the dev server': () => fails(fetch(DEV_SERVER + '/src/main.tsx', { mode: 'no-cors' })),
  'another host by fetch': () => fails(fetch(SERVER + '/fetch', { mode: 'no-cors' })),
  'another host by image': async () => {
    const img = new Image()
    const loaded = loads(img)
    img.src = SERVER + '/image.png'
    return !(await loaded)
  },
  'another host by WebSocket': () => new Promise((resolve) => {
    try {
      const socket = new WebSocket(SERVER.replace('http', 'ws') + '/socket')
      socket.onopen = () => resolve(false)
      socket.onerror = () => resolve(true)
    } catch { resolve(true) }
  }),
  'another host by beacon': async () => {
    try { navigator.sendBeacon(SERVER + '/beacon', 'secret') } catch {}
    await sleep(300)
    return true
  },
  'another host by a form': async () => {
    const form = document.createElement('form')
    form.method = 'post'
    form.action = SERVER + '/form'
    form.target = 'sink'
    document.body.append(form)
    form.submit()
    await sleep(500)
    return true
  },
  'a script from another host': async () => {
    const script = document.createElement('script')
    const loaded = loads(script)
    script.src = SERVER + '/script.js'
    document.head.append(script)
    return !(await loaded)
  },
  'another host from a worker': () =>
    fromWorker("fetch('" + SERVER + "/worker', { mode: 'no-cors' }).then(() => postMessage(false), () => postMessage(true))", false),
  'another host from a shared worker': () =>
    fromWorker("onconnect = (event) => fetch('" + SERVER + "/shared-worker', { mode: 'no-cors' }).then(() => event.ports[0].postMessage(false), () => event.ports[0].postMessage(true))", true),
  'window.open': () => window.open(SERVER + '/open') === null,
  'alert()': () => {
    const start = performance.now()
    alert('blocked?')
    return performance.now() - start < 100
  },
  'notifications': async () => (await Notification.requestPermission()) !== 'granted',
  'the camera': () => fails(navigator.mediaDevices.getUserMedia({ video: true })),
  'location': () => new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(() => resolve(false), () => resolve(true))
  }),
  'the clipboard': async () =>
    (await fails(navigator.clipboard.writeText('secret'))) && (await fails(navigator.clipboard.readText())),
  'a service worker': () => {
    try { return fails(navigator.serviceWorker.register('/sw.js')) } catch { return true }
  },
}
window.__probe = { done: false, results: [] }
;(async () => {
  for (const [name, attempt] of Object.entries(attempts)) {
    let held
    try {
      held = await Promise.race([Promise.resolve().then(attempt), sleep(5000).then(() => 'timed out')])
    } catch (error) {
      held = true
    }
    window.__probe.results.push({ name, held })
  }
  window.__probe.done = true
})()
</script>
</body></html>`
}

function canvasPage(): string {
  const pages = Array.from(
    { length: 24 },
    (_, i) =>
      `<section data-page="Page ${i + 1}" data-page-size="1280x720">Page ${i + 1}</section>`,
  )
  return `<!doctype html><html><head><title>Canvas</title></head><body>${pages.join('')}</body></html>`
}

// The preload a sandboxed window can run: it may only require electron.
const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron')
const events = []
for (const channel of ['artifact:blocked', 'artifact:stopped', 'app:shortcut']) {
  ipcRenderer.on(channel, (_, payload) => events.push({ channel, payload }))
}
contextBridge.exposeInMainWorld('overbench', {
  ping: () => ipcRenderer.invoke('app:get-info'),
  open: (id) => ipcRenderer.invoke('artifact:open', id),
  events: () => events.slice(),
})
`

interface ProbeResult {
  error?: string
  held: { waits: (number | string)[] }
  attempts: { name: string; held: boolean | string }[]
  processes: Record<'app' | 'page', { pid: number; sandboxed: boolean | null }>
  afterNavigation: { restored: boolean; trusted: boolean; appUrl: string }
  inputs: { key: string; inArtifact: boolean }[]
  theme: { dark: boolean; light: boolean }
  stopped: boolean
  reloaded: { shown: boolean; dark: boolean }
  events: { channel: string; payload: Record<string, unknown> }[]
  trustedAfterProbe: boolean
  refused: Record<string, { waits: (number | string)[]; revoked: boolean; revocations: number }>
  canvas: { waits: number[]; loaded: number; trusted: boolean }
  asked: string[]
  opened: string[]
  windows: number
}

let dir: string
let server: Server
const reached: string[] = []

async function hashFile(contentDir: string, html: string): Promise<string> {
  const hash = createHash('sha256').update(html).digest('hex')
  const file = path.join(contentDir, hash.slice(0, 2), `${hash}.html`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, html)
  return file
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-isolation-'))
  server = createServer((request, response) => {
    reached.push(`${request.method} ${request.url}`)
    response.end('ok')
  })
  server.on('upgrade', (request, socket) => {
    reached.push(`UPGRADE ${request.url}`)
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // Main's own modules, as the app bundles them, with a stand-in for the agent host.
  await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    ssr: { noExternal: true },
    build: {
      ssr: path.join(root, 'src/main/artifacts/isolation.harness.ts'),
      outDir: path.join(dir, 'harness'),
      emptyOutDir: true,
      minify: false,
      rolldownOptions: {
        external: ['electron', /^node:/],
        output: { format: 'cjs', entryFileNames: 'main.cjs' },
      },
    },
  })
  // Where the bundle's createMainWindow looks for the page and its preload.
  const appCsp = /content="([^"]+)"/.exec(
    await readFile(path.join(root, 'src/renderer/index.html'), 'utf8'),
  )?.[1]
  await mkdir(path.join(dir, 'renderer'))
  await writeFile(
    path.join(dir, 'renderer', 'index.html'),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${appCsp}"></head><body></body></html>`,
  )
  await mkdir(path.join(dir, 'preload'))
  await writeFile(path.join(dir, 'preload', 'index.js'), PRELOAD)
}, 120_000)

afterAll(async () => {
  server?.close()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function probe(policy: boolean): Promise<ProbeResult> {
  const run = path.join(dir, policy ? 'with-policy' : 'without-policy')
  const contentDir = path.join(run, 'data', 'artifacts', 'content')
  const secret = path.join(run, 'data', 'secret.txt')
  await mkdir(contentDir, { recursive: true })
  await writeFile(secret, 'SECRET')
  await writeFile(path.join(contentDir, '.env'), 'SECRET')
  const image = path.join(run, 'data', 'secret.png')
  // A 1x1 PNG, so a load would show as a load rather than as a decoding error.
  await writeFile(
    image,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  const page = probePage(origin, pathToFileURL(secret).href, pathToFileURL(image).href)
  const files = {
    [ids.probe]: await hashFile(contentDir, page),
    [ids.other]: await hashFile(contentDir, '<!doctype html><p>SECRET of another artifact</p>'),
    [ids.canvas]: await hashFile(contentDir, canvasPage()),
    [ids.hang]: await hashFile(contentDir, '<!doctype html><p>never served</p>'),
    [ids.unopened]: await hashFile(contentDir, '<!doctype html><p>never opened</p>'),
  }
  const config: ProbeConfig = {
    resultFile: path.join(run, 'result.json'),
    contentDir,
    server: origin,
    policy,
    files,
    probe: ids.probe,
    canvas: ids.canvas,
    hang: ids.hang,
    unopened: ids.unopened,
    commitTimeoutMs: 1_000,
  }
  await writeFile(path.join(run, 'config.json'), JSON.stringify(config))
  // Run as Electron, and load the page from its file rather than a dev server.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== 'ELECTRON_RUN_AS_NODE' && name !== 'ELECTRON_RENDERER_URL',
    ),
  )
  env.OVERBENCH_PROBE = path.join(run, 'config.json')
  const args = [
    path.join(dir, 'harness', 'main.cjs'),
    `--user-data-dir=${path.join(run, 'data')}`,
    // CI's Ubuntu has no display and restricts the user namespaces Chromium's sandbox needs.
    ...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []),
  ]
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(electron, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, stderr }))
    },
  )
  const text = await readFile(config.resultFile, 'utf8').catch((): never => {
    throw new Error(`Electron exited with ${code} and no result:\n${stderr}`)
  })
  const result = JSON.parse(text) as ProbeResult
  if (result.error) throw new Error(`${result.error}\n${stderr}`)
  return result
}

describe.each([
  ['with the policy', true],
  ['with the policy removed', false],
])('the isolation probe, %s', (_, policy) => {
  let result: ProbeResult

  beforeAll(async () => {
    reached.length = 0
    result = await probe(policy)
  }, 120_000)

  it('holds every attempt, and nothing reaches another host', () => {
    expect(result.attempts.length).toBeGreaterThanOrEqual(27)
    expect(result.attempts.filter((attempt) => attempt.held !== true)).toEqual([])
    expect(reached).toEqual([])
    expect(result.asked).not.toContain(ids.other)
    expect(result.opened).toEqual([])
    expect(result.windows).toBe(1)
  })

  it("runs the page in a sandboxed process of its own and keeps the app's access", () => {
    expect(result.processes.page.pid).not.toBe(result.processes.app.pid)
    // Chromium reports the sandbox on macOS and Windows; CI's Linux runs without it.
    if (process.platform !== 'linux') expect(result.processes.page.sandboxed).toBe(true)
    expect(result.held.waits.every((wait) => typeof wait === 'number')).toBe(true)
    expect(result.trustedAfterProbe).toBe(true)
  })

  it('stops the page leaving its origin, tells the app, and loads again', () => {
    expect(result.events).toContainEqual({
      channel: 'artifact:blocked',
      payload: {
        origin: artifactUrl(ids.probe).slice(0, -1),
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/navigate`,
        reload: true,
      },
    })
    expect(result.afterNavigation).toMatchObject({ restored: true, trusted: true })
    expect(result.afterNavigation.appUrl).toMatch(/renderer\/index\.html$/)
  })

  it("sees keys typed in the page's frame and passes the app's shortcuts on", () => {
    expect(result.inputs).toContainEqual({ key: 'l', inArtifact: true })
    expect(result.events.some((event) => event.channel === 'app:shortcut')).toBe(true)
  })

  it("follows the app's theme", () => {
    expect(result.theme).toEqual({ dark: true, light: false })
  })

  it('tells the app when the page stopped, and loads it again in the theme', () => {
    expect(result.stopped).toBe(true)
    expect(result.reloaded).toEqual({ shown: true, dark: true })
  })

  it.each([
    "the app's origin",
    'about:srcdoc',
    'an origin main did not open',
    'a frame that never commits',
  ])('refuses the calls in flight and revokes the page for a frame on %s', (name) => {
    const refused = result.refused[name]!
    expect(refused.revoked).toBe(true)
    expect(refused.revocations).toBe(1)
    expect(
      refused.waits.every((wait) => typeof wait === 'string' && wait.startsWith('refused')),
    ).toBe(true)
  })

  it('opens a canvas of 24 pages with the calls it holds kept short', () => {
    expect(result.canvas.loaded).toBe(24)
    expect(result.canvas.trusted).toBe(true)
    const waits = [...result.canvas.waits].sort((a, b) => a - b)
    const p50 = waits[Math.floor(waits.length / 2)] ?? 0
    const max = waits.at(-1) ?? 0
    console.info(
      `Calls while 24 pages opened: ${waits.length}, p50 ${p50.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
    )
    expect(max).toBeLessThan(2_000)
  })
})
