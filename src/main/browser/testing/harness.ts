// Process test harness: runs main's real browser views in Electron against a local fixture server,
// with no renderer. The parent test builds this file and starts it.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { Rectangle } from 'electron'
import type { BrowserState } from '@shared/browser'
import { BrowserOriginStore } from '../origins'
import { BrowserViews } from '../views'

const RESULT = process.env['OVERBENCH_BROWSER_RESULT']!
const FIXTURE = process.env['OVERBENCH_BROWSER_FIXTURE']!

interface Result {
  error?: string
  one?: string | null
  two?: string | null
  back?: string | null
  forward?: string | null
  download?: string | null
  popup?: string | null
  dialog?: string | null
  evicted?: string | null
  forbidden?: boolean
  layout?: { bounds: Rectangle; children: Rectangle[] }[]
}

async function main(): Promise<Result> {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const states = new Map<string, BrowserState>()
  const waiting: ((state: BrowserState) => void)[] = []
  const views = new BrowserViews({
    window: () => window,
    send: (state) => {
      states.set(state.sessionId, state)
      for (const check of [...waiting]) check(state)
    },
    origins: await BrowserOriginStore.load(path.dirname(RESULT)),
  })
  const waitFor = (
    sessionId: string,
    done: (state: BrowserState) => boolean,
  ): Promise<BrowserState> =>
    new Promise((resolve, reject) => {
      const seen = states.get(sessionId)
      if (seen && done(seen)) return resolve(seen)
      function check(state: BrowserState): void {
        if (state.sessionId !== sessionId || !done(state)) return
        clearTimeout(timer)
        waiting.splice(waiting.indexOf(check), 1)
        resolve(state)
      }
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(check), 1)
        reject(
          new Error(`Timed out waiting for ${sessionId}: ${JSON.stringify(states.get(sessionId))}`),
        )
      }, 15_000)
      waiting.push(check)
    })
  const loaded = (sessionId: string, path: string) =>
    waitFor(sessionId, (state) => !state.loading && (state.url?.endsWith(path) ?? false))
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

  const result: Result = {}
  const session = 's1'
  views.show(session)
  // Under a 48 px header, in a pane whose lower corners round by 12 px.
  views.setBounds(session, { x: 0, y: 48, width: 800, height: 600, radius: 12 })
  views.navigate(session, `${FIXTURE}/one`)
  result.one = (await loaded(session, '/one')).title
  result.layout = window.contentView.children.map((child) => ({
    bounds: child.getBounds(),
    children: child.children.map((inner) => inner.getBounds()),
  }))

  views.navigate(session, `${FIXTURE}/two`)
  result.two = (await loaded(session, '/two')).title

  views.back(session)
  result.back = (await loaded(session, '/one')).url

  views.forward(session)
  result.forward = (await loaded(session, '/two')).url

  views.navigate(session, `${FIXTURE}/download`)
  result.download = (await waitFor(session, (state) => state.notice?.kind === 'download-blocked'))
    .notice?.kind

  views.navigate(session, `${FIXTURE}/popup`)
  result.popup = (await loaded(session, '/two')).url

  // Give the page's dialog watcher a moment to be listening before the alert runs.
  views.navigate(session, `${FIXTURE}/one`)
  await loaded(session, '/one')
  await sleep(500)
  views.navigate(session, `${FIXTURE}/alert`)
  result.dialog = (await waitFor(session, (state) => state.title === 'after')).title

  // A fifth live page closes the least recently used one.
  for (let index = 2; index <= 5; index += 1) {
    const id = `s${index}`
    views.show(id)
    views.navigate(id, `${FIXTURE}/one`)
    await loaded(id, '/one')
    views.hide(id)
  }
  views.show(session)
  result.evicted = (await waitFor(session, (state) => state.notice?.kind === 'evicted')).notice
    ?.kind

  try {
    views.navigate(session, 'file:///etc/passwd')
    result.forbidden = false
  } catch {
    result.forbidden = true
  }

  return result
}

// The result is written before the app quits; without this, destroying the window could quit first.
app.on('window-all-closed', () => {})

process.on('uncaughtException', (error) => {
  process.stderr.write(`[harness] uncaught: ${error.message}\n`)
  void writeFile(RESULT, JSON.stringify({ error: error.message })).finally(() => app.exit(1))
})

void main().then(
  async (result) => {
    await writeFile(RESULT, JSON.stringify(result))
    app.quit()
  },
  async (error: unknown) => {
    await writeFile(RESULT, JSON.stringify({ error: (error as Error).message }))
    app.exit(1)
  },
)
