#!/usr/bin/env node
// Captures the main screens of a production build in both themes, so the interface can be checked
// on platforms nobody runs by hand. It starts the app from `out/` with a fresh data folder and a
// scratch git project, drives it with the fake agent over the Chrome DevTools Protocol, and writes
// PNG files named <platform>-<screen>-<theme>.png. See docs/design/testing.md#screenshots.
//
//   pnpm build && node tools/screenshots/capture.mjs [--out screenshots] [--port 9230]
//
// On Linux CI, run it under `xvfb-run -a`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const app = launchApp({ port, userData: join(scratch, 'user-data') })

let failed = false
try {
  await run()
} catch (error) {
  failed = true
  log(`Capture failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await stopApp(app)
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
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

  await click(
    `return [...document.querySelectorAll('button, a')].find((b) => b.textContent.trim().startsWith('Settings'))`,
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
  cdp.close()
}
