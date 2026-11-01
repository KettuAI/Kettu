import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostEvent, Project, SessionSummary } from '@shared/agent-host'

const local = vi.fn()
const remote = vi.fn()
vi.stubGlobal('window', {
  kettu: { agents: { request: local }, hosts: { request: remote } },
})

const { forgetHostSessions, fromHostEvent, host, hostAt, routeOf, sessionHost, toHost } =
  await import('./host')
const { hostOfPath, hostPath, onHost } = await import('./host-paths')

const devBox = 'a'.repeat(32)
const mini = 'b'.repeat(32)

const summary = (id: string, projectPath: string) =>
  ({ id, agentId: 'claude-code', projectPath, parentId: null }) as SessionSummary

describe('host paths', () => {
  it("names another host's folder apart from this computer's, and back", () => {
    const path = onHost(devBox, '/home/lin/api')
    expect(path).not.toBe(onHost(mini, '/home/lin/api'))
    expect(hostOfPath(path)).toBe(devBox)
    expect(hostPath(path)).toBe('/home/lin/api')
    expect(hostPath(onHost(devBox, 'C:\\Users\\lin\\api'))).toBe('C:\\Users\\lin\\api')
    expect(onHost(null, '/Users/me/kettu')).toBe('/Users/me/kettu')
    expect(hostOfPath('/Users/me/kettu')).toBeNull()
    expect(hostPath('/Users/me/kettu')).toBe('/Users/me/kettu')
  })
})

describe('host', () => {
  beforeEach(() => {
    local.mockReset().mockResolvedValue(undefined)
    remote.mockReset().mockResolvedValue(undefined)
    forgetHostSessions(devBox)
    forgetHostSessions(mini)
  })

  it("asks another host about its projects as it writes them, and names what comes back the window's way", async () => {
    remote.mockResolvedValueOnce([{ path: '/home/lin/api', name: 'api' }])
    const projects = (await hostAt(devBox, 'projects.list', undefined)) as Project[]
    expect(projects).toEqual([{ path: onHost(devBox, '/home/lin/api'), name: 'api' }])

    remote.mockResolvedValueOnce({ projectPath: '/home/lin/api', repo: { root: '/home/lin/api' } })
    const status = await host('git.status', { projectPath: onHost(devBox, '/home/lin/api') })
    expect(remote).toHaveBeenLastCalledWith(devBox, 'git.status', { projectPath: '/home/lin/api' })
    // The repository's root stays as the host writes it, for showing.
    expect(status).toEqual({
      projectPath: onHost(devBox, '/home/lin/api'),
      repo: { root: '/home/lin/api' },
    })
    expect(local).not.toHaveBeenCalled()
  })

  it('sends a session to the host its summary came from, and this computer the rest', async () => {
    remote.mockResolvedValueOnce([summary('s1', '/home/lin/api')])
    const listed = (await hostAt(devBox, 'sessions.list', {})) as SessionSummary[]
    expect(listed[0]!.projectPath).toBe(onHost(devBox, '/home/lin/api'))
    expect(sessionHost('s1')).toBe(devBox)

    await host('sessions.prompt', { sessionId: 's1', content: [] })
    expect(remote).toHaveBeenLastCalledWith(devBox, 'sessions.prompt', {
      sessionId: 's1',
      content: [],
    })
    await host('permissions.respond', { sessionId: 's1', requestId: 'r', optionId: 'o' })
    expect(remote).toHaveBeenLastCalledWith(devBox, 'permissions.respond', {
      sessionId: 's1',
      requestId: 'r',
      optionId: 'o',
    })
    await host('sessions.prompt', { sessionId: 'mine', content: [] })
    expect(local).toHaveBeenLastCalledWith('sessions.prompt', { sessionId: 'mine', content: [] })
    await host('sessions.list', {})
    expect(local).toHaveBeenLastCalledWith('sessions.list', {})
  })

  it('learns the sessions a host names in its events, and forgets them with it', () => {
    const event = {
      type: 'session.summary',
      summary: summary('s2', '/srv/web'),
    } satisfies HostEvent
    const named = fromHostEvent(mini, event)
    expect((named as typeof event).summary.projectPath).toBe(onHost(mini, '/srv/web'))
    expect(sessionHost('s2')).toBe(mini)
    fromHostEvent(devBox, {
      type: 'session.patches',
      batch: { sessionId: 's3', seq: 1, patches: [] },
    })
    expect(sessionHost('s3')).toBe(devBox)
    const projects = fromHostEvent(mini, {
      type: 'projects.changed',
      projects: [{ path: '/srv/web', name: 'web', missing: false, lastOpenedAt: 0 }],
    })
    expect((projects as { projects: Project[] }).projects[0]!.path).toBe(onHost(mini, '/srv/web'))
    forgetHostSessions(mini)
    expect(sessionHost('s2')).toBeNull()
  })

  it('routes by the project an attachment or a new project names', () => {
    const api = onHost(devBox, '/home/lin/api')
    expect(routeOf('attachments.add', { source: { projectPath: api, path: 'a.ts' } })).toBe(devBox)
    expect(routeOf('projects.add', { path: api })).toBe(devBox)
    expect(routeOf('projects.add', { path: '/Users/me/x' })).toBeNull()
    expect(toHost('projects.add', { path: api }, 0)).toEqual({ path: '/home/lin/api' })
    // Only a project call's `path` is a folder of the window's.
    expect(toHost('files.read', { projectPath: api, path: 'src/a.ts' }, 0)).toEqual({
      projectPath: '/home/lin/api',
      path: 'src/a.ts',
    })
  })

  it('tells each host which of its sessions show, and one that showed some that none do now', async () => {
    remote.mockResolvedValueOnce([summary('d1', '/home/lin/api')])
    await hostAt(devBox, 'sessions.list', {})
    await host('sessions.show', { sessionIds: ['mine', 'd1'] })
    expect(local).toHaveBeenLastCalledWith('sessions.show', { sessionIds: ['mine'] })
    expect(remote).toHaveBeenLastCalledWith(devBox, 'sessions.show', { sessionIds: ['d1'] })
    await host('sessions.show', { sessionIds: ['mine'] })
    expect(remote).toHaveBeenLastCalledWith(devBox, 'sessions.show', { sessionIds: [] })
    remote.mockClear()
    await host('sessions.show', { sessionIds: [] })
    expect(remote).not.toHaveBeenCalled()
  })

  it("describes another host's media file as a binary one, whose bytes do not come through", async () => {
    remote.mockResolvedValueOnce({
      kind: 'media',
      path: 'logo.png',
      media: { kind: 'image', mimeType: 'image/png', size: 2048 },
    })
    const read = await host('files.read', {
      projectPath: onHost(devBox, '/home/lin/api'),
      path: 'logo.png',
    })
    expect(read).toEqual({ kind: 'binary', path: 'logo.png', size: 2048 })
  })
})
