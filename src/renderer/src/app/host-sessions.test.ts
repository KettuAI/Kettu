import { describe, expect, it, vi } from 'vitest'
import type { Project, SessionSummary } from '@shared/agent-host'
import type { HostStatus } from '@shared/remote/hosts'

vi.stubGlobal('window', { kettu: { client: 'desktop', platform: 'darwin' } })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const { goneHosts, hostLists } = await import('./host-sessions')
const { onHost } = await import('@renderer/lib/host-paths')

const devBox = 'a'.repeat(32)
const mini = 'b'.repeat(32)

describe('host lists', () => {
  it("keeps each other host's sessions and projects, and none of this computer's", () => {
    const api = onHost(devBox, '/home/lin/api')
    const byId = {
      mine: { id: 'mine', projectPath: '/repo', origin: 'user' },
      theirs: { id: 'theirs', projectPath: api, origin: 'user' },
      run: { id: 'run', projectPath: api, origin: 'routine' },
      prepared: { id: 'prepared', projectPath: api, origin: 'user', prepared: {} },
    } as unknown as Record<string, SessionSummary>
    const projects = [
      { path: '/repo', name: 'repo' },
      { path: api, name: 'api' },
    ] as Project[]
    expect(hostLists(byId, projects)).toEqual({
      [devBox]: { sessions: [byId.theirs], projects: [projects[1]] },
    })
  })

  it('lets go of the hosts no longer known and those that removed this computer', () => {
    const host = (id: string, connection: HostStatus['connection']) =>
      ({ id, connection }) as HostStatus
    expect(goneHosts([devBox, mini], null)).toEqual([])
    expect(goneHosts([devBox, mini], [host(devBox, { state: 'offline' })])).toEqual([mini])
    expect(
      goneHosts(
        [devBox, mini],
        [host(devBox, { state: 'stopped', reason: 'removed' }), host(mini, { state: 'offline' })],
      ),
    ).toEqual([devBox])
  })
})
