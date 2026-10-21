#!/usr/bin/env node
// Captures the main screens of a production build in both themes, so the interface can be checked
// on platforms nobody runs by hand. It starts the app from `out/` with a fresh data folder and a
// scratch git project, drives it with the fake agent over the Chrome DevTools Protocol, and writes
// PNG files named <platform>-<screen>-<theme>.png. See docs/design/testing.md#screenshots.
//
//   pnpm build && node tools/screenshots/capture.mjs [--out screenshots] [--port 9230]
//
// On Linux CI, run it under `xvfb-run -a`.

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const out = resolve(valueOf('--out') ?? 'screenshots')
const port = Number(valueOf('--port') ?? 9230)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (text) => process.stderr.write(`${text}\n`)

mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'overbench-shots-'))
const userData = join(scratch, 'user-data')
const project = join(scratch, 'demo-project')

// A small repository on a branch with no upstream and one uncommitted change, so the top bar
// shows a branch, "Not published" and a change count.
mkdirSync(join(project, 'src'), { recursive: true })
const git = (...rest) => execFileSync('git', rest, { cwd: project, stdio: 'ignore' })
git('init', '-q', '-b', 'feat/login')
git('config', 'user.email', 'screenshots@example.com')
git('config', 'user.name', 'Screenshots')
writeFileSync(join(project, 'src', 'login.ts'), 'export const login = () => true\n')
git('add', '.')
git('commit', '-q', '-m', 'feat: add login')
writeFileSync(join(project, 'src', 'session.ts'), 'export const session = null\n')

const electron = createRequire(import.meta.url)('electron')
const app = spawn(
  electron,
  [
    '.',
    '--overbench-perf',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    // CI's Ubuntu restricts the user namespaces Chromium's sandbox needs; this run only reads.
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ],
  {
    cwd: resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      OVERBENCH_FAKE_AGENT: resolve(import.meta.dirname, '../fake-agent/main.ts'),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
)

let failed = false
try {
  await run()
} catch (error) {
  failed = true
  log(`Capture failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  app.kill()
  await sleep(1000)
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}
process.exit(failed ? 1 : 0)

async function connect() {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page) return open(page.webSocketDebuggerUrl)
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`No window answered on port ${port}`)
    await sleep(250)
  }
}

async function open(url) {
  const ws = new WebSocket(url)
  await new Promise((done, fail) => {
    ws.onopen = done
    ws.onerror = () => fail(new Error('Could not connect to the renderer'))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    const settle = data.id && pending.get(data.id)
    if (!settle) return
    pending.delete(data.id)
    settle(data)
  }
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const n = ++id
      pending.set(n, (data) =>
        data.error ? fail(new Error(`${method}: ${data.error.message}`)) : done(data.result),
      )
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`In the page: ${detail}`)
    }
    return result.result.value
  }
  return { send, evaluate, close: () => ws.close() }
}

async function run() {
  let cdp = await connect()
  const waitFor = async (expression, what, timeout = 60_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await cdp.evaluate(`Boolean(${expression})`).catch(() => false)) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${what}`)
  }
  const click = async (find, what, button = 'left') => {
    const point = await cdp.evaluate(`(() => {
      const el = (() => { ${find} })()
      if (!el) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!point) throw new Error(`Could not find ${what}`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, ...point, button, clickCount: 1 })
    }
  }
  const press = async (key, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: keyCode,
      })
    }
  }
  // Only the scale is emulated: the window keeps its real size, which the window controls
  // overlay on Windows and Linux is measured against.
  const setup = async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 0,
      height: 0,
      deviceScaleFactor: 2,
      mobile: false,
    })
    await waitFor('window.overbench', 'the preload')
  }
  const platform =
    process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
  // Each screen in the light theme, then the dark one; the theme class is what Settings sets.
  const shoot = async (name) => {
    for (const theme of ['light', 'dark']) {
      await cdp.evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
      await sleep(400)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(out, `${platform}-${name}-${theme}.png`), Buffer.from(shot.data, 'base64'))
    }
    await cdp.evaluate(`document.documentElement.classList.remove('dark')`)
    log(`captured ${name}`)
  }
  const byText = (selector, text) =>
    `return [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(text)}))`

  await setup()
  await waitFor(`document.querySelector('#root')?.childElementCount`, 'the first render')
  await sleep(1500)
  log(`window ${await cdp.evaluate('`${innerWidth} x ${innerHeight}`')}`)
  await shoot('welcome')

  await cdp.evaluate(
    `window.overbench.agents.request('projects.add', { path: ${JSON.stringify(project)} })`,
  )
  // The page picks the project up on load.
  await cdp.send('Page.reload')
  cdp.close()
  await sleep(1500)
  cdp = await connect()
  await setup()
  await waitFor(
    `[...document.querySelectorAll('[data-sidebar=menu-button]')].some((b) => b.textContent.startsWith('New session'))`,
    'the sidebar',
  )
  await click(
    `return [...document.querySelectorAll('[data-sidebar=menu-button]')].find((b) => b.textContent.startsWith('New session'))`,
    'New session',
  )
  await waitFor(
    `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Fake agent') && b.textContent.includes('Ready'))`,
    'the fake agent on the project home',
  )
  await sleep(800)
  await shoot('project-home')

  await click(
    `return [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Fake agent') && b.textContent.includes('Ready'))`,
    'the fake agent card',
  )
  await waitFor(
    `[...document.querySelectorAll('p')].some((p) => p.textContent.startsWith('What should'))`,
    'the new session',
  )
  const prompt = async (text) => {
    await cdp.evaluate(`document.querySelector('textarea').focus()`)
    // The trailing space closes the slash menu, which would otherwise take the Enter.
    await cdp.send('Input.insertText', { text: `${text} ` })
    await press('Enter', 13)
  }

  await prompt('/basic-turn')
  await waitFor(`document.querySelector('[aria-label=Stop]')`, 'the turn to start')
  await waitFor(`!document.querySelector('[aria-label=Stop]')`, 'the turn to end', 120_000)
  await sleep(800)
  // Overlay scrollbars take no room; classic ones do.
  const gutter = await cdp.evaluate(
    `(() => { const el = document.querySelector('[data-slot=message-scroller-viewport]'); return el.offsetWidth - el.clientWidth })()`,
  )
  log(`thread scrollbar ${gutter} px`)
  await shoot('session')

  await click(`return document.querySelector('button[aria-label=Model]')`, 'the model button')
  await waitFor(`document.querySelector('[role=menu]')`, 'the model menu')
  await sleep(400)
  await shoot('model-menu')
  await press('Escape', 27)
  await sleep(300)

  await prompt('/permission')
  await waitFor(
    `[...document.querySelectorAll('button')].some((b) => /allow/i.test(b.textContent))`,
    'the permission request',
  )
  await sleep(600)
  await shoot('permission')
  await click(byText('button', 'Allow'), 'Allow')
  await waitFor(`!document.querySelector('[aria-label=Stop]')`, 'the turn to end', 120_000)

  await click(`return document.querySelector('button[aria-label=Terminal]')`, 'the terminal toggle')
  await waitFor(`document.querySelector('[data-terminal-panel] .xterm')`, 'the terminal')
  // PowerShell takes a few seconds to print its first prompt on a CI runner.
  await sleep(5000)
  log(
    `terminal tabs ${await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('[data-terminal-panel] [role=tab]')].map((t) => t.textContent))`)}`,
  )
  await shoot('terminal')
  await click(`return document.querySelector('button[aria-label=Terminal]')`, 'the terminal toggle')
  await sleep(300)

  await click(
    `return [...document.querySelectorAll('[data-sidebar=menu-button]')].find((b) => b.textContent.includes('Fix the flaky login test'))`,
    'the session row',
    'right',
  )
  await waitFor(`document.querySelector('[role=menu]')`, 'the context menu')
  await sleep(400)
  await shoot('context-menu')
  await press('Escape', 27)
  await sleep(300)

  await click(
    `return [...document.querySelectorAll('button, a')].find((b) => b.textContent.trim().startsWith('Settings'))`,
    'Settings',
  )
  await waitFor(
    `[...document.querySelectorAll('nav button, aside button')].some((b) => b.textContent.trim() === 'General')`,
    'the Settings sections',
  )
  for (const section of ['General', 'Appearance', 'Agents', 'Terminal', 'About']) {
    await click(
      `return [...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent.trim() === ${JSON.stringify(section)})`,
      `Settings › ${section}`,
    )
    await sleep(600)
    await shoot(`settings-${section.toLowerCase()}`)
  }
  cdp.close()
}
