import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInfo } from '@shared/terminal-host'

const SESSION = 'session-1'
const OTHER_SESSION = 'session-2'
const LOCAL_PROJECT = '/work/app'
const REMOTE_HOST = '0123456789abcdef0123456789abcdef'
const REMOTE_PROJECT = `kettu-host:${REMOTE_HOST}:/srv/app`

function storageMock() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}

const localRequest = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const localRunning = vi.fn<() => Promise<boolean>>()
const remoteRequest = vi.fn<(hostId: string, method: string, params: unknown) => Promise<unknown>>()

let useTerminalsStore: typeof import('@renderer/stores/terminals').useTerminalsStore
let takeTerminalEvent: typeof import('@renderer/stores/terminals').takeTerminalEvent
let closeAllTerminals: typeof import('@renderer/stores/terminals').closeAllTerminals
let terminalsOf: typeof import('@renderer/stores/terminals').terminalsOf
let fromHostTerminalEvent: typeof import('@renderer/lib/host').fromHostTerminalEvent
let noteTerminalHosts: typeof import('@renderer/stores/hosts').noteTerminalHosts
let useCloseAllTerminalsQuestion: typeof import('./close-all-terminals-model').useCloseAllTerminalsQuestion
let requestCloseAllTerminals: typeof import('./close-all-terminals-model').requestCloseAllTerminals
let refreshSessionTerminals: typeof import('./close-all-terminals-model').refreshSessionTerminals

function makeInfo(id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    projectPath: LOCAL_PROJECT,
    sessionId: SESSION,
    shell: 'pwsh',
    title: id,
    name: null,
    namedBy: null,
    busy: false,
    exitCode: null,
    createdAt: 1,
    owner: null,
    agentAllowed: false,
    control: { kind: 'idle' },
    waiting: null,
    ...overrides,
  }
}

beforeAll(async () => {
  vi.stubGlobal('window', {
    kettu: {
      platform: 'darwin',
      client: 'desktop',
      systemLocale: 'en',
      terminals: {
        request: localRequest,
        running: localRunning,
        onEvent: () => () => undefined,
        onConnection: () => () => undefined,
        restart: async () => undefined,
      },
      hosts: {
        request: remoteRequest,
      },
    },
  })
  vi.stubGlobal('localStorage', storageMock())
  ;({ useTerminalsStore, takeTerminalEvent, closeAllTerminals, terminalsOf } =
    await import('@renderer/stores/terminals'))
  ;({ fromHostTerminalEvent } = await import('@renderer/lib/host'))
  ;({ noteTerminalHosts } = await import('@renderer/stores/hosts'))
  ;({ useCloseAllTerminalsQuestion, requestCloseAllTerminals, refreshSessionTerminals } =
    await import('./close-all-terminals-model'))
}, 30_000)

beforeEach(() => {
  localRequest.mockReset()
  localRunning.mockReset()
  remoteRequest.mockReset()
  localRunning.mockResolvedValue(true)
  useTerminalsStore.setState({
    byId: {},
    active: {},
    order: {},
    split: {},
    focusedSide: {},
    focusing: null,
    errors: {},
    controls: {},
  })
  useCloseAllTerminalsQuestion.setState({ question: null })
  noteTerminalHosts([
    {
      id: REMOTE_HOST,
      name: 'Remote box',
      platform: 'linux',
      connection: { state: 'online', route: 'direct', terminal: true },
      lastOnlineAt: 1,
    } as never,
  ])
})

describe('closeAllTerminals', () => {
  it('kills only terminals in the target session, drops stale tabs locally, and ignores not_found', async () => {
    takeTerminalEvent({ type: 'terminal.info', info: makeInfo('t-live-1') })
    takeTerminalEvent({ type: 'terminal.info', info: makeInfo('t-gone') })
    takeTerminalEvent({ type: 'terminal.info', info: makeInfo('t-stale') })
    takeTerminalEvent({
      type: 'terminal.info',
      info: makeInfo('t-other', { sessionId: OTHER_SESSION }),
    })
    useTerminalsStore.setState((s) => ({
      byId: { ...s.byId, 't-stale': { ...s.byId['t-stale']!, stale: true } },
    }))

    localRequest.mockImplementation(async (method, params) => {
      if (method === 'terminals.kill') {
        const { id } = params as { id: string }
        if (id === 't-gone') throw Object.assign(new Error('Terminal gone'), { code: 'not_found' })
        takeTerminalEvent({ type: 'terminal.removed', id })
      }
      return null
    })

    const result = await closeAllTerminals(SESSION)
    expect(result).toEqual({ closed: 3, errors: [] })
    expect(localRequest).toHaveBeenCalledTimes(2)
    expect(localRequest).toHaveBeenCalledWith('terminals.kill', { id: 't-live-1' })
    expect(localRequest).toHaveBeenCalledWith('terminals.kill', { id: 't-gone' })
    expect(terminalsOf(useTerminalsStore.getState().byId, SESSION)).toEqual([])
    expect(terminalsOf(useTerminalsStore.getState().byId, OTHER_SESSION).map((t) => t.id)).toEqual([
      't-other',
    ])
  })

  it('routes kills to remote hosts for remote session terminals', async () => {
    takeTerminalEvent(
      fromHostTerminalEvent(REMOTE_HOST, {
        type: 'terminal.info',
        info: makeInfo('t-remote-1', { projectPath: '/srv/app', sessionId: SESSION }),
      }),
    )
    takeTerminalEvent(
      fromHostTerminalEvent(REMOTE_HOST, {
        type: 'terminal.info',
        info: makeInfo('t-remote-2', { projectPath: '/srv/app', sessionId: SESSION }),
      }),
    )

    remoteRequest.mockImplementation(async (_hostId, method, params) => {
      if (method === 'terminals.kill') {
        const { id } = params as { id: string }
        takeTerminalEvent({ type: 'terminal.removed', id })
      }
      return null
    })

    const result = await closeAllTerminals(SESSION)
    expect(result).toEqual({ closed: 2, errors: [] })
    expect(localRequest).not.toHaveBeenCalled()
    expect(remoteRequest).toHaveBeenCalledWith(REMOTE_HOST, 'terminals.kill', { id: 't-remote-1' })
    expect(remoteRequest).toHaveBeenCalledWith(REMOTE_HOST, 'terminals.kill', { id: 't-remote-2' })
    expect(terminalsOf(useTerminalsStore.getState().byId, SESSION)).toEqual([])
  })

  it('records errors when killing fails on the host', async () => {
    takeTerminalEvent({ type: 'terminal.info', info: makeInfo('t-err') })
    localRequest.mockRejectedValue(
      Object.assign(new Error('Host offline'), { code: 'host_offline' }),
    )

    const result = await closeAllTerminals(SESSION)
    expect(result.closed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(useTerminalsStore.getState().errors[SESSION]).toBeTruthy()
  })
})

describe('requestCloseAllTerminals', () => {
  it('closes idle and exited terminals immediately without asking for confirmation', async () => {
    takeTerminalEvent({ type: 'terminal.info', info: makeInfo('t-idle', { busy: false }) })
    takeTerminalEvent({
      type: 'terminal.info',
      info: makeInfo('t-exited', { busy: true, exitCode: 0 }),
    })
    localRequest.mockImplementation(async (method, params) => {
      if (method === 'terminals.kill') {
        takeTerminalEvent({ type: 'terminal.removed', id: (params as { id: string }).id })
      }
      return null
    })

    const closed = await requestCloseAllTerminals(SESSION)
    expect(closed).toBe(2)
    expect(useCloseAllTerminalsQuestion.getState().question).toBeNull()
    expect(terminalsOf(useTerminalsStore.getState().byId, SESSION)).toEqual([])
  })

  it('asks once when any terminal is running and respects cancel vs confirm', async () => {
    takeTerminalEvent({ type: 'terminal.info', info: makeInfo('t-idle', { busy: false }) })
    takeTerminalEvent({
      type: 'terminal.info',
      info: makeInfo('t-busy', { busy: true, title: 'pnpm dev' }),
    })
    localRequest.mockImplementation(async (method, params) => {
      if (method === 'terminals.kill') {
        takeTerminalEvent({ type: 'terminal.removed', id: (params as { id: string }).id })
      }
      return null
    })

    // Cancel leaves every terminal open.
    const cancelled = requestCloseAllTerminals(SESSION)
    const firstQuestion = useCloseAllTerminalsQuestion.getState().question
    expect(firstQuestion?.running.map((t) => t.id)).toEqual(['t-busy'])
    firstQuestion?.answer(false)
    useCloseAllTerminalsQuestion.setState({ question: null })
    expect(await cancelled).toBe(0)
    expect(localRequest).not.toHaveBeenCalled()
    expect(terminalsOf(useTerminalsStore.getState().byId, SESSION)).toHaveLength(2)

    // Confirm closes the snapshot of terminals, leaving any terminal opened afterwards untouched.
    const confirmed = requestCloseAllTerminals(SESSION)
    const secondQuestion = useCloseAllTerminalsQuestion.getState().question
    takeTerminalEvent({ type: 'terminal.info', info: makeInfo('t-newer') })
    secondQuestion?.answer(true)
    useCloseAllTerminalsQuestion.setState({ question: null })
    expect(await confirmed).toBe(2)
    expect(terminalsOf(useTerminalsStore.getState().byId, SESSION).map((t) => t.id)).toEqual([
      't-newer',
    ])
  })
})

describe('refreshSessionTerminals', () => {
  it('does not cold-start the local terminal host when it is not running', async () => {
    localRunning.mockResolvedValue(false)
    await refreshSessionTerminals(LOCAL_PROJECT)
    expect(localRunning).toHaveBeenCalledTimes(1)
    expect(localRequest).not.toHaveBeenCalled()
  })

  it('lists local terminals when the local terminal host is already running', async () => {
    localRunning.mockResolvedValue(true)
    localRequest.mockResolvedValue([makeInfo('t-local')])
    await refreshSessionTerminals(LOCAL_PROJECT)
    expect(localRequest).toHaveBeenCalledWith('terminals.list', { projectPath: LOCAL_PROJECT })
    expect(terminalsOf(useTerminalsStore.getState().byId, SESSION).map((t) => t.id)).toEqual([
      't-local',
    ])
  })

  it('lists remote terminals when the remote host allows terminals', async () => {
    remoteRequest.mockResolvedValue([
      makeInfo('t-remote', { projectPath: '/srv/app', sessionId: SESSION }),
    ])
    await refreshSessionTerminals(REMOTE_PROJECT)
    expect(localRunning).not.toHaveBeenCalled()
    expect(remoteRequest).toHaveBeenCalledWith(REMOTE_HOST, 'terminals.list', {
      projectPath: '/srv/app',
    })
    expect(terminalsOf(useTerminalsStore.getState().byId, SESSION).map((t) => t.id)).toEqual([
      't-remote',
    ])
  })

  it('skips listing remote terminals when the remote host disallows terminals', async () => {
    noteTerminalHosts([
      {
        id: REMOTE_HOST,
        name: 'Remote box',
        platform: 'linux',
        connection: { state: 'online', route: 'direct', terminal: false },
        lastOnlineAt: 1,
      } as never,
    ])
    await refreshSessionTerminals(REMOTE_PROJECT)
    expect(remoteRequest).not.toHaveBeenCalled()
    expect(localRunning).not.toHaveBeenCalled()
  })
})
