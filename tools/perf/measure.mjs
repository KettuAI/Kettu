#!/usr/bin/env node
// Measures the M0 performance budgets (docs/milestones/m0.md) against a running OverBench.
//
// Start a production build with the fake agent, a debugging port and the perf flag, and open a
// project in it, then run this script. See docs/design/testing.md#measuring-performance.
//
//   pnpm build && pnpm exec electron-vite preview --skipBuild -- \
//     --overbench-perf --remote-debugging-port=9222
//   node tools/perf/measure.mjs [--port 9222] [--json]
//
// It drives the real UI with real input events, so leave the window alone while it runs.

const args = process.argv.slice(2)
const port = Number(valueOf('--port') ?? process.env.CDP_PORT ?? 9222)
const asJson = args.includes('--json')

function valueOf(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  } catch {
    throw new Error(
      `Nothing answers on port ${port}. Start OverBench with --remote-debugging-port=${port}.`,
    )
  }
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  if (!page) throw new Error('OverBench has no window open')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('Could not connect to the renderer'))
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
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, (data) =>
        data.error ? reject(new Error(`${method}: ${data.error.message}`)) : resolve(data.result),
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

const cdp = await connect()
const { send, evaluate } = cdp

async function waitFor(expression, { timeout = 30_000, what = expression } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** Clicks the centre of the first element `find` (a page-side function body) returns. */
async function click(find, what) {
  const rect = await evaluate(`(() => {
    const el = (() => { ${find} })()
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!rect) throw new Error(`Could not find ${what}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, ...rect, button: 'left', clickCount: 1 })
  }
}

async function key(keyName, { code = keyName, text, modifiers = 0, keyCode } = {}) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyName,
    code,
    text,
    modifiers,
    windowsVirtualKeyCode: keyCode,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    code,
    modifiers,
    windowsVirtualKeyCode: keyCode,
  })
}

const platform = await evaluate('window.overbench.platform')
const commandKey = platform === 'darwin' ? 4 : 2
if (!(await evaluate('Boolean(window.overbench.perf && window.__overbenchPerf)'))) {
  throw new Error('Start OverBench with --overbench-perf')
}

const shownSession = () =>
  evaluate(`document.querySelector('[data-session-id][aria-current=page]')?.dataset.sessionId`)
const sessionRow = (sessionId) =>
  `return document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]')`

const fakeAgentCard = `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Fake agent') && b.querySelector('[aria-label=Ready]'))`

// From a card on the project home, so the session is empty and ready before anything is measured;
// New session creates it with the first message instead.
async function newFakeSession() {
  if (!(await evaluate(`Boolean(${fakeAgentCard})`))) {
    // The first project's row comes first; its name opens the project home.
    await click(
      `return document.querySelector('[data-sidebar=menu-button][aria-expanded]')`,
      'the project in the sidebar',
    )
  }
  await waitFor(`Boolean(${fakeAgentCard})`, {
    what: 'the fake agent on the project home (open a project; packaged builds need OVERBENCH_FAKE_AGENT)',
  })
  await click(
    `return [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Fake agent') && b.querySelector('[aria-label=Ready]'))`,
    'the fake agent card',
  )
  // The empty thread's prompt appears once the agent has created the session.
  await waitFor(
    `[...document.querySelectorAll('p')].some((p) => p.textContent.startsWith('What should'))`,
    {
      what: 'the new session to be ready',
    },
  )
}

/** Sends a prompt through the composer and waits for its turn to end. */
async function runTurn(prompt, whileRunning) {
  await clearComposer()
  // The trailing space closes the slash menu, which would otherwise take the Enter.
  await send('Input.insertText', { text: `${prompt} ` })
  await key('Enter', { keyCode: 13, text: '\r' })
  await waitFor(`Boolean(document.querySelector('[aria-label=Stop]'))`, {
    what: 'the turn to start',
  })
  const started = Date.now()
  let typed = 0
  while (await evaluate(`Boolean(document.querySelector('[aria-label=Stop]'))`)) {
    if (whileRunning) typed += await whileRunning()
    else await sleep(100)
    if (Date.now() - started > 120_000) throw new Error(`"${prompt}" did not finish in 2 minutes`)
  }
  await sleep(500) // the frames after the turn ends belong to it too
  return typed
}

/** Observers for long animation frames, keystroke timing and frame intervals. */
async function startObserving() {
  await evaluate(`(() => {
    const run = (window.__measure = { loaf: [], events: [], typed: new Set(), toFrame: [], delivery: [], toInput: [], frames: [], stop: false })
    // Only the letters typed while the turn runs count, not the shortcuts that send or clear.
    // The event's timeStamp is when the browser took it in; the delay to this handler is delivery.
    run.onKey = (e) => { if (e.key === 'a' && !e.metaKey && !e.ctrlKey) { run.typed.add(e.timeStamp); run.lastKey = e.timeStamp; run.delivery.push(performance.now() - e.timeStamp) } }
    // Renderer side: from the key to the start of the frame after the one that shows the letter.
    // A timer would wait behind the agent's messages in the task queue and overstate it.
    run.onInput = () => {
      const start = run.lastKey
      run.lastKey = undefined
      if (start === undefined) return
      run.toInput.push(performance.now() - start)
      requestAnimationFrame(() => requestAnimationFrame(() => run.toFrame.push(performance.now() - start)))
    }
    document.addEventListener('keydown', run.onKey, true)
    document.addEventListener('input', run.onInput, true)
    run.observers = [
      new PerformanceObserver((list) => run.loaf.push(...list.getEntries().map((e) => e.duration))),
      new PerformanceObserver((list) => run.events.push(...list.getEntries()
        .filter((e) => e.name === 'keydown').map((e) => ({ start: e.startTime, duration: e.duration })))),
    ]
    run.observers[0].observe({ type: 'long-animation-frame' })
    run.observers[1].observe({ type: 'event', durationThreshold: 16 })
    let last = performance.now()
    const tick = (t) => { run.frames.push(t - last); last = t; if (!run.stop) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    window.__overbenchPerf.reset()
    return true
  })()`)
}

async function stopObserving() {
  return evaluate(`(() => {
    const run = window.__measure
    run.stop = true
    for (const o of run.observers) o.disconnect()
    document.removeEventListener('keydown', run.onKey, true)
    document.removeEventListener('input', run.onInput, true)
    const toFrame = run.toFrame.sort((a, b) => a - b)
    const delivery = run.delivery.sort((a, b) => a - b)
    const toInput = run.toInput.sort((a, b) => a - b)
    const slow = run.events.filter((e) => run.typed.has(e.start)).map((e) => e.duration)
    const sorted = run.frames.slice(2).sort((a, b) => a - b)
    const at = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0
    return {
      longFrames: run.loaf.length,
      longestFrame: Math.max(0, ...run.loaf, sorted.at(-1) ?? 0),
      frameP95: at(0.95),
      frameP99: at(0.99),
      keystrokesOver16: slow.length,
      slowestKeystroke: Math.max(0, ...slow),
      keystrokeDurations: slow.sort((a, b) => a - b),
      keyToFrameP95: toFrame.length ? toFrame[Math.min(toFrame.length - 1, Math.floor(toFrame.length * 0.95))] : null,
      keyToFrameMax: toFrame.at(-1) ?? null,
      deliveryP95: delivery.length ? delivery[Math.min(delivery.length - 1, Math.floor(delivery.length * 0.95))] : null,
      deliveryMax: delivery.at(-1) ?? null,
      toInputP95: toInput.length ? toInput[Math.min(toInput.length - 1, Math.floor(toInput.length * 0.95))] : null,
      updates: window.__overbenchPerf.frames(),
    }
  })()`)
}

async function typeWhileStreaming() {
  await evaluate(`document.querySelector('textarea').focus()`)
  await key('a', { code: 'KeyA', text: 'a', keyCode: 65 })
  await sleep(150)
  return 1
}

async function clearComposer() {
  await evaluate(`document.querySelector('textarea').focus()`)
  await key('a', { code: 'KeyA', modifiers: commandKey, keyCode: 65 })
  await key('Backspace', { keyCode: 8 })
}

const results = {}
const log = (text) => !asJson && process.stderr.write(`${text}\n`)

const metrics = await evaluate('window.overbench.app.perfMetrics()')
results.launch = metrics.launchToInteractiveMs

log('long-stream: 200 KB at 200 updates per second, typing in the composer…')
await newFakeSession()
await startObserving()
const keystrokes = await runTurn('/long-stream', typeWhileStreaming)
results.stream = { ...(await stopObserving()), keystrokes }
const streamSession = await shownSession()
await clearComposer()

log('tool-storm: 500 tool calls…')
await newFakeSession()
await startObserving()
await runTurn('/tool-storm')
results.storm = await stopObserving()
const stormSession = await shownSession()
const after = await evaluate('window.overbench.app.perfMetrics()')
const agentHost = after.processes.find((p) => p.name === 'OverBench Agent Host')
results.agentHostMB = agentHost ? agentHost.workingSetKB / 1024 : null

/** Closes the shown session through its menu, which returns to the project home. */
async function closeShownSession() {
  await click(
    `return document.querySelector('header [data-slot=dropdown-menu-trigger]')`,
    'the session menu',
  )
  await waitFor(
    `[...document.querySelectorAll('[role=menuitem]')].some((m) => m.textContent.trim() === 'Close')`,
    { what: 'the session menu' },
  )
  await click(
    `return [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Close')`,
    'Close',
  )
  await waitFor(`!document.querySelector('header [data-slot=dropdown-menu-trigger]')`, {
    what: 'the project home after Close',
  })
}

/**
 * Clicks a session's row and measures the switch: its first paint, then when it settled, the end
 * of the last frame over 50 ms before a second without one, and how many such frames there were.
 */
async function switchTo(sessionId, what) {
  await evaluate(`(() => {
    const probe = (window.__switchProbe = { t0: performance.now(), loaf: [] })
    probe.observer = new PerformanceObserver((list) => probe.loaf.push(...list.getEntries()))
    probe.observer.observe({ type: 'long-animation-frame' })
    window.__overbenchPerf.reset()
    return true
  })()`)
  await click(sessionRow(sessionId), what)
  await waitFor('window.__overbenchPerf.switches().length > 0', { timeout: 60_000, what })
  const quiet = `(() => {
    const { loaf, t0 } = window.__switchProbe
    const last = Math.max(t0 + window.__overbenchPerf.switches()[0].ms, ...loaf.map((f) => f.startTime + f.duration))
    return performance.now() - last > 1000
  })()`
  await waitFor(quiet, { timeout: 60_000, what: `${what} to settle` })
  return evaluate(`(() => {
    const { loaf, t0, observer } = window.__switchProbe
    observer.disconnect()
    const paint = window.__overbenchPerf.switches()[0].ms
    return {
      paint,
      settled: Math.max(paint, ...loaf.map((f) => f.startTime + f.duration - t0)),
      longFrames: loaf.length,
      longest: Math.max(0, ...loaf.map((f) => f.duration)),
    }
  })()`)
}

log('large-history: close and reopen a session with 1,000 entries, then switch to it…')
await newFakeSession()
await runTurn('/large-history')
const largeSession = await shownSession()
await closeShownSession()
results.reopen = await switchTo(largeSession, 'the reopened 1,000-entry session')
const entries = await evaluate(
  `document.querySelectorAll('[data-slot=message-scroller-item]').length`,
)
// Away to the tool-storm session and back: the switch the budget is about. Both stay mounted.
const switches = []
for (let i = 0; i < 5; i++) {
  await click(sessionRow(stormSession), 'the tool-storm session')
  await sleep(400)
  switches.push(await switchTo(largeSession, 'the 1,000-entry session'))
  await sleep(400)
}
const paints = switches.map((s) => s.paint).sort((a, b) => a - b)
results.switch = {
  median: paints[2],
  worst: paints.at(-1),
  settledWorst: Math.max(...switches.map((s) => s.settled)),
  longFrames: switches.reduce((n, s) => n + s.longFrames, 0),
  longest: Math.max(...switches.map((s) => s.longest)),
  items: entries,
}

log('large-history: close and reopen a session with 4,000 entries…')
await newFakeSession()
await runTurn('/large-history --entries 4000')
const hugeSession = await shownSession()
await closeShownSession()
results.reopen4k = await switchTo(hugeSession, 'the reopened 4,000-entry session')
await switchTo(stormSession, 'the tool-storm session')
await sleep(400)
results.switch4k = await switchTo(hugeSession, 'the 4,000-entry session')

log('evicted: back to the 1,000-entry session after four others…')
// Four other sessions shown after it drop its replica and unmount it.
await newFakeSession()
await switchTo(streamSession, 'the long-stream session')
await switchTo(stormSession, 'the tool-storm session')
results.evicted = await switchTo(largeSession, 'the evicted 1,000-entry session')

cdp.close()

if (asJson) {
  console.log(JSON.stringify(results, null, 2))
} else {
  const ms = (value) => (value === null || value === undefined ? 'n/a' : `${Math.round(value)} ms`)
  const rows = [
    [
      'App launch to first interactive frame',
      ms(results.launch),
      'under 500 ms',
      results.launch !== null && results.launch < 500,
    ],
    [
      'Store updates per frame while streaming (most)',
      String(results.stream.updates.maxPerFrame),
      'at most 1',
      results.stream.updates.maxPerFrame <= 1,
    ],
    [
      'Long frames over 50 ms, long-stream',
      `${results.stream.longFrames} (longest ${ms(results.stream.longestFrame)})`,
      'none',
      results.stream.longFrames === 0,
    ],
    [
      'Long frames over 50 ms, tool-storm',
      `${results.storm.longFrames} (longest ${ms(results.storm.longestFrame)})`,
      'none',
      results.storm.longFrames === 0,
    ],
    [
      'Switch to a 1,000-entry session, to first paint',
      `${ms(results.switch.median)} (worst ${ms(results.switch.worst)})`,
      'under 100 ms',
      results.switch.worst < 100,
    ],
    [
      'Keystroke to its frame while streaming (p95)',
      `${ms(results.stream.keyToFrameP95)} (slowest ${ms(results.stream.keyToFrameMax)})`,
      'under 16 ms',
      results.stream.keyToFrameP95 !== null && results.stream.keyToFrameP95 < 16,
    ],
    [
      'Agent host memory after tool-storm',
      results.agentHostMB === null ? 'n/a' : `${results.agentHostMB.toFixed(0)} MB`,
      'under 150 MB',
      results.agentHostMB !== null && results.agentHostMB < 150,
    ],
  ]
  const widths = [0, 1, 2].map((i) =>
    Math.max(...rows.map((r) => r[i].length), ['Budget', 'Result', 'Target'][i].length),
  )
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`
  console.log(line(['Budget', 'Result', 'Target']) + ' Pass |')
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|------|`)
  for (const row of rows) console.log(line(row.slice(0, 3)) + (row[3] ? ' yes  |' : ' NO   |'))
  console.log('')
  const sw = (r) =>
    `first paint ${ms(r.paint)}, settled ${ms(r.settled)}, ${r.longFrames} frames over 50 ms (longest ${ms(r.longest)})`
  console.log(
    `Reopening with session/load: 1,000 entries ${sw(results.reopen)}; 4,000 entries ${sw(results.reopen4k)}.`,
  )
  console.log(
    `Switches back to the 1,000-entry session: settled within ${ms(results.switch.settledWorst)}, ${results.switch.longFrames} frames over 50 ms in five (longest ${ms(results.switch.longest)}). To it after it was evicted: ${sw(results.evicted)}.`,
  )
  console.log(`Back to the 4,000-entry session: ${sw(results.switch4k)}.`)
  console.log(
    `Of the keystroke time, delivery from the browser to the renderer's handler: p95 ${ms(results.stream.deliveryP95)}, slowest ${ms(results.stream.deliveryMax)}; to the composer's input event: p95 ${ms(results.stream.toInputP95)}.`,
  )
  // Event Timing runs to the frame's presentation, so it includes the OS compositor as well.
  console.log(
    `Keystrokes through Event Timing, which includes the OS compositor: ${results.stream.keystrokesOver16} of ${results.stream.keystrokes} at 16 ms or more, slowest ${ms(results.stream.slowestKeystroke)}.`,
  )
  console.log(
    `Frame intervals, long-stream p95 ${ms(results.stream.frameP95)}, p99 ${ms(results.stream.frameP99)}; tool-storm p95 ${ms(results.storm.frameP95)}, p99 ${ms(results.storm.frameP99)}.`,
  )
  if (rows.some((row) => !row[3])) process.exitCode = 1
}
