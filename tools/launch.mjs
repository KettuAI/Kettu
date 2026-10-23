// Starts the production build in `out/` for the tools that drive it over the Chrome DevTools
// Protocol (tools/screenshots, tools/perf): a fresh data folder, the fake agent, the perf flag and
// a debugging port. No dependencies.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * A small repository on a branch with no upstream and one uncommitted change, so the top bar
 * shows a branch, "Not published" and a change count.
 */
export function makeProject(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true })
  // Without the caller's GIT_DIR and the like, which git sets for hooks and `git bisect run`;
  // inherited, they would point these commands at the OverBench repository itself.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  const git = (...rest) => execFileSync('git', rest, { cwd: dir, stdio: 'ignore', env })
  git('init', '-q', '-b', 'feat/login')
  git('config', 'user.email', 'screenshots@example.com')
  git('config', 'user.name', 'Screenshots')
  writeFileSync(join(dir, 'src', 'login.ts'), 'export const login = () => true\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: add login')
  writeFileSync(join(dir, 'src', 'session.ts'), 'export const session = null\n')
}

export function launchApp({ port, userData, env = {} }) {
  const electron = createRequire(import.meta.url)('electron')
  return spawn(
    electron,
    [
      '.',
      '--overbench-perf',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      // CI's Ubuntu restricts the user namespaces Chromium's sandbox needs; these runs only read.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        OVERBENCH_FAKE_AGENT: join(root, 'tools', 'fake-agent', 'main.ts'),
        ...env,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )
}

/** Stops an app from `launchApp` and the processes it started, and waits for it to exit. */
export async function stopApp(app, timeout = 10_000) {
  if (app.exitCode !== null || app.signalCode !== null) return
  const exited = new Promise((done) => app.once('exit', done))
  // On Windows, kill() ends only the main process; the hosts and the terminal's shells would
  // keep files in the scratch folder open.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(app.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    app.kill()
  }
  await Promise.race([exited, sleep(timeout)])
}

/** Connects to the app's window, waiting for it to answer. */
export async function connect(port, timeout = 60_000) {
  const deadline = Date.now() + timeout
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

/** Adds a project and reloads the window, which picks it up on load; returns a new connection. */
export async function openProject(port, cdp, path) {
  await cdp.evaluate(
    `window.overbench.agents.request('projects.add', { path: ${JSON.stringify(path)} })`,
  )
  await cdp.send('Page.reload')
  cdp.close()
  await sleep(1500)
  return connect(port)
}
