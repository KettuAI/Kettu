import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/agent-host'

const request = vi.fn()
vi.stubGlobal('window', { kettu: { agents: { request } } })

const { useProjectsStore, withHostProjects } = await import('./projects')
const { onHost } = await import('@renderer/lib/host-paths')

const project = { path: '/repo', name: 'repo' } as Project

describe('projects store', () => {
  beforeEach(() => {
    request.mockReset()
    useProjectsStore.setState({ projects: [], loaded: false, error: null })
  })

  it('keeps the reason a refresh failed and stays unloaded', async () => {
    request.mockRejectedValueOnce({ name: 'PortRequestError', code: 'internal', message: 'boom' })
    await expect(useProjectsStore.getState().refresh()).rejects.toMatchObject({ message: 'boom' })
    expect(useProjectsStore.getState()).toMatchObject({ loaded: false, error: 'boom' })
  })

  it('clears the error once a refresh succeeds', async () => {
    useProjectsStore.setState({ error: 'boom' })
    request.mockResolvedValueOnce([project])
    await useProjectsStore.getState().refresh()
    expect(useProjectsStore.getState()).toMatchObject({
      projects: [project],
      loaded: true,
      error: null,
    })
  })
})

describe('withHostProjects', () => {
  const devBox = 'a'.repeat(32)
  const api = { path: onHost(devBox, '/home/lin/api'), name: 'api' } as Project
  const web = { path: onHost(devBox, '/home/lin/web'), name: 'web' } as Project

  it("replaces one host's projects, this computer's first", () => {
    const merged = withHostProjects([project], devBox, [api])
    expect(merged).toEqual([project, api])
    expect(withHostProjects(merged, devBox, [web])).toEqual([project, web])
    const other = { path: '/other', name: 'other' } as Project
    expect(withHostProjects(merged, null, [other])).toEqual([other, api])
  })
})
