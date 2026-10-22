import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalEvent, TerminalInfo } from '@shared/terminal-host'

const request = vi.fn()
let emit!: (event: TerminalEvent) => void
vi.stubGlobal('window', {
  overbench: {
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

const {
  forgetTerminal,
  initTerminals,
  moveTerminal,
  orderTerminals,
  renameTerminal,
  replaceStale,
  terminalsOf,
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
  useTerminalsStore.setState({
    byId: {},
    active: {},
    order: {},
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
