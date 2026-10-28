import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitTools } from '@shared/git'

const request = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request } } })

const { loadGitTools, showProjects, useGitStore } = await import('./git')

const tools: GitTools = {
  git: { found: true, version: '2.50.0' },
  gh: { state: 'ready', version: '2.80.0', account: 'octocat' },
}

describe('loadGitTools', () => {
  beforeEach(() => {
    request.mockReset()
    useGitStore.setState({ tools: null, toolsError: null })
  })

  it('keeps the reason the check failed', async () => {
    request.mockRejectedValueOnce({ name: 'PortRequestError', code: 'internal', message: 'boom' })
    await loadGitTools()
    expect(useGitStore.getState()).toMatchObject({ tools: null, toolsError: 'boom' })
  })

  it('clears the error while it checks again and once it succeeds', async () => {
    useGitStore.setState({ toolsError: 'boom' })
    let resolve!: (value: GitTools) => void
    request.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const load = loadGitTools()
    expect(useGitStore.getState().toolsError).toBeNull()
    resolve(tools)
    await load
    expect(useGitStore.getState()).toMatchObject({ tools, toolsError: null })
  })
})

describe('showProjects', () => {
  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue(undefined)
  })

  it('keeps the projects in view live, and releases one no pane shows', async () => {
    showProjects(['/one', '/two'])
    expect(request).toHaveBeenCalledWith('git.status', { projectPath: '/one' })
    expect(request).toHaveBeenCalledWith('git.status', { projectPath: '/two' })
    request.mockClear()
    // A project shown already needs nothing further.
    showProjects(['/one', '/two'])
    expect(request).not.toHaveBeenCalled()
    // One no pane shows is let go, and the one that joins takes its status.
    showProjects(['/two', '/three'])
    expect(request).toHaveBeenCalledWith('git.unwatch', { projectPath: '/one' })
    expect(request).toHaveBeenCalledWith('git.status', { projectPath: '/three' })
    expect(request).not.toHaveBeenCalledWith('git.unwatch', { projectPath: '/two' })
  })
})
