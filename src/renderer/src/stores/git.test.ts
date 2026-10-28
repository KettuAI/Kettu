import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitTools, PullRequest } from '@shared/git'

const request = vi.fn()
const loadPicture = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request }, avatars: { load: loadPicture } } })

const { loadAvatar, loadGitTools, loadPullRequest, retryPullRequest, showProjects, useGitStore } =
  await import('./git')

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

describe('loadPullRequest', () => {
  const url = 'https://github.com/acme/app/pull/12'
  const pr = { url, number: 12, title: 'feat: twelve' } as PullRequest

  beforeEach(() => {
    request.mockReset()
    useGitStore.setState({ pullRequests: {}, pullRequestErrors: {} })
  })

  it("keeps why a chip's details failed, and a retry clears it", async () => {
    request.mockRejectedValueOnce({ name: 'PortRequestError', code: 'git_error', message: 'gone' })
    expect(await loadPullRequest(url)).toBeNull()
    expect(useGitStore.getState().pullRequestErrors[url]).toBe('gone')
    // A chip that scrolls into view again within the minute asks nothing.
    expect(await loadPullRequest(url)).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)

    request.mockResolvedValueOnce(pr)
    expect(await retryPullRequest(url)).toBe(pr)
    expect(request).toHaveBeenLastCalledWith('git.pullRequest', { url })
    expect(useGitStore.getState().pullRequests[url]).toBe(pr)
    expect(useGitStore.getState().pullRequestErrors).toEqual({})
  })
})

describe('loadAvatar', () => {
  const login = 'overbench-builder[bot]'
  const url = 'https://avatars.githubusercontent.com/in/5463070?v=4'
  const picture = 'data:image/png;base64,iVBORw0KGgo='
  let clock = 1_000_000

  beforeEach(() => {
    request.mockReset()
    loadPicture.mockReset()
    useGitStore.setState({ avatars: {} })
    clock += 10 * 60_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('looks a login up once and keeps its picture', async () => {
    request.mockResolvedValue(url)
    loadPicture.mockResolvedValue(picture)
    loadAvatar(login)
    loadAvatar(login)
    await vi.waitFor(() => expect(useGitStore.getState().avatars[login]).toBe(picture))
    loadAvatar(login)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('git.avatarUrl', { login })
    expect(loadPicture).toHaveBeenCalledWith(url)
  })

  it('keeps null when GitHub has no picture, without asking main', async () => {
    request.mockResolvedValue(null)
    loadAvatar('mirachen')
    await vi.waitFor(() => expect(useGitStore.getState().avatars).toEqual({ mirachen: null }))
    loadAvatar('mirachen')
    expect(request).toHaveBeenCalledTimes(1)
    expect(loadPicture).not.toHaveBeenCalled()
  })

  it('asks again a minute after the picture failed to load', async () => {
    request.mockResolvedValue(url)
    loadPicture.mockResolvedValueOnce(null).mockResolvedValue(picture)
    loadAvatar(login)
    await vi.waitFor(() => expect(loadPicture).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve))
    loadAvatar(login)
    expect(request).toHaveBeenCalledTimes(1)
    clock += 60_000
    loadAvatar(login)
    await vi.waitFor(() => expect(useGitStore.getState().avatars[login]).toBe(picture))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('asks again a minute after the lookup failed', async () => {
    request.mockRejectedValueOnce({ name: 'PortRequestError', code: 'git_error', message: 'x' })
    loadAvatar(login)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve))
    loadAvatar(login)
    expect(request).toHaveBeenCalledTimes(1)
    clock += 60_000
    request.mockResolvedValue(url)
    loadPicture.mockResolvedValue(picture)
    loadAvatar(login)
    await vi.waitFor(() => expect(useGitStore.getState().avatars[login]).toBe(picture))
  })

  it('asks nothing for what is not a GitHub login', () => {
    loadAvatar('app/overbench-builder')
    loadAvatar('')
    expect(request).not.toHaveBeenCalled()
  })
})
