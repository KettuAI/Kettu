// Process test harness: main's browser tools driven over the DevTools protocol in a real Electron
// page, against a local fixture server, with no renderer. The parent test builds this file and
// starts it.

import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import type { BrowserCallAnswer, BrowserControlState } from '@shared/browser'
import { BrowserTools } from '../tools'
import { BrowserViews } from '../views'

const RESULT = process.env['OVERBENCH_BROWSER_RESULT']!
const FIXTURE = process.env['OVERBENCH_BROWSER_FIXTURE']!

interface Answer {
  ok?: boolean
  text?: string
  value?: Record<string, unknown>
  image?: string
  error?: { code: string; message: string }
}

interface Result {
  error?: string
  snapshot?: string
  clicked?: string
  typed?: string
  pressed?: string
  scrolled?: string
  selected?: string
  shot?: { image?: number; value?: Record<string, unknown> }
  elementShot?: number
  waited?: string
  console?: { level: string; text: string }[]
  network?: { method: string; url: string; status: number | null }[]
  evaluated?: unknown
  stale?: string
  covered?: string
  control?: string
  dialog?: string
  frame?: string
  controlAfterTake?: BrowserControlState
  drivingDuringCall?: BrowserControlState
  drivingAfterCall?: BrowserControlState
  quitDialog?: string
}

function unwrap(answer: BrowserCallAnswer): Answer {
  if ('error' in answer) return { error: answer.error }
  return {
    ok: true,
    text: answer.result.text,
    value: answer.result.value,
    ...(answer.result.image ? { image: answer.result.image } : {}),
  }
}

async function main(): Promise<Result> {
  await app.whenReady()
  // Shown, so Chromium renders frames and the accessibility tree and captures do not stall; not
  // activated, so the pointer over it sends nothing the page takes as the user's.
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  window.showInactive()
  let browserTools: BrowserTools | null = null
  const views = new BrowserViews({
    window: () => window,
    send: () => {},
    dialogOpened: (sessionId, type, accepted) =>
      browserTools?.dialogOpened(sessionId, type, accepted),
    userInput: (sessionId) => browserTools?.userInput(sessionId),
    handBack: (sessionId) => browserTools?.handBack(sessionId),
    stopDriving: (sessionId) => browserTools?.stopDriving(sessionId),
    control: (sessionId) => browserTools?.control.state(sessionId) ?? { kind: 'none' },
    created: (sessionId, contents) => browserTools?.watch(sessionId, contents),
    closed: (sessionId) => browserTools?.forget(sessionId),
  })
  browserTools = new BrowserTools({
    views,
    controlChanged: () => {},
    opened: () => {},
    log: (level, message) => process.stderr.write(`[browser ${level}] ${message}\n`),
  })
  const tools = browserTools
  // A call that never settles names itself in the result, instead of hanging the whole run.
  const call = async (sessionId: string, tool: string, args: Record<string, unknown> = {}) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(`${tool} did not settle within 20 s`)), 20_000)
    })
    try {
      return unwrap(await Promise.race([tools.call(sessionId, tool, args), guard]))
    } finally {
      clearTimeout(timer)
    }
  }
  const session = 's1'
  views.show(session)
  views.setBounds(session, { x: 0, y: 48, width: 800, height: 600, radius: 12 })

  const result: Result = {}
  // While a call runs the pane shows the agent driving; between calls it shows nobody.
  const navigating = call(session, 'browser_navigate', { url: `${FIXTURE}/form` })
  await new Promise((done) => setTimeout(done, 100))
  result.drivingDuringCall = tools.control.state(session)
  const first = await navigating
  result.drivingAfterCall = tools.control.state(session)
  if (first.error) throw new Error(`navigate: ${first.error.code} ${first.error.message}`)
  result.snapshot = first.value?.snapshot as string

  const clicked = await call(session, 'browser_click', {
    ref: refOf(result.snapshot, 'Add row'),
    element: 'Add row button',
  })
  result.clicked = clicked.text

  const typed = await call(session, 'browser_type', {
    ref: refOf(result.snapshot, 'Email'),
    element: 'Email field',
    text: 'agent@example.com',
  })
  result.typed = typed.text

  const pressed = await call(session, 'browser_press_key', { key: 'Tab' })
  result.pressed = pressed.text

  const scrolled = await call(session, 'browser_scroll', { direction: 'down', amount: 1 })
  result.scrolled = scrolled.text

  const selected = await call(session, 'browser_select_option', {
    ref: refOf(result.snapshot, 'Plan'),
    element: 'Plan select',
    values: ['pro'],
  })
  result.selected = selected.text

  const waited = await call(session, 'browser_wait_for', { text: 'Row added', time: 2 })
  result.waited = waited.text

  const logged = await call(session, 'browser_console_messages', {})
  if (logged.error) throw new Error(`console: ${logged.error.code} ${logged.error.message}`)
  result.console = (logged.value?.messages as { level: string; text: string }[]).map((m) => ({
    level: m.level,
    text: m.text,
  }))

  const network = await call(session, 'browser_network_requests', {})
  result.network = (
    network.value?.requests as { method: string; url: string; status: number | null }[]
  )
    .filter((request) => request.url.startsWith(FIXTURE))
    .map(({ method, url, status }) => ({ method, url, status }))

  const evaluated = await call(session, 'browser_evaluate', {
    function: '() => document.title',
  })
  result.evaluated = evaluated.value?.value

  const shot = await call(session, 'browser_take_screenshot', {})
  result.shot = { image: shot.image?.length, value: shot.value }
  const elementShot = await call(session, 'browser_take_screenshot', {
    ref: refOf(result.snapshot, 'Email'),
  })
  result.elementShot = elementShot.image?.length

  // A ref from the page before a navigation is gone with it: refs start again at each page.
  const before = refOf(result.snapshot, 'Add row')
  await call(session, 'browser_navigate', { url: `${FIXTURE}/two` })
  const staleAfter = await call(session, 'browser_click', { ref: before, element: 'Add row' })
  result.stale = staleAfter.error?.code

  // A click whose centre another element covers fails and names it.
  await call(session, 'browser_navigate', { url: `${FIXTURE}/covered` })
  const covered = await call(session, 'browser_snapshot', {})
  const blocked = await call(session, 'browser_click', {
    ref: refOf(covered.value?.snapshot as string, 'Hidden button'),
  })
  result.covered = blocked.error?.message

  // The user types in the page: the next call fails with user_has_control.
  const page = views.contents(session)!
  page.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
  result.controlAfterTake = tools.control.state(session)
  const refused = await call(session, 'browser_snapshot', {})
  result.control = refused.error?.code
  tools.handBack(session)
  const allowed = await call(session, 'browser_snapshot', {})
  if (allowed.error)
    throw new Error(`Hand back did not let the agent drive: ${allowed.error.message}`)

  // A dialog does not block the call, and the result says what was answered.
  const alert = await call(session, 'browser_navigate', { url: `${FIXTURE}/alert` })
  result.dialog = alert.text

  // A same-origin frame's button shows in the outline under its iframe.
  await call(session, 'browser_navigate', { url: `${FIXTURE}/frame` })
  const framed = await call(session, 'browser_snapshot', {})
  result.frame = framed.value?.snapshot as string

  return result
}

/** The ref of the first line of an outline that holds `name`. */
function refOf(outline: string | undefined, name: string): string {
  const line = (outline ?? '')
    .split('\n')
    .find((text) => text.includes(name) && text.includes('[ref='))
  const match = /\[ref=(e\d+)\]/.exec(line ?? '')
  if (!match) throw new Error(`No ref for ${name} in:\n${outline}`)
  return match[1]!
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
