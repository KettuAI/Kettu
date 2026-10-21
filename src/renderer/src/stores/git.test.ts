import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitTools } from '@shared/git'

const request = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request } } })

const { loadGitTools, useGitStore } = await import('./git')

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
