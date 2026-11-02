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
const {
  createTerminal,
  endTerminals,
  findLocalUrl,
  focusTerminalSide,
  forgetTerminal,
  initTerminals,
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
