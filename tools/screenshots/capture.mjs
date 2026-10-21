#!/usr/bin/env node
// Captures the main screens of a production build in both themes, so the interface can be checked
// on platforms nobody runs by hand. It starts the app from `out/` with a fresh data folder and a
// scratch git project, drives it with the fake agent over the Chrome DevTools Protocol, and writes
// PNG files named <platform>-<screen>-<theme>.png. See docs/design/testing.md#screenshots.
//
//   pnpm build && node tools/screenshots/capture.mjs [--out screenshots] [--port 9230]
//
// On Linux CI, run it under `xvfb-run -a`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect, launchApp, makeProject, openProject } from '../launch.mjs'

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
const project = join(scratch, 'demo-project')
makeProject(project)
const app = launchApp({ port, userData: join(scratch, 'user-data') })

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

async function run() {
  let cdp = await connect(port)
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

  // With a project and no session to restore, the app opens on the project's home.
  cdp = await openProject(port, cdp, project)
  await setup()
  await waitFor(
    `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Fake agent') && b.textContent.includes('Ready'))`,
    'the fake agent on the project home',
  )
  await sleep(800)
  await shoot('project-home')

  // A click, not the shortcut: on macOS the app menu owns Cmd+N, and input from here skips it.
  await click(
    `return [...document.querySelectorAll('[data-sidebar=menu-button]')].find((b) => b.textContent.startsWith('New session'))`,
    'New session',
  )
  await waitFor(`document.querySelector('button[aria-label=Agent]')`, 'the New session screen')
  await click(`return document.querySelector('button[aria-label=Agent]')`, 'the agent menu')
  await waitFor(`document.querySelector('[role=menu]')`, 'the agent menu')
  await click(byText('[role=menuitemradio]', 'Fake agent'), 'the fake agent')
  await waitFor(
    `[...document.querySelectorAll('p')].some((p) => p.textContent.startsWith('What should'))`,
    'the fake agent on the New session screen',
  )
  await sleep(400)
  await shoot('new-session')

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
  // Overlay scrollbars show only while the view scrolls, so this one is taken mid-scroll.
  const thread = await cdp.evaluate(
    `(() => { const r = document.querySelector('[data-slot=message-scroller-viewport]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`,
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...thread })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...thread,
    deltaX: 0,
    deltaY: -400,
  })
  await sleep(150)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(
    join(out, `${platform}-session-scrolling-light.png`),
    Buffer.from(shot.data, 'base64'),
  )
  log('captured session-scrolling')

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
