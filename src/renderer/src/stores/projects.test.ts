import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/agent-host'

const request = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request } } })

const { useProjectsStore } = await import('./projects')

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
