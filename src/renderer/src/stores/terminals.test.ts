import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalEvent, TerminalInfo } from '@shared/terminal-host'

const request = vi.fn()
const hostRequest = vi.fn()
let emit!: (event: TerminalEvent) => void
vi.stubGlobal('window', {
  kettu: {
    hosts: { request: hostRequest },
    terminals: {
      request,
      onEvent: (handler: (event: TerminalEvent) => void) => {
        emit = handler
        return () => undefined
      },
      onConnection: () => () => undefined,
    },
  },
})

const { fromHostTerminalEvent } = await import('@renderer/lib/host')
const { hostOfPath, onHost } = await import('@renderer/lib/host-paths')
const { createLayout, splitAt } = await import('@renderer/features/split/layout')
const { useViewStore } = await import('./view')
const {
  createTerminal,
  endTerminals,
  findLocalUrl,
  focusTerminalSide,
  finishTerminalLoad,
  forgetTerminal,
  initTerminals,
  loadTerminals,
  interruptTerminal,
  killTerminal,
  reattachTerminals,
  restartTerminal,
  setSink,
  showTerminal,
  takeOverTerminal,
  takeTerminalEvent,
  moveTerminal,
  orderTerminals,
  renameTerminal,
  replaceStale,
  terminalsOf,
  trackTerminalOpen,
  toggleSplit,
  useTerminalsStore,
} = await import('./terminals')

initTerminals()

const info = (id: string, createdAt: number, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  projectPath: '/repo',
  shell: 'zsh',
  title: 'zsh',
  busy: false,
  exitCode: null,
  createdAt,
  ...extra,
})

const add = (...list: TerminalInfo[]) => {
  for (const item of list) emit({ type: 'terminal.info', info: item })
}
const state = () => useTerminalsStore.getState()
const tabs = (projectPath = '/repo') =>
  terminalsOf(state().byId, projectPath, state().order[projectPath]).map((t) => t.id)

beforeEach(() => {
  request.mockReset()
  hostRequest.mockReset()
  useTerminalsStore.setState({
    byId: {},
    active: {},
    order: {},
    split: {},
    focusedSide: {},
    connection: 'connected',
    error: null,
  })
})

describe('orderTerminals', () => {
  const list = [
    { id: 'a', createdAt: 1 },
    { id: 'b', createdAt: 2 },
    { id: 'c', createdAt: 3 },
  ]
  const ids = (order?: string[]) => orderTerminals(list, order).map((t) => t.id)

  it('keeps creation order without a stored order', () => {
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(orderTerminals([...list].reverse()).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('follows the stored order', () => {
    expect(ids(['c', 'a', 'b'])).toEqual(['c', 'a', 'b'])
  })

  it('appends terminals the order does not name, by creation time', () => {
    expect(ids(['c'])).toEqual(['c', 'a', 'b'])
    expect(orderTerminals([...list].reverse(), ['b']).map((t) => t.id)).toEqual(['b', 'a', 'c'])
  })

  it('drops ids of terminals that are gone', () => {
    expect(ids(['x', 'c', 'y', 'a'])).toEqual(['c', 'a', 'b'])
  })

  it('does not change its input', () => {
    const input = [...list].reverse()
    orderTerminals(input, ['b'])
    expect(input.map((t) => t.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('terminalsOf', () => {
  it('lists one project, in its order', () => {
    add(info('a', 1), info('b', 2), info('x', 3, { projectPath: '/other' }))
    moveTerminal('/repo', 'b', 0)
    expect(tabs()).toEqual(['b', 'a'])
    expect(tabs('/other')).toEqual(['x'])
  })
})

describe('renameTerminal', () => {
  it('starts with no name, so the tab follows the process', () => {
    add(info('a', 1))
    expect(state().byId.a!.name).toBeNull()
  })

  it('sets a trimmed name', () => {
    add(info('a', 1))
    renameTerminal('a', '  server  ')
    expect(state().byId.a!.name).toBe('server')
  })

  it('returns to the automatic title on a blank name', () => {
    add(info('a', 1))
    renameTerminal('a', 'server')
    renameTerminal('a', '   ')
    expect(state().byId.a!.name).toBeNull()
  })

  it('ignores an unknown terminal', () => {
    renameTerminal('missing', 'server')
    expect(state().byId).toEqual({})
  })

  it('survives the host updating the terminal', () => {
    add(info('a', 1))
    renameTerminal('a', 'server')
    add(info('a', 1, { title: 'vim', busy: true }))
    expect(state().byId.a).toMatchObject({ name: 'server', title: 'vim', busy: true })
    add(info('a', 1, { exitCode: 0, busy: false }))
    expect(state().byId.a).toMatchObject({ name: 'server', exitCode: 0 })
  })
})

describe('moveTerminal', () => {
  it('moves a tab and keeps the order', () => {
    add(info('a', 1), info('b', 2), info('c', 3))
    moveTerminal('/repo', 'a', 2)
    expect(tabs()).toEqual(['b', 'c', 'a'])
    moveTerminal('/repo', 'c', 0)
    expect(tabs()).toEqual(['c', 'b', 'a'])
    expect(state().order['/repo']).toEqual(['c', 'b', 'a'])
  })

  it('puts a new terminal at the end', () => {
    add(info('a', 1), info('b', 2))
    moveTerminal('/repo', 'b', 0)
    add(info('c', 3))
    expect(tabs()).toEqual(['b', 'a', 'c'])
  })

  it('keeps each project on its own', () => {
    add(
      info('a', 1),
      info('b', 2),
      info('x', 3, { projectPath: '/other' }),
      info('y', 4, { projectPath: '/other' }),
    )
    moveTerminal('/repo', 'b', 0)
    expect(tabs('/repo')).toEqual(['b', 'a'])
    expect(tabs('/other')).toEqual(['x', 'y'])
  })

  it('clamps the place to the row', () => {
    add(info('a', 1), info('b', 2), info('c', 3))
    moveTerminal('/repo', 'a', 99)
    expect(tabs()).toEqual(['b', 'c', 'a'])
    moveTerminal('/repo', 'a', -5)
    expect(tabs()).toEqual(['a', 'b', 'c'])
  })

  it('leaves the state alone when nothing moves', () => {
    add(info('a', 1), info('b', 2))
    const before = state()
    moveTerminal('/repo', 'a', 0)
    moveTerminal('/repo', 'missing', 1)
    expect(state()).toBe(before)
  })
})

describe('forgetTerminal', () => {
  it('removes the terminal from the order', () => {
    add(info('a', 1), info('b', 2), info('c', 3))
    moveTerminal('/repo', 'c', 0)
    emit({ type: 'terminal.removed', id: 'a' })
    expect(state().order['/repo']).toEqual(['c', 'b'])
    forgetTerminal('c')
    forgetTerminal('b')
    expect(state().order['/repo']).toBeUndefined()
  })

  it('shows the last tab of the row when the shown one goes', () => {
    add(info('a', 1), info('b', 2), info('c', 3))
    moveTerminal('/repo', 'c', 0)
    useTerminalsStore.setState({ active: { '/repo': 'b' } })
    forgetTerminal('b')
    expect(state().active['/repo']).toBe('a')
  })
})

describe('an empty terminal panel', () => {
  const pane = () => useViewStore.getState().sidePane['/repo']
  const otherPane = () => useViewStore.getState().sidePane['/other']

  beforeEach(() => {
    useViewStore.setState({
      projectPath: '/repo',
      main: { kind: 'session', sessionId: 's' },
      layout: createLayout({ kind: 'session', sessionId: 's', projectPath: '/repo' }),
      sidePane: { '/repo': 'terminal' },
      splitSidePane: null,
      sidePaneMaximized: false,
    })
  })

  it('closes the panel when the last tab is removed', () => {
    add(info('a', 1))
    forgetTerminal('a')
    expect(state().byId.a).toBeUndefined()
    expect(pane()).toBeUndefined()
  })

  it('closes from the host removing the last tab', () => {
    add(info('a', 1), info('b', 2))
    emit({ type: 'terminal.removed', id: 'a' })
    expect(pane()).toBe('terminal')
    emit({ type: 'terminal.removed', id: 'b' })
    expect(pane()).toBeUndefined()
  })

  it('keeps the panel while another tab remains', () => {
    add(info('a', 1), info('b', 2))
    forgetTerminal('a')
    expect(state().byId.b).toBeDefined()
    expect(pane()).toBe('terminal')
  })

  it('keeps an exited tab and its output in the panel', () => {
    add(info('a', 1), info('b', 2))
    add(info('b', 2, { exitCode: 0, busy: false }))
    forgetTerminal('a')
    expect(state().byId.b).toMatchObject({ exitCode: 0 })
    expect(pane()).toBe('terminal')
  })

  it('does not close the panel when the only tab exits', () => {
    add(info('a', 1))
    add(info('a', 1, { exitCode: 1, busy: false }))
    expect(state().byId.a).toMatchObject({ exitCode: 1 })
    expect(pane()).toBe('terminal')
  })

  it('does not close another project’s panel', () => {
    add(info('a', 1), info('x', 2, { projectPath: '/other' }))
    useViewStore.setState({
      projectPath: '/other',
      sidePane: { '/repo': 'terminal', '/other': 'terminal' },
    })
    forgetTerminal('a')
    expect(useViewStore.getState().sidePane['/repo']).toBeUndefined()
    expect(otherPane()).toBe('terminal')
  })

  it('does not close a different pane', () => {
    add(info('a', 1))
    useViewStore.setState({ sidePane: { '/repo': 'files' } })
    forgetTerminal('a')
    expect(useViewStore.getState().sidePane['/repo']).toBe('files')
  })

  it('closes the split terminal pane only for the focused project', () => {
    add(info('a', 1, { projectPath: '/repo' }), info('x', 2, { projectPath: '/other' }))
    const base = createLayout({ kind: 'session', sessionId: 's1', projectPath: '/other' })
    const layout = splitAt(
      base,
      base.focus,
      'right',
      { kind: 'session', sessionId: 's2', projectPath: '/repo' },
      { width: 1920, height: 1080 },
    )!
    useViewStore.setState({
      layout,
      projectPath: '/repo',
      main: { kind: 'session', sessionId: 's2' },
      splitSidePane: 'terminal',
      sidePane: { '/repo': 'terminal', '/other': 'terminal' },
    })
    forgetTerminal('x')
    expect(useViewStore.getState().splitSidePane).toBe('terminal')
    forgetTerminal('a')
    expect(useViewStore.getState().splitSidePane).toBeNull()
  })

  it('does not close a split pane that is not the terminal', () => {
    add(info('a', 1))
    const base = createLayout({ kind: 'session', sessionId: 's1', projectPath: '/repo' })
    const layout = splitAt(
      base,
      base.focus,
      'right',
      { kind: 'session', sessionId: 's2', projectPath: '/other' },
      { width: 1920, height: 1080 },
    )!
    // The new pane is focused; point the focus back at /repo, which owns the last tab.
    layout.focus = base.focus
    useViewStore.setState({
      layout,
      projectPath: '/repo',
      splitSidePane: 'files',
      sidePane: { '/repo': 'files' },
    })
    forgetTerminal('a')
    expect(useViewStore.getState().splitSidePane).toBe('files')
  })

  it('does not close the panel for an unknown tab', () => {
    forgetTerminal('missing')
    expect(pane()).toBe('terminal')
  })

  it('keeps the panel while a replacement for the last tab is being created', async () => {
    add(info('a', 1))
    let resolveCreate: (value: TerminalInfo) => void = () => undefined
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )
    const pending = createTerminal('/repo')
    forgetTerminal('a')
    expect(pane()).toBe('terminal')
    resolveCreate(info('n', 9))
    await pending
    expect(state().byId.n).toBeDefined()
    expect(pane()).toBe('terminal')
  })

  it('keeps the panel when a stale last tab is replaced', async () => {
    add(info('a', 1))
    request.mockResolvedValueOnce(info('n', 9))
    await replaceStale('a')
    expect(state().byId.a).toBeUndefined()
    expect(state().byId.n).toBeDefined()
    expect(pane()).toBe('terminal')
  })

  it('closes a panel that was already open once an empty list loads', () => {
    finishTerminalLoad('/repo', { explicitOpen: false, stale: false, loaded: true })
    expect(pane()).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it('starts a terminal when the panel was just opened onto nothing', async () => {
    request.mockResolvedValueOnce(info('n', 9))
    finishTerminalLoad('/repo', { explicitOpen: true, stale: false, loaded: true })
    await vi.waitFor(() => expect(state().byId.n).toBeDefined())
    expect(pane()).toBe('terminal')
  })

  it('does nothing when the list failed or finished after a switch', async () => {
    request.mockRejectedValueOnce(new Error('down'))
    const loaded = await loadTerminals('/repo')
    expect(loaded).toBe(false)
    finishTerminalLoad('/repo', { explicitOpen: false, stale: false, loaded })
    finishTerminalLoad('/repo', { explicitOpen: false, stale: true, loaded: true })
    expect(pane()).toBe('terminal')
    expect(request).not.toHaveBeenCalledWith('terminals.create', expect.anything())
  })

  it('leaves the panel open when the list has a tab', async () => {
    request.mockResolvedValueOnce([info('a', 1)])
    const loaded = await loadTerminals('/repo')
    finishTerminalLoad('/repo', { explicitOpen: false, stale: false, loaded })
    expect(state().byId.a).toBeDefined()
    expect(pane()).toBe('terminal')
  })

  it('does not close while that list is in flight with a create', async () => {
    let resolveCreate: (value: TerminalInfo) => void = () => undefined
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )
    const pending = createTerminal('/repo')
    finishTerminalLoad('/repo', { explicitOpen: false, stale: false, loaded: true })
    expect(pane()).toBe('terminal')
    expect(request).toHaveBeenCalledTimes(1)
    resolveCreate(info('n', 9))
    await pending
    expect(pane()).toBe('terminal')
  })

  it('closes only the project whose list was empty', () => {
    useViewStore.setState({ sidePane: { '/repo': 'terminal', '/other': 'terminal' } })
    finishTerminalLoad('/other', { explicitOpen: false, stale: false, loaded: true })
    expect(pane()).toBe('terminal')
    expect(otherPane()).toBeUndefined()
  })

  it('does not close the split pane when the empty project is not focused', () => {
    const base = createLayout({ kind: 'session', sessionId: 's1', projectPath: '/repo' })
    const layout = splitAt(
      base,
      base.focus,
      'right',
      { kind: 'session', sessionId: 's2', projectPath: '/other' },
      { width: 1920, height: 1080 },
    )!
    useViewStore.setState({
      layout,
      projectPath: '/other',
      splitSidePane: 'terminal',
      sidePane: { '/repo': 'terminal', '/other': 'terminal' },
    })
    finishTerminalLoad('/repo', { explicitOpen: false, stale: false, loaded: true })
    expect(useViewStore.getState().splitSidePane).toBe('terminal')
  })
})

describe('trackTerminalOpen', () => {
  const closed = { projectPath: '/repo', open: false }
  const open = { projectPath: '/repo', open: true }

  it('treats a restored open panel as not just opened', () => {
    expect(trackTerminalOpen(open, open, false)).toEqual({ opening: false, explicitOpen: false })
  })

  it('keeps an explicit open for the second run of that open', () => {
    const first = trackTerminalOpen(closed, open, false)
    expect(first).toEqual({ opening: true, explicitOpen: true })
    expect(trackTerminalOpen(open, open, first.opening)).toEqual({
      opening: true,
      explicitOpen: true,
    })
  })

  it('clears the explicit open when the project changes or the pane closes', () => {
    expect(trackTerminalOpen(open, { projectPath: '/other', open: true }, true)).toEqual({
      opening: false,
      explicitOpen: false,
    })
    expect(trackTerminalOpen(open, closed, true)).toEqual({ opening: false, explicitOpen: false })
  })
})

describe('replaceStale', () => {
  it('gives the new terminal the name and the place of the stale one', async () => {
    add(info('a', 1), info('b', 2), info('c', 3))
    moveTerminal('/repo', 'c', 0)
    renameTerminal('b', 'server')
    request.mockResolvedValueOnce(info('n', 9))
    await replaceStale('b')
    expect(tabs()).toEqual(['c', 'a', 'n'])
    expect(state().byId.n!.name).toBe('server')
    expect(state().byId.b).toBeUndefined()
    expect(state().active['/repo']).toBe('n')
  })

  it('keeps the place even when the row was never reordered', async () => {
    add(info('a', 1), info('b', 2), info('c', 3))
    request.mockResolvedValueOnce(info('n', 9))
    await replaceStale('a')
    expect(tabs()).toEqual(['n', 'b', 'c'])
  })
})

describe("another host's terminals", () => {
  const studio = 'c'.repeat(32)
  const fromStudio = (event: TerminalEvent) =>
    takeTerminalEvent(fromHostTerminalEvent(studio, event))

  it('lists them under the project as the window names it, and asks that host of them', async () => {
    fromStudio({ type: 'terminal.info', info: info('r1', 1, { projectPath: '/srv/app' }) })
    const projectPath = onHost(studio, '/srv/app')
    expect(tabs(projectPath)).toEqual(['r1'])
    expect(hostOfPath(state().byId.r1!.projectPath)).toBe(studio)
    hostRequest.mockResolvedValueOnce(undefined)
    await killTerminal('r1')
    expect(hostRequest).toHaveBeenCalledWith(studio, 'terminals.kill', { id: 'r1' })
    expect(request).not.toHaveBeenCalled()
  })

  it('starts a screen over from the replay of a terminal it fell behind on', () => {
    fromStudio({ type: 'terminal.info', info: info('r1', 1, { projectPath: '/srv/app' }) })
    const replayed: string[] = []
    setSink(
      'r1',
      () => {},
      (replay) => replayed.push(replay),
    )
    fromStudio({ type: 'terminal.replay', id: 'r1', replay: '$ ls' })
    expect(replayed).toEqual(['$ ls'])
    setSink('r1', null)
  })

  it('attaches again on a new connection, and ends the ones the host no longer has', async () => {
    fromStudio({ type: 'terminal.info', info: info('r1', 1, { projectPath: '/srv/app' }) })
    fromStudio({ type: 'terminal.info', info: info('r2', 2, { projectPath: '/srv/app' }) })
    add(info('mine', 3))
    const replayed: string[] = []
    setSink(
      'r1',
      () => {},
      (replay) => replayed.push(replay),
    )
    hostRequest.mockImplementation(async (_: string, method: string) => {
      if (method === 'terminals.list') return [info('r1', 1, { projectPath: '/srv/app' })]
      if (method === 'terminals.attach') return { replay: 'again' }
    })
    await reattachTerminals(studio)
    expect(hostRequest).toHaveBeenCalledWith(studio, 'terminals.list', {})
    expect(hostRequest).toHaveBeenCalledWith(studio, 'terminals.attach', { id: 'r1' })
    expect(replayed).toEqual(['again'])
    expect(state().byId.r1!.stale).toBe(false)
    expect(state().byId.r2!.stale).toBe(true)
    expect(state().byId.mine!.stale).toBe(false)
    setSink('r1', null)
  })

  it('ends the terminals a restart of its terminal host took', () => {
    fromStudio({ type: 'terminal.info', info: info('r1', 1, { projectPath: '/srv/app' }) })
    fromStudio({ type: 'terminal.info', info: info('r2', 2, { projectPath: '/srv/app' }) })
    endTerminals(['r2'])
    expect(state().byId.r1!.stale).toBe(false)
    expect(state().byId.r2!.stale).toBe(true)
  })
})

describe('findLocalUrl', () => {
  it('finds an address on this computer with a port', () => {
    expect(findLocalUrl('  ➜  Local:   http://localhost:5173/\n')).toBe('http://localhost:5173/')
    expect(findLocalUrl('Listening on http://127.0.0.1:8000/api?x=1#top')).toBe(
      'http://127.0.0.1:8000/api?x=1#top',
    )
    expect(findLocalUrl('https://[::1]:8443 ready')).toBe('https://[::1]:8443')
  })

  it('reads through the colors a dev server prints', () => {
    const vite =
      '\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'
    expect(findLocalUrl(vite)).toBe('http://localhost:5173/')
    expect(findLocalUrl('\x1b]0;title\x07http://localhost:3000\r\n')).toBe('http://localhost:3000')
  })

  it('opens 0.0.0.0 as localhost', () => {
    expect(findLocalUrl('Server running at http://0.0.0.0:8080/')).toBe('http://localhost:8080/')
  })

  it('ignores other hosts, addresses without a port and a sentence end', () => {
    expect(findLocalUrl('see https://example.com:8080/docs')).toBeNull()
    expect(findLocalUrl('LAN http://192.168.1.4:3000')).toBeNull()
    expect(findLocalUrl('http://localhost/ and http://localhost.example.com:80')).toBeNull()
    expect(findLocalUrl('Open http://localhost:4321.')).toBe('http://localhost:4321')
  })

  it('takes the last address printed', () => {
    expect(findLocalUrl('http://localhost:3000\nport taken, http://localhost:3001\n')).toBe(
      'http://localhost:3001',
    )
  })
})

describe("a terminal's local address", () => {
  const output = (id: string, data: string) => emit({ type: 'terminal.data', id, data })

  // Each test's terminal starts with no output seen.
  beforeEach(() => {
    forgetTerminal('a')
    setSink('a', () => {})
  })

  it('is found in output and kept when the host updates the terminal', () => {
    add(info('a', 1))
    expect(state().byId.a!.localUrl).toBeNull()
    output('a', '  ➜  Local:   http://localhost:5173/\r\n')
    expect(state().byId.a!.localUrl).toBe('http://localhost:5173/')
    add(info('a', 1, { busy: true }))
    expect(state().byId.a!.localUrl).toBe('http://localhost:5173/')
  })

  it('is found when split across chunks, inside a color too', () => {
    add(info('a', 1))
    output('a', 'ready at http://loc')
    output('a', 'alhost:3000/\r\n')
    expect(state().byId.a!.localUrl).toBe('http://localhost:3000/')
    output('a', 'moved to \x1b[3')
    output('a', '6mhttp:/')
    output('a', '/0.0.0.0:3001\x1b[39m\r\n')
    expect(state().byId.a!.localUrl).toBe('http://localhost:3001')
  })

  it('ignores other addresses and changes the state only for a new one', () => {
    add(info('a', 1))
    output('a', 'docs: https://vite.dev/guide\r\n')
    expect(state().byId.a!.localUrl).toBeNull()
    output('a', 'http://localhost:5173/\r\n')
    const before = state()
    output('a', 'hmr update /src/main.ts\r\n')
    output('a', 'http://localhost:5173/\r\n')
    expect(state()).toBe(before)
  })
})

describe('an agent owning a terminal', () => {
  const owner = { agentId: 'claude-code', sessionId: 's1' } as const

  it('owns none by default', () => {
    add(info('a', 1))
    expect(state().byId.a!.owner).toBeNull()
  })

  it('owns the terminal it starts, across updates from the host', async () => {
    request.mockResolvedValueOnce(info('n', 9))
    await createTerminal('/repo', undefined, { text: 'pnpm dev', run: true, owner })
    expect(request).toHaveBeenCalledWith('terminals.create', {
      projectPath: '/repo',
      cols: 100,
      rows: 24,
      command: { text: 'pnpm dev', run: true },
    })
    expect(state().byId.n!.owner).toEqual(owner)
    add(info('n', 9, { busy: true, title: 'node' }))
    expect(state().byId.n!.owner).toEqual(owner)
  })

  it('starts a plain shell without a command', async () => {
    request.mockResolvedValueOnce(info('n', 9))
    await createTerminal('/repo')
    expect(request).toHaveBeenCalledWith('terminals.create', {
      projectPath: '/repo',
      cols: 100,
      rows: 24,
    })
  })

  it('gives it up when the user types into it', async () => {
    request.mockResolvedValueOnce(info('n', 9))
    await createTerminal('/repo', undefined, { owner })
    takeOverTerminal('n')
    expect(state().byId.n!.owner).toBeNull()
    const before = state()
    takeOverTerminal('n')
    takeOverTerminal('missing')
    expect(state()).toBe(before)
  })

  it('gives up a terminal the user restarts, with its address', async () => {
    setSink('n', () => {})
    request.mockResolvedValueOnce(info('n', 9))
    await createTerminal('/repo', undefined, { owner })
    emit({ type: 'terminal.data', id: 'n', data: 'http://localhost:3000\r\n' })
    request.mockResolvedValueOnce(info('n', 9))
    await restartTerminal('n')
    expect(state().byId.n).toMatchObject({ owner: null, localUrl: null })
    setSink('n', null)
  })

  it('stops its process with Ctrl+C', async () => {
    request.mockResolvedValueOnce(undefined)
    await interruptTerminal('a')
    expect(request).toHaveBeenCalledWith('terminals.input', { id: 'a', data: '\x03' })
  })
})

describe('splitting the panel', () => {
  const split = async () => {
    request.mockResolvedValueOnce(info('n', 9))
    await toggleSplit('/repo')
  }
  const shown = () => ({
    left: state().active['/repo'],
    right: state().split['/repo'] ?? null,
    side: state().focusedSide['/repo'] ?? 'left',
  })

  beforeEach(() => {
    add(info('a', 1), info('b', 2), info('c', 3))
  })

  it('starts a terminal on the right, focused, beside the shown one', async () => {
    showTerminal('/repo', 'b')
    await split()
    expect(shown()).toEqual({ left: 'b', right: 'n', side: 'right' })
    expect(tabs()).toEqual(['a', 'b', 'c', 'n'])
  })

  it('unsplits on a second press, keeping the right one as a tab', async () => {
    await split()
    await toggleSplit('/repo')
    expect(shown()).toEqual({ left: 'a', right: null, side: 'left' })
    expect(tabs()).toContain('n')
  })

  it('shows a selected tab in the focused side', async () => {
    await split()
    showTerminal('/repo', 'b')
    expect(shown()).toEqual({ left: 'a', right: 'b', side: 'right' })
    focusTerminalSide('/repo', 'left')
    showTerminal('/repo', 'c')
    expect(shown()).toEqual({ left: 'c', right: 'b', side: 'left' })
  })

  it('focuses the other side for a tab shown there', async () => {
    await split()
    showTerminal('/repo', 'a')
    expect(shown()).toEqual({ left: 'a', right: 'n', side: 'left' })
    showTerminal('/repo', 'n')
    expect(shown()).toEqual({ left: 'a', right: 'n', side: 'right' })
  })

  it('shows a new terminal in the focused side', async () => {
    await split()
    request.mockResolvedValueOnce(info('m', 10))
    await createTerminal('/repo')
    expect(shown()).toEqual({ left: 'a', right: 'm', side: 'right' })
  })

  it('unsplits when the right one goes', async () => {
    await split()
    emit({ type: 'terminal.removed', id: 'n' })
    expect(shown()).toEqual({ left: 'a', right: null, side: 'left' })
  })

  it('moves the right one to the left when the left one goes', async () => {
    await split()
    forgetTerminal('a')
    expect(shown()).toEqual({ left: 'n', right: null, side: 'left' })
  })

  it('keeps a restarted stale terminal on its side', async () => {
    await split()
    request.mockResolvedValueOnce(info('r', 11))
    await replaceStale('n')
    expect(shown()).toEqual({ left: 'a', right: 'r', side: 'right' })
    expect(state().byId.n).toBeUndefined()
  })

  it('shows the new terminal alone when nothing was shown', async () => {
    useTerminalsStore.setState({ byId: {}, active: {}, order: {} })
    await split()
    expect(shown()).toEqual({ left: 'n', right: null, side: 'left' })
  })

  it('has no side to focus while unsplit', () => {
    const before = state()
    focusTerminalSide('/repo', 'right')
    expect(state()).toBe(before)
  })
})
