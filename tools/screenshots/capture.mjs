#!/usr/bin/env node
// Captures the main screens of a production build in both themes, so the interface can be checked
// on platforms nobody runs by hand. It starts the app from `out/` with a fresh data folder and a
// scratch git project, drives it with the fake agent over the Chrome DevTools Protocol, and writes
// PNG files named <platform>-<screen>-<theme>.png.
//
//   pnpm build && node tools/screenshots/capture.mjs [--out screenshots] [--port 9230]
//
// On Linux CI, run it under `xvfb-run -a`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect, launchApp, makeProject, openProject, stopApp } from '../launch.mjs'

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
makeHistory(project, join(scratch, 'origin.git'))
// Main logs this when it stops trusting a window; no screen should cause it.
const REFUSED = 'Refusing IPC and permissions from window'
let refused = false
const tails = new Map()
const userData = join(scratch, 'user-data')
const start = () =>
  launchApp({
    port,
    userData,
    onOutput: (text, stream) => {
      const seen = (tails.get(stream) ?? '') + text
      if (seen.includes(REFUSED)) refused = true
      tails.set(stream, seen.slice(-REFUSED.length))
    },
  })
let app = start()

// The page the browser pane opens, so a capture shows a real page and not just the pane's frame.
const fixture = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Demo app</title>
<style>
  :root { color-scheme: light }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #18181b; background: #fafafa }
  main { max-width: 560px; margin: 0 auto; padding: 56px 32px }
  h1 { font-size: 26px; letter-spacing: -0.01em; margin: 0 0 8px }
  p { color: #52525b; margin: 0 0 24px }
  .row { display: flex; gap: 8px }
  input { flex: 1; height: 36px; padding: 0 12px; border: 1px solid #d4d4d8; border-radius: 8px; font: inherit }
  button { height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #18181b; color: #fff; font: inherit; font-weight: 500 }
  a { color: #2563eb }
</style></head><body><main>
  <h1>Demo app</h1>
  <p>Local dev server · signed in as demo@example.com</p>
  <div class="row"><input value="A new todo" aria-label="Todo"><button>Add</button></div>
  <p style="margin-top:24px"><a href="/two">Second page</a></p>
</main></body></html>`)
})
await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`

let failed = false
try {
  await run()
} catch (error) {
  failed = true
  log(`Capture failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await stopApp(app)
  fixture.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}
if (refused) {
  failed = true
  log('Capture failed: the app refused IPC from its own window; see its log above')
}
process.exit(failed ? 1 : 0)

// A history for the branch popover: feat/login is one commit past its upstream's, two not pushed,
// main on the remote has moved on since the branch started, and two files are uncommitted.
function makeHistory(dir, remote) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  const git = (...rest) => execFileSync('git', rest, { cwd: dir, stdio: 'ignore', env })
  const commit = (file, text, message) => {
    writeFileSync(join(dir, file), text)
    git('add', file)
    git('commit', '-q', '-m', message)
  }
  git('init', '-q', '--bare', '-b', 'main', remote)
  git('branch', 'main')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', '-u', 'origin', 'main', 'feat/login')
  commit(
    'src/user.ts',
    'export const lastUser = () => null\n',
    'feat(login): remember the last user',
  )
  git('push', '-q')
  commit('src/clock.ts', 'export const now = () => Date.now()\n', 'fix(login): read the clock once')
  commit('src/clock.test.ts', 'export {}\n', 'test(login): freeze time in tests')
  git('checkout', '-q', 'main')
  commit('README.md', '# Demo\n', 'docs: describe the demo project')
  git('push', '-q', 'origin', 'main')
  git('checkout', '-q', 'feat/login')
  git('fetch', '-q', 'origin')
  writeFileSync(join(dir, 'src', 'login.ts'), 'export const login = (user: string) => !!user\n')
}

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
  const press = async (key, keyCode, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        windowsVirtualKeyCode: keyCode,
        modifiers,
      })
    }
  }
  const commandKey = process.platform === 'darwin' ? 4 : 2
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
  // Each screen in the light theme, then the dark one; the theme attribute is what Settings sets.
  // A clip, in CSS pixels, captures part of the window.
  const shoot = async (name, clip) => {
    for (const theme of ['light', 'dark']) {
      await cdp.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
      await sleep(400)
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        ...(clip && { clip: { ...clip, scale: 1 } }),
      })
      writeFileSync(join(out, `${platform}-${name}-${theme}.png`), Buffer.from(shot.data, 'base64'))
    }
    await cdp.evaluate(`document.documentElement.dataset.theme = 'light'`)
    log(`captured ${name}`)
  }
  const byText = (selector, text) =>
    `return [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(text)}))`

  await setup()
  // With no projects yet, the app opens on New session with none chosen.
  await waitFor(
    `[...document.querySelectorAll('h1')].some((h) => h.textContent.startsWith('What should'))`,
    'New session on first run',
  )
  await sleep(1500)
  log(`window ${await cdp.evaluate('`${innerWidth} x ${innerHeight}`')}`)
  await shoot('first-run')

  // With a project and no session to restore, the app opens on New session in that project.
  cdp = await openProject(port, cdp, project)
  await setup()
  await waitFor(
    `[...document.querySelectorAll('h1')].some((h) => h.textContent.startsWith('What should'))`,
    'New session at launch',
  )

  // A click, not the shortcut: on macOS the app menu owns Cmd+N, and input from here skips it.
  const openNewSession = async () => {
    await click(
      `return [...document.querySelectorAll('[data-sidebar=menu-button]')].find((b) => b.textContent.startsWith('New session'))`,
      'New session',
    )
    await waitFor(
      `[...document.querySelectorAll('h1')].some((h) => h.textContent.startsWith('What should'))`,
      'the New session screen',
    )
  }
  const agentButton = `document.querySelector('button[aria-label="Agent and model"]')`
  // The rail opens on the agent chosen, or the first installed one, which need not be the fake one.
  const openAgentMenu = async () => {
    await click(`return ${agentButton}`, 'the agent menu')
    // Right after launch the menu can open before the agents are listed.
    await waitFor(
      `[...document.querySelectorAll('[role=tab]')].some((t) => t.textContent.includes('Fake agent'))`,
      'the fake agent in the agent menu',
    )
    await click(byText('[role=tab]', 'Fake agent'), 'the fake agent in the menu')
  }

  await openNewSession()
  await openAgentMenu()
  // Until the fake agent has started its models are unknown, so its pane offers the agent.
  await click(byText('[role=option]', 'Use Fake agent'), 'Use Fake agent')
  await waitFor(
    `${agentButton}?.textContent.includes('Fake agent') && !document.querySelector('[role=tablist]')`,
    'the fake agent on the New session screen',
  )
  await sleep(400)
  await shoot('new-session')

  await click(`return document.querySelector('button[aria-label=Project]')`, 'the project menu')
  await waitFor(`document.querySelector('[role=listbox]')`, 'the project menu')
  await sleep(400)
  await shoot('new-session-project-menu')
  await press('Escape', 27)
  await sleep(300)

  const composerText = "document.querySelector('[data-slot=input-group] .cm-content')"
  const prompt = async (text) => {
    await cdp.evaluate(`${composerText}.focus()`)
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

  // The browser pane: empty, with a page, and under an overlay that would cover its native view.
  await click(`return document.querySelector('button[aria-label="Browser"]')`, 'the browser toggle')
  await waitFor(`Boolean(document.querySelector('[data-browser-panel]'))`, 'the browser pane')
  await sleep(300)
  await shoot('browser-empty')
  await cdp.evaluate(
    `document.querySelector('[data-browser-panel] input[aria-label="Address"]').focus()`,
  )
  await cdp.send('Input.insertText', { text: fixtureUrl })
  await press('Enter', 13)
  await waitFor(
    `document.querySelector('[data-browser-panel] input[aria-label="Address"]')?.value.includes('127.0.0.1')`,
    'the fixture page',
  )
  await sleep(1200)
  const maximize = await cdp.evaluate(`(() => {
    const r = document.querySelector('[data-browser-panel] button[aria-label="Maximize"]').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...maximize })
  await waitFor(
    `Boolean(document.querySelector('[data-browser-panel] img[aria-hidden]'))`,
    'the still of the page',
  )
  await sleep(500)
  await shoot('browser-overlay')
  // The same still without the tooltip that asked for it.
  await cdp.evaluate(
    `document.querySelectorAll('[data-overlay-layer]').forEach((el) => (el.style.visibility = 'hidden'))`,
  )
  await sleep(200)
  await shoot('browser-page')
  await cdp.evaluate(
    `document.querySelectorAll('[data-overlay-layer]').forEach((el) => (el.style.visibility = ''))`,
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
  await sleep(400)
  await click(
    `return [...document.querySelectorAll('[data-browser-panel] button')].find((b) => b.getAttribute('aria-label') === 'Close')`,
    'the browser pane close button',
  )
  await sleep(400)

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

  // Chinese notes between runs of work; the pointer rests beside the column, so no reply row shows.
  await prompt('/report')
  await waitFor(`document.body.textContent.includes('还没做的')`, 'the report', 60_000)
  await waitFor(`!document.querySelector('[aria-label=Stop]')`, 'the turn to end', 120_000)
  const beside = await cdp.evaluate(
    `(() => { const r = document.querySelector('[data-slot=message-scroller-viewport]').getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 } })()`,
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...beside })
  await sleep(800)
  await shoot('session-report')

  // A page for the artifact screens below; the fake agent makes it through the service.
  await prompt('/artifacts')
  await waitFor(`document.body.textContent.includes('Fake canvas')`, 'the artifact calls', 120_000)
  await waitFor(`!document.querySelector('[aria-label=Stop]')`, 'the artifact turn to end', 120_000)

  await click(`return document.querySelector('button[aria-label=Model]')`, 'the model button')
  await waitFor(`document.querySelector('[role=menu]')`, 'the model menu')
  await sleep(400)
  await shoot('model-menu')
  await press('Escape', 27)
  await sleep(300)

  // The @ popover with nothing typed: the files the turn read or edited.
  await cdp.evaluate(`${composerText}.focus()`)
  await cdp.send('Input.insertText', { text: '@' })
  await waitFor(`document.body.innerText.includes('Used in this session')`, 'the @ popover')
  await sleep(400)
  await shoot('mention')
  await press('Escape', 27)
  await press('a', 65, commandKey)
  await press('Backspace', 8)
  await sleep(300)

  // The composer's Markdown as drawn; unfocused, so every mark is hidden.
  await cdp.evaluate(`${composerText}.focus()`)
  const markdown = [
    '## Plan',
    'Keep **the key** out of `git`, as [the docs](https://example.com) say.',
    '- one',
    '> A quote',
  ]
  for (const [i, line] of markdown.entries()) {
    if (i > 0) await press('Enter', 13, 8)
    await cdp.send('Input.insertText', { text: line })
  }
  await cdp.evaluate(`document.activeElement.blur()`)
  await sleep(300)
  await shoot('composer-markdown')
  await cdp.evaluate(`${composerText}.focus()`)
  await press('a', 65, commandKey)
  await press('Backspace', 8)
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

  // The project row's menu, then the sessions the fake agent already has for the folder.
  await click(
    `return [...document.querySelectorAll('[data-sidebar=menu-button]')].find((b) => b.textContent.startsWith('demo-project'))`,
    'the project row',
    'right',
  )
  await waitFor(`document.querySelector('[role=menu]')`, 'the project menu')
  await sleep(400)
  await shoot('project-menu')
  await click(byText('[role=menuitem]', 'Import sessions'), 'Import sessions')
  await waitFor(
    `[...document.querySelectorAll('[role=dialog] li')].some((li) => li.textContent.includes('refactor the router'))`,
    'the sessions to import',
  )
  await sleep(400)
  await shoot('import-sessions')
  await press('Escape', 27)
  await sleep(300)

  // The branch popover, with the uncommitted files open, a commit's card, then a file's diff.
  await click(`return document.querySelector('button[aria-label^="Branch "]')`, 'the branch')
  await waitFor(`document.querySelector('[data-git-row]')`, 'the branch popover')
  await sleep(600)
  await shoot('git-popover')
  await click(byText('[data-git-row]', 'Uncommitted changes'), 'the uncommitted changes')
  await waitFor(
    `[...document.querySelectorAll('[data-git-row]')].some((r) => r.textContent.includes('session.ts'))`,
    'the uncommitted files',
  )
  await sleep(400)
  await shoot('git-popover-files')
  const commitRow = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-git-row]')].find((r) => r.textContent.includes('read the clock once'))
    const r = row.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...commitRow })
  await waitFor(`document.querySelector('[data-slot=hover-card-content]')`, 'the commit card')
  await sleep(600)
  await shoot('git-commit-card')
  await click(byText('[data-git-row]', 'login.ts'), 'the changed file')
  await waitFor(`document.querySelector('.diff.file-preview')`, 'the diff in the Files pane')
  await sleep(1500)
  await shoot('git-diff')
  await click(`return document.querySelector('button[aria-label="Close diff"]')`, 'Close diff')
  await sleep(300)
  // Push for real, to the scratch remote, then the popover in sync.
  await click(`return document.querySelector('button[aria-label^="Branch "]')`, 'the branch')
  await waitFor(`document.querySelector('[data-git-row]')`, 'the branch popover')
  await click(byText('button', 'Push'), 'Push')
  await waitFor(
    `[...document.querySelectorAll('p')].some((p) => p.textContent.startsWith('Up to date with'))`,
    'the push to finish',
  )
  await sleep(600)
  await shoot('git-popover-synced')
  await press('Escape', 27)
  await sleep(300)

  // With a session behind it, the menu lists the fake agent's models, levels and switches.
  await openNewSession()
  await openAgentMenu()
  await waitFor(
    `[...document.querySelectorAll('[role=option]')].some((o) => o.textContent.includes('Fake Deep'))`,
    "the fake agent's models",
  )
  await sleep(400)
  await shoot('new-session-agent-menu')
  await press('Escape', 27)
  await sleep(300)

  // The turns above are OverBench's own record, so the usage page has figures to show.
  await click(
    `return [...document.querySelectorAll('[data-sidebar=menu-button]')].find((b) => b.textContent.startsWith('Usage'))`,
    'the Usage row',
  )
  await waitFor(
    `[...document.querySelectorAll('h2')].some((h) => h.textContent.startsWith('Tokens per'))`,
    'the usage dashboard',
  )
  await sleep(600)
  const recorded = await cdp.evaluate(
    `window.overbench.agents.request('usage.total', { from: 0, to: Date.now() + 86400000 })`,
  )
  log(`usage recorded ${JSON.stringify(recorded)}`)
  await shoot('usage')
  await click(
    `return document.querySelector('button[aria-label="Choose a time range"]')`,
    'the range picker',
  )
  await waitFor(`document.querySelector('[data-slot=calendar]')`, 'the calendar')
  await sleep(400)
  await shoot('usage-range')
  // Typed dates are checked in place: a start after the end is said and holds Apply.
  const daysAgo = (n) => {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return [d.getFullYear(), d.getMonth() + 1, d.getDate()]
      .map((part) => String(part).padStart(2, '0'))
      .join('-')
  }
  for (const [field, value] of [
    ['End', daysAgo(10)],
    ['Start', daysAgo(5)],
  ]) {
    const input = `[...document.querySelectorAll('[data-slot=popover-content] label')].find((l) => l.textContent.startsWith(${JSON.stringify(field)}))?.querySelector('input')`
    await click(`return ${input}`, `the ${field} field`)
    // The start shows the end's day once the end alone is typed; typing replaces it.
    await cdp.evaluate(`${input}.select()`)
    await cdp.send('Input.insertText', { text: value })
  }
  await waitFor(
    `document.body.innerText.includes('The start is after the end')`,
    'the date order message',
  )
  await sleep(300)
  await shoot('usage-range-error')
  await press('Escape', 27)
  await sleep(300)

  // The artifact's page from the Artifacts list, with its Share popover open.
  await click(
    `return [...document.querySelectorAll('[data-sidebar=menu-button]')].find((b) => b.textContent.trim() === 'Artifacts')`,
    'the Artifacts row',
  )
  await waitFor(`document.querySelector('[data-artifact-card]')`, 'the artifact cards')
  await click(
    `return [...document.querySelectorAll('[data-artifact-card]')].find((c) => c.textContent.includes('Fake canvas'))`,
    'the Fake canvas card',
  )
  await waitFor(
    `document.querySelector('button[aria-label="Share"]') && [...document.querySelectorAll('h1')].some((h) => h.textContent.includes('Fake canvas'))`,
    'the artifact viewer',
  )
  await sleep(1200)
  await click(`return document.querySelector('button[aria-label="Share"]')`, 'Share')
  await waitFor(`document.querySelector('[data-slot=popover-content]')`, 'the Share popover')
  await sleep(400)
  await shoot('artifact-share')
  await press('Escape', 27)
  await sleep(300)

  await click(
    `return document.querySelector('[data-sidebar=footer] button[aria-label="Settings"]')`,
    'Settings',
  )
  await waitFor(
    `[...document.querySelectorAll('nav button, aside button')].some((b) => b.textContent.trim() === 'General')`,
    'the Settings sections',
  )
  const sections = [
    'General',
    'Appearance',
    'Notifications',
    'Keyboard shortcuts',
    'Agents',
    'Usage',
    'Terminal',
    'Git',
    'Browser',
    'Sharing',
    'Advanced',
    'About',
  ]
  for (const section of sections) {
    await click(
      `return [...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent.trim() === ${JSON.stringify(section)})`,
      `Settings › ${section}`,
    )
    await sleep(600)
    await shoot(`settings-${section.toLowerCase().replaceAll(' ', '-')}`)
  }

  // An agent's own page, opened from its row in the list.
  await click(
    `return [...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent.trim() === 'Agents')`,
    'Settings › Agents',
  )
  await click(
    `return document.querySelector('button[aria-label="Fake agent"]')`,
    'the fake agent row',
  )
  await waitFor(
    `[...document.querySelectorAll('main h2')].some((h) => h.textContent.includes('Fake agent'))`,
    'the fake agent page',
  )
  await sleep(600)
  await shoot('settings-agent')

  await click(`return document.querySelector('aside input')`, 'the Settings search')
  await cdp.send('Input.insertText', { text: 'proxy' })
  await waitFor(
    `[...document.querySelectorAll('main h2')].some((h) => h.textContent === 'Search results')`,
    'the search results',
  )
  await sleep(400)
  await shoot('settings-search')
  await press('Escape', 27)
  await sleep(300)

  await click(
    `return [...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent.trim() === 'General')`,
    'Settings › General',
  )
  await click(
    `return document.querySelector('[data-slot=select-trigger]')`,
    'the Default agent select',
  )
  await waitFor(`document.querySelector('[data-slot=select-content]')`, 'the select list')
  await sleep(400)
  await shoot('settings-select')
  await press('Escape', 27)
  await sleep(300)

  // Last, since the crash closes the fake agent's sessions: a running turn's status line, then
  // the line that ends a turn the agent's exit cut short.
  // Escape outside a field closes Settings, so the one above may have closed it already.
  const back = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Back')`
  if (await cdp.evaluate(`Boolean(${back})`)) await click(`return ${back}`, 'Back')
  await click(
    `return [...document.querySelectorAll('[data-sidebar=menu-button]')].find((b) => b.textContent.includes('Fix the flaky login test'))`,
    'the session row',
  )
  await waitFor(composerText, 'the composer')
  await prompt('/long-turn')
  await waitFor(
    `[...document.querySelectorAll('[role=status]')].some((s) => s.textContent.includes('tokens') && s.textContent.includes('Running a command'))`,
    'the running turn to run a command',
  )
  await shoot('session-running')
  await click(`return document.querySelector('[aria-label=Stop]')`, 'Stop')
  await waitFor(`!document.querySelector('[aria-label=Stop]')`, 'the turn to stop', 120_000)
  await prompt('/crash')
  await waitFor(`${byText('button', 'Resume').slice('return '.length)}`, 'Resume')
  await sleep(600)
  await shoot('session-agent-exited')

  // The sidebar footer and its notices, in a launch after an update, so the "Updated to" notice
  // shows beside the fake agent's sign-in; agent updates need a package agent's npm check and the
  // other update notices a packaged build. The steps also check how the notices popover behaves.
  cdp.close()
  await stopApp(app)
  const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json')))
  writeFileSync(
    join(userData, 'app-state.json'),
    JSON.stringify({ version: 1, lastRunVersion: versionBefore(version), dismissedUpdate: null }),
  )
  app = start()
  cdp = await connect(port)
  await setup()
  await waitFor(`document.querySelector('[data-sidebar=footer]')`, 'the sidebar footer')
  const fake = (method, params = '') =>
    cdp.evaluate(
      `window.overbench.agents.request('agents.${method}', { agentId: 'fake-agent'${params} })`,
    )
  await fake('logout')
  await footerScreens({ suffix: '', dismiss: 'Dismiss', agents: 'Agents' })
  await cdp.evaluate(`window.overbench.settings.update({ general: { language: 'zh-CN' } })`)
  // A reload brings back the dismissed "Updated to" notice, which is dismissed for the page only.
  await cdp.send('Page.reload')
  cdp.close()
  await sleep(1500)
  cdp = await connect(port)
  await setup()
  await footerScreens({ suffix: '-zh', dismiss: '忽略', agents: 'Agent' })
  cdp.close()

  // Starts with the fake agent signed out and "Updated to" showing, and ends signed out.
  async function footerScreens({ suffix, dismiss, agents }) {
    const footer = '[data-sidebar=footer]'
    const pill = `document.querySelector('${footer} button[aria-haspopup=dialog]')`
    const popover = `document.querySelector('[data-slot=popover-content]:not([data-closed])')`
    const rows = `[...document.querySelectorAll('[data-slot=popover-content]:not([data-closed]) [data-row-hit]')].map((b) => b.getAttribute('aria-label'))`
    const shootFooter = async (name) => {
      // Script focus after this tool's input draws the focus ring, which a click would not.
      await cdp.evaluate(`${popover}?.focus()`)
      const clip = await cdp.evaluate(`(() => {
        const f = document.querySelector('${footer}').getBoundingClientRect()
        const p = ${popover}?.getBoundingClientRect()
        const top = Math.min(f.top, p ? p.top : f.top) - 16
        return { x: 0, y: top, width: Math.max(f.right, p ? p.right : 0) + 16, height: f.bottom - top }
      })()`)
      await shoot(`footer-${name}${suffix}`, clip)
    }
    const openNotices = async () => {
      await click(`return ${pill}`, 'the notices pill')
      await waitFor(popover, 'the notices popover')
      await sleep(300)
    }

    await waitFor(`${pill}?.textContent.startsWith('2')`, 'two notices')
    await shootFooter('two')
    await openNotices()
    await waitFor(
      `(() => { const r = ${rows}; return r.length === 2 && r[0].startsWith('Fake agent') })()`,
      'the sign-in row before the update row',
    )
    await shootFooter('popover')
    await click(
      `return document.querySelector('[data-slot=popover-content] [data-notice-row] button[aria-label="${dismiss}"]')`,
      'the dismiss button of the update row',
    )
    await waitFor(`${popover} && ${rows}.length === 1`, 'the dismissed row to go, the popover open')
    await press('Escape', 27)
    await waitFor(`!${popover}`, 'the popover to close')
    await shootFooter('one')
    await openNotices()
    await click(`return document.querySelector('[data-row-hit]')`, 'the sign-in row')
    await waitFor(
      `!${popover} && document.querySelector('[aria-current=page]')?.textContent.trim() === '${agents}'`,
      'Settings › Agents, the popover closed',
    )
    await press('Escape', 27)
    await waitFor(`${pill}`, 'the sidebar again')
    await openNotices()
    await fake('authenticate', `, methodId: 'fake-login'`)
    await waitFor(`!${popover} && !${pill}`, 'the popover to close with its last notice')
    await sleep(300)
    await shootFooter('none')
    await fake('logout')
    await waitFor(pill, 'the sign-in notice')
    const edge = await cdp.evaluate(`(() => {
      const r = document.querySelector('[data-slot=resizable-handle]').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    // Dragging the edge past the sidebar's 200 px minimum leaves it at the minimum.
    const drag = async (from, to) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...from,
        button: 'left',
        clickCount: 1,
      })
      for (let step = 1; step <= 10; step++) {
        const x = from.x + ((to.x - from.x) * step) / 10
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y: from.y,
          button: 'left',
          buttons: 1,
        })
      }
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...to,
        button: 'left',
        clickCount: 1,
      })
      await sleep(400)
    }
    const state = () =>
      cdp.evaluate(
        `JSON.stringify({ footer: document.querySelector('${footer}')?.getBoundingClientRect().width, handles: [...document.querySelectorAll('[data-slot=resizable-handle]')].map((h) => h.getBoundingClientRect().left), pill: ${pill}?.innerText, at: document.elementFromPoint(${edge.x}, ${edge.y})?.className.slice(0, 60), visible: document.visibilityState, focus: document.hasFocus(), dpr: devicePixelRatio, size: [innerWidth, innerHeight] })`,
      )
    log(`before the drag${suffix}: ${JSON.stringify(edge)} ${await state()}`)
    await drag(edge, { x: 120, y: edge.y })
    log(`after the drag${suffix}: ${await state()}`)
    await sleep(2000)
    log(`2 s after the drag${suffix}: ${await state()}`)
    await waitFor(
      `document.querySelector('${footer}').getBoundingClientRect().width === 200 && ${pill}.innerText.trim() === '1'`,
      'the compact pill at the minimum width',
    )
    await shootFooter('compact')
    await drag({ x: 200, y: edge.y }, edge)
  }
}

// A version just below the app's, which main reads as the one that ran before an update.
function versionBefore(version) {
  const [major, minor, patch] = version.split(/[.+-]/).map(Number)
  if (patch > 0) return `${major}.${minor}.${patch - 1}`
  if (minor > 0) return `${major}.${minor - 1}.0`
  if (major > 0) return `${major - 1}.0.0`
  return `${version}-0`
}
