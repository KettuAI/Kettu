// Electron's main process for the isolation probe (isolation.process.test.ts), bundled by the test:
// main's real protocol, guards, frame guard, permissions and IPC around the real main window, with
// a stand-in for the agent host. It runs the steps below and writes what it saw to a file.

import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, session, shell, type WebFrameMain } from 'electron'
import { ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'
import type { IpcDeps } from '../ipc'
import { registerIpcHandlers } from '../ipc'
import { restrictPermissions } from '../permissions'
import { isRendererUrl } from '../renderer'
import { hasPendingFrame, isRevoked, watchSubframes } from '../subframes'
import { configureWindows, createMainWindow, WindowStateStore } from '../window'
import { Artifacts, disableDnsPrefetching } from '.'
import { ARTIFACT_SCHEME, artifactHost, originId } from './origins'
import { registerArtifactScheme, respond } from './protocol'

export interface ProbeConfig {
  resultFile: string
  contentDir: string
  /** The test's server, which records every request that reaches it. */
  server: string
  /** Serves the CSP when true; without it, main's own guards have to hold every attempt. */
  policy: boolean
  /** Each artifact's version file. */
  files: Record<string, string>
  probe: string
  canvas: string
  /** Opens, but its frame's request is never answered, so the frame never commits. */
  hang: string
  /** Served if opened, but never opened. */
  unopened: string
  /** Hosts the page names for DNS alone, and `control`, which main looks up itself. */
  exfil: Record<string, string> & { control: string }
  netLog: string
}

const config = JSON.parse(readFileSync(process.env.OVERBENCH_PROBE ?? '', 'utf8')) as ProbeConfig
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

registerArtifactScheme()
disableDnsPrefetching()
// No Dock icon, and no activation that would take the user's focus.
if (process.platform === 'darwin') app.setActivationPolicy('accessory')

/** The step the probe is on, for a run that never finishes. */
let stage = 'starting'

function report(result: unknown): void {
  try {
    writeFileSync(config.resultFile, JSON.stringify(result, null, 2))
    app.exit(0)
  } catch {
    // The test gave up on the run and took its folder away.
    app.exit(1)
  }
}

// The probe never outlives its test: it reports before the test's own timeout, and it ends when
// the test's process does, which a killed run would otherwise leave it running without.
setTimeout(() => report({ error: `The probe did not finish within 100 s, at ${stage}` }), 100_000)
const parent = Number(process.env.OVERBENCH_PROBE_PARENT)
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    app.exit(1)
  }
}, 500)

async function until<T>(read: () => Promise<T | null> | T | null, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > end) throw new Error(`Timed out after ${timeoutMs} ms`)
    await sleep(50)
  }
}

async function run(): Promise<unknown> {
  const opened: string[] = []
  shell.openExternal = async (url: string) => {
    opened.push(url)
  }
  const asked: string[] = []
  const content = (id: string): Promise<ArtifactContentResult> => {
    asked.push(id)
    const path = config.files[id]
    return Promise.resolve(
      path ? { kind: 'found', path, version: 1, title: 'Page' } : { kind: 'not_found' },
    )
  }
  const artifacts = new Artifacts({
    content,
    contentDir: config.contentDir,
    thumbnailDir: join(config.contentDir, '..', 'thumbnails'),
    importFile: () => Promise.resolve({ failed: 'unavailable' }),
  })
  const ses = session.defaultSession
  // The built-in resolver logs each DNS query, on every platform, which getaddrinfo does not.
  app.configureHostResolver({ enableBuiltInResolver: true, secureDnsMode: 'off' })
  await ses.netLog.startLogging(config.netLog)
  await artifacts.install(ses)
  // Main's protocol as serveArtifacts registers it, without the policy when the run has none, and
  // with no answer at all for the hang's frame: a host that never answers costs a frame only a 503,
  // which commits within the frame guard's timeout.
  const source = {
    contentDir: config.contentDir,
    artifactOf: (host: string) => artifacts.origins.artifactOf(host),
    content: (id: string) => content(id),
  }
  ses.protocol.unhandle(ARTIFACT_SCHEME)
  ses.protocol.handle(ARTIFACT_SCHEME, async (request) => {
    if (artifactHost(request.url) === originId(config.hang)) return new Promise<Response>(() => {})
    const response = await respond(request, source)
    if (config.policy) return response
    const headers = new Headers(response.headers)
    headers.delete('Content-Security-Policy')
    return new Response(response.body, { status: response.status, headers })
  })
  restrictPermissions(ses, isRendererUrl, (wc) => isRevoked(wc) || hasPendingFrame(wc))
  registerIpcHandlers({ artifacts, perf: false } as unknown as IpcDeps)

  let revocations = 0
  const inputs: { key: string; inArtifact: boolean }[] = []
  app.on('browser-window-created', (_, window) => {
    // Shown without focus, see-through and click-through, so a run never gets in the user's way.
    window.show = () => window.showInactive()
    window.setOpacity(0)
    window.setIgnoreMouseEvents(true)
    const contents = window.webContents
    watchSubframes(contents, {
      isOpenedArtifact: (url) => artifacts.origins.isOpenedIn(contents, url),
      onRevoked: () => revocations++,
    })
    artifacts.watchWindow(contents)
    contents.on('before-input-event', (_, input) => {
      if (input.type !== 'keyDown') return
      inputs.push({
        key: input.key,
        inArtifact: artifactHost(contents.focusedFrame?.origin) !== null,
      })
    })
  })
  configureWindows({
    state: await WindowStateStore.load(app.getPath('userData')),
    perf: false,
    systemLocale: 'en',
  })
  const window = createMainWindow()
  const contents = window.webContents
  await once(contents, 'did-finish-load')
  const page = <T>(script: string): Promise<T> => contents.executeJavaScript(script)
  const reload = async (): Promise<void> => {
    contents.reload()
    await once(contents, 'did-finish-load')
  }
  const frameOf = (id: string): WebFrameMain | undefined =>
    contents.mainFrame.frames.find((f) => {
      try {
        return artifactHost(f.origin) === originId(id)
      } catch {
        // A frame whose process stopped.
        return false
      }
    })
  // Creates a frame as the viewer does, then calls main while it is pending.
  const frameWithCalls = (src: string | { srcdoc: string }) =>
    page<{ waits: (number | string)[] }>(`(async () => {
      const frame = document.createElement('iframe')
      frame.sandbox = ${JSON.stringify(ARTIFACT_FRAME_SANDBOX)}
      frame.allow = ''
      frame.referrerPolicy = 'no-referrer'
      ${typeof src === 'string' ? `frame.src = ${JSON.stringify(src)}` : `frame.srcdoc = ${JSON.stringify(src.srcdoc)}`}
      document.body.append(frame)
      const calls = Array.from({ length: 5 }, () => {
        const start = performance.now()
        return overbench.ping().then(() => performance.now() - start, (error) => 'refused: ' + error.message)
      })
      return { waits: await Promise.all(calls) }
    })()`)

  // The probe: its frame, and the calls made while it was pending.
  stage = 'the attempts'
  const { url } = await page<{ url: string }>(`overbench.open(${JSON.stringify(config.probe)})`)
  const held = await frameWithCalls(url)
  const probeFrame = await until(() => frameOf(config.probe) ?? null, 10_000)
  const attempts = await until(async () => {
    const done = await probeFrame.executeJavaScript('window.__probe && window.__probe.done')
    return done
      ? (probeFrame.executeJavaScript('window.__probe.results') as Promise<unknown>)
      : null
  }, 60_000)
  // Read before the page loads again below, which starts the probe over.
  const camera = await probeFrame.executeJavaScript('window.__probe.camera')
  const metrics = app.getAppMetrics()
  const sandboxedOf = (pid: number) => metrics.find((m) => m.pid === pid)?.sandboxed ?? null
  const processes = {
    app: {
      pid: contents.mainFrame.osProcessId,
      sandboxed: sandboxedOf(contents.mainFrame.osProcessId),
    },
    page: { pid: probeFrame.osProcessId, sandboxed: sandboxedOf(probeFrame.osProcessId) },
  }

  // The page navigates itself to another host. The app's policy refuses it and leaves an error
  // page, so the frame loads the page again, as the viewer does.
  // A frame that runs no script, such as an error page, never answers.
  stage = 'leaving its origin'
  const ready = (id: string) =>
    until(async () => {
      const state = await Promise.race([
        frameOf(id)
          ?.executeJavaScript('document.readyState')
          .catch(() => null),
        sleep(500),
      ])
      return state === 'complete' || null
    }, 10_000).catch(() => false)
  const target = JSON.stringify(`${config.server}/navigate`)
  await probeFrame.executeJavaScript(`setTimeout(() => (location.href = ${target})); 1`)
  await until(async () => {
    const events = await page<{ channel: string }[]>('overbench.events()')
    return events.some((e) => e.channel === 'artifact:blocked') || null
  }, 5_000).catch(() => false)
  await page(`(() => { const f = document.querySelector('iframe'); f.src = f.src })()`)
  const afterNavigation = {
    restored: await ready(config.probe),
    trusted: !isRevoked(contents),
    appUrl: contents.mainFrame.url,
  }

  // An app shortcut typed in the page's frame, focused from the app's page as the viewer does. The
  // frame's own window.focus() would ask for the window's focus, which can land after the frame's.
  stage = 'the keys'
  await page(`document.querySelector('iframe').focus()`)
  await until(() => artifactHost(contents.focusedFrame?.origin) !== null || null, 5_000).catch(
    () => false,
  )
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: [mod] })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: [mod] })
  await sleep(300)

  // The page follows the app's theme. Each side is read until it matches or 3 s pass, and main's
  // and the app page's view are kept too, so a failure tells a late theme from a wrong one.
  stage = 'the theme'
  const darkQuery = `matchMedia('(prefers-color-scheme: dark)').matches`
  const darkOf = async (frame: WebFrameMain | undefined): Promise<boolean | null> => {
    const dark = await Promise.race([
      frame?.executeJavaScript(darkQuery).catch(() => null),
      sleep(500),
    ])
    return typeof dark === 'boolean' ? dark : null
  }
  const themeSeen = async (dark: boolean) => {
    const settled = async (read: () => Promise<boolean | null>) =>
      until(async () => ((await read()) === dark ? dark : null), 3_000).catch(read)
    return {
      main: nativeTheme.shouldUseDarkColors,
      app: await settled(() => darkOf(contents.mainFrame)),
      page: await settled(() => darkOf(frameOf(config.probe))),
    }
  }
  const themeIn = async (source: 'dark' | 'light') => {
    nativeTheme.themeSource = source
    return themeSeen(source === 'dark')
  }
  const theme = { dark: await themeIn('dark'), light: await themeIn('light') }
  // A theme change sends the page's preferences again, which must not turn DNS prefetching on.
  await frameOf(config.probe)!.executeJavaScript(`(() => {
    const link = document.createElement('link')
    link.rel = 'dns-prefetch'
    link.href = '//' + ${JSON.stringify(config.exfil.late)}
    document.head.append(link)
  })()`)

  // The page's process stops, and the frame loads again, still in the app's theme.
  stage = 'a stopped page'
  nativeTheme.themeSource = 'dark'
  process.kill(frameOf(config.probe)!.osProcessId, 'SIGKILL')
  const stopped = await until(async () => {
    const events = await page<{ channel: string }[]>('overbench.events()')
    return events.some((e) => e.channel === 'artifact:stopped') || null
  }, 5_000).catch(() => false)
  // A new frame, as the viewer makes: a page loaded into the old one would be light.
  await page(
    `(() => { const f = document.querySelector('iframe'); f.replaceWith(f.cloneNode()) })()`,
  )
  const reloaded = { shown: await ready(config.probe), theme: await themeSeen(true) }
  nativeTheme.themeSource = 'system'
  const events = await page<unknown[]>('overbench.events()')
  const trustedAfterProbe = !isRevoked(contents) && revocations === 0

  // Frames the guard must refuse, each made while calls are in flight.
  const refused: Record<string, unknown> = {}
  for (const [name, src] of [
    ["the app's origin", contents.mainFrame.url],
    ['about:srcdoc', { srcdoc: '<p>hi</p>' }],
    ['an origin main did not open', `${ARTIFACT_SCHEME}://${originId(config.unopened)}/`],
    ['a frame that never commits', null],
  ] as const) {
    stage = `a frame on ${name}`
    await reload()
    const before = revocations
    const target =
      src ?? (await page<{ url: string }>(`overbench.open(${JSON.stringify(config.hang)})`)).url
    const result = await frameWithCalls(target)
    refused[name] = { ...result, revoked: isRevoked(contents), revocations: revocations - before }
  }

  // A canvas of 24 pages, opening while calls go on.
  stage = 'the canvas'
  await reload()
  const canvas = await page<{ waits: number[]; loaded: number }>(`(async () => {
    const { url } = await overbench.open(${JSON.stringify(config.canvas)})
    const waits = []
    const calls = []
    const call = () => {
      const start = performance.now()
      calls.push(overbench.ping().then(() => waits.push(performance.now() - start)))
    }
    const pinging = setInterval(call, 4)
    call()
    let loaded = 0
    await Promise.all(Array.from({ length: 24 }, (_, i) => new Promise((resolve) => {
      const frame = document.createElement('iframe')
      frame.sandbox = ${JSON.stringify(ARTIFACT_FRAME_SANDBOX)}
      frame.style.width = '1280px'
      frame.style.height = '720px'
      frame.onload = () => resolve(++loaded)
      frame.src = url + '?page=0.' + (i + 1)
      document.body.append(frame)
    })))
    clearInterval(pinging)
    await Promise.all(calls)
    return { waits, loaded }
  })()`)
  const canvasTrusted = !isRevoked(contents)

  // A lookup of main's own, so the net log's silence on the page's hosts means something.
  stage = 'the net log'
  await ses.resolveHost(config.exfil.control).catch(() => null)
  await ses.netLog.stopLogging()
  const netLog = readFileSync(config.netLog, 'utf8')
  const dns = Object.fromEntries(
    Object.entries(config.exfil).map(([name, host]) => [name, netLog.includes(host)]),
  )
  const proxies = {
    cdn: await ses.resolveProxy('https://cdn.jsdelivr.net/npm/chart.js'),
    loopback: await ses.resolveProxy('http://localhost:5173/'),
    other: await ses.resolveProxy('https://example.com/'),
  }
  // electron-updater's own session, which keeps the system's proxy or the user's.
  const updaterProxy = await session
    .fromPartition('electron-updater', { cache: false })
    .resolveProxy('https://github.com/')

  return {
    dns,
    proxies,
    updaterProxy,
    held,
    attempts,
    camera,
    processes,
    afterNavigation,
    inputs,
    theme,
    stopped,
    reloaded,
    events,
    trustedAfterProbe,
    refused,
    canvas: { ...canvas, trusted: canvasTrusted },
    asked,
    opened,
    windows: BrowserWindow.getAllWindows().length,
  }
}

app
  .whenReady()
  .then(run)
  .then(report, (error: unknown) => report({ error: String((error as Error)?.stack ?? error) }))
