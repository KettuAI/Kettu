import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { RoutineRun, RoutineView } from '@shared/routines'
import { host } from '@renderer/lib/host'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useViewStore } from '@renderer/stores/view'
import { openActiveRun } from './actions'

vi.mock('@renderer/lib/host', async (original) => ({
  ...(await original<typeof import('@renderer/lib/host')>()),
  host: vi.fn(),
}))

const request = vi.mocked(host)

const run: RoutineRun = {
  id: 'run-1',
  routineId: 'r-000000000001',
  trigger: 'schedule',
  scheduledFor: null,
  count: 1,
  status: 'waiting',
  reason: null,
  sessionId: 's-1',
  startedAt: 1,
  endedAt: null,
  workingMs: 0,
  stopReason: null,
  error: null,
  output: null,
  usage: null,
  changedFiles: [],
  seen: true,
}

const routine = { id: 'r-000000000001', activeRun: run } as RoutineView
const session = { id: 's-1', projectPath: '/work/demo' } as SessionSummary

beforeEach(() => {
  request.mockReset()
  useSessionsStore.setState({ byId: {} })
  useRoutinesStore.setState({ runs: {} })
  useViewStore.setState({ main: { kind: 'routines' } })
})

describe('Open the run', () => {
  it('opens a session this window knows without asking the host', async () => {
    useSessionsStore.setState({ byId: { 's-1': session } })
    await openActiveRun(routine)
    expect(request).not.toHaveBeenCalled()
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 's-1' })
  })

  it("finds a run's session among the routine's runs, which the session list leaves out", async () => {
    request.mockResolvedValue({ runs: [{ ...run, session }], older: null })
    await openActiveRun(routine)
    expect(request).toHaveBeenCalledWith('routines.runs', { routineId: routine.id })
    expect(useSessionsStore.getState().byId['s-1']).toEqual(session)
    expect(useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 's-1' })
    expect(useViewStore.getState().projectPath).toBe('/work/demo')
  })

  it('says so when the session cannot be found, and stays on the page', async () => {
    request.mockRejectedValue(new Error('The agent host did not answer.'))
    await expect(openActiveRun(routine)).rejects.toThrow("The run's session could not be opened.")
    expect(useViewStore.getState().main).toEqual({ kind: 'routines' })
  })
})
