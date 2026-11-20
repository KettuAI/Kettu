import { afterEach, describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { MarketTools } from '../marketplace/publish-tools'
import { PLAN_PROMPT } from '../plan-tool'
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
  it("allow without asking only Kettu's plan, report, memory, session, workflow and settings tools, its guide, reading the Marketplace, listing, reading and naming terminals and reading pages", async () => {
    const service = await started()
    const process = { closed: new Promise<void>(() => {}) } as AgentProcess
    const expected = [
      'set_plan',
      // A terminal of the user's asks them in Kettu's own card before these reach it.
      'terminal_list',
      'terminal_read',
      'terminal_wait',
      'terminal_rename',
      'browser_snapshot',
      'browser_take_screenshot',
      'browser_wait_for',
      'browser_console_messages',
      'browser_network_requests',
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
      'list_workflows',
      'suggest_workflow',
      'create_workflow',
      'report_step',
      'pick_step_agents',
      'marketplace_check',
      'marketplace_mine',
      'find_settings',
      'open_settings',
      'change_settings',
      'read_kettu_guide',
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

/** What the service answers a request of an agent's, as a session's token reaches it. */
async function rpc<T>(service: ArtifactService, method: string, params: unknown): Promise<T> {
  const [server] = service.servers('s1', '/repo')
  if (!server || server.type !== 'http') throw new Error('No server')
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result: T }
  return body.result
}

const INITIALIZE = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
}

/** A service with memory, the Marketplace, computer use and workflow suggestions on. */
async function everythingOn(): Promise<ArtifactService> {
  const deps = {
    log: () => {},
    plan: {},
    sessions: {},
    memory: { service: { enabled: true } },
    market: { on: true },
    computer: { call: () => Promise.reject(new Error('not in this test')) },
    workflow: { library: { suggest: true }, isStep: () => false },
  } as unknown as ArtifactServiceDeps
  const service = new ArtifactService(deps)
  services.push(service)
  await service.start()
  return service
}

describe("the service's instructions", () => {
  // Claude Code keeps only the first 4096 characters of a server's instructions.
  it('stay within 4096 characters with memory, the Marketplace and computer use on', async () => {
    const service = await everythingOn()
    const { instructions } = await rpc<{ instructions?: string }>(service, 'initialize', INITIALIZE)
    expect(instructions).toBeTypeOf('string')
    expect(instructions!.length).toBeLessThanOrEqual(4096)
  })
})

describe('what an agent reads before it searches its tools', () => {
  // Claude Code and Codex put a server's prompt into their own instructions.
  it("is Kettu's guide and the plan paragraph in the server's prompt", async () => {
    const service = await everythingOn()
    const [server] = service.servers('s1', '/repo')
    expect(server?.type === 'http' && server.prompt).toBe(
      `${service.guidePrompt(true)}\n\n${PLAN_PROMPT}`,
    )
  })

  // Claude Code defers MCP tools behind a search, so an entry tool it does not list goes unused.
  it('lists the plan tool and the entries to artifacts, sessions and workflows from the start', async () => {
    const service = await everythingOn()
    const { tools } = await rpc<{ tools: Tool[] }>(service, 'tools/list', {})
    const loaded = tools
      .filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true)
      .map((tool) => tool.name)
    expect(loaded.sort()).toEqual(
      ['create_artifact', 'set_plan', 'start_session', 'suggest_workflow'].sort(),
    )
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
