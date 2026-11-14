import { afterEach, describe, expect, it } from 'vitest'
import type { MarketTools } from '../marketplace/publish-tools'
import { ArtifactService, type AgentProcess, type ArtifactServiceDeps } from './service'

const services: ArtifactService[] = []

async function started(): Promise<ArtifactService> {
  const deps = { log: () => {}, plan: {}, sessions: {} } as unknown as ArtifactServiceDeps
  const service = new ArtifactService(deps)
  services.push(service)
  await service.start()
  return service
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
})

describe('the servers a session attaches with', () => {
  // An agent that writes its servers onto a command line would show the token to every user.
  it('mark the token as a secret', async () => {
    const service = await started()
    const process = { closed: new Promise<void>(() => {}) } as AgentProcess
    const servers = [
      ...service.servers('s1', '/repo'),
      ...service.folderServers(process, '/repo', 's2'),
    ]
    expect(servers).toHaveLength(2)
    for (const server of servers) expect(server.secret).toBe(true)
  })

  // Allowed tools run without asking the user, so none may reach past Kettu's own data.
  it("allow without asking only Kettu's plan, report, memory and session tools and reading the Marketplace", async () => {
    const service = await started()
    const process = { closed: new Promise<void>(() => {}) } as AgentProcess
    const expected = [
      'set_plan',
      'report_problem',
      'list_memories',
      'read_memory',
      'remember',
      'update_memory',
      'forget_memory',
      'list_agents',
      'list_sessions',
      'get_session',
      'rename_session',
      'archive_session',
      'start_session',
      'read_session_history',
      'send_message',
      'marketplace_check',
      'marketplace_mine',
    ]
    for (const server of [
      ...service.servers('s1', '/repo'),
      ...service.folderServers(process, '/repo', 's2'),
    ]) {
      expect(server.type === 'stdio' ? [] : [...(server.autoAllow ?? [])].sort()).toEqual(
        [...expected].sort(),
      )
    }
  })
})

describe('the Marketplace tools', () => {
  // Publishing needs the host's Kettu account, so agents see the tools only while it is in use.
  it('are listed only while the host is signed in with Kettu’s services on', () => {
    const signedIn = { current: false }
    const market = {
      get on() {
        return signedIn.current
      },
    } as unknown as MarketTools
    const deps = { log: () => {}, plan: {}, sessions: {}, market } as unknown as ArtifactServiceDeps
    const service = new ArtifactService(deps)
    const listed = () =>
      service
        .toolSummaries()
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('marketplace_'))
    expect(listed()).toEqual([])
    signedIn.current = true
    expect(listed()).toEqual([
      'marketplace_check',
      'marketplace_publish',
      'marketplace_mine',
      'marketplace_unlist',
    ])
  })
})
