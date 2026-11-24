import { afterEach, describe, expect, it } from 'vitest'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { MarketTools } from '../marketplace/publish-tools'
import type { PluginTools } from '../plugin-runtime/tools'
import { PLAN_PROMPT } from '../plan-tool'
import { CORE_TOOLS, declared, GATEWAY_TOOL } from '../tool-gateway'
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
  it("allow without asking only Kettu's plan, report, memory, session, workflow, Marketplace and settings tools, its guide, listing, reading and naming terminals and reading pages", async () => {
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
      // Publishing and unlisting ask the user in Kettu's own card before anything leaves.
      'marketplace_publish',
      'marketplace_unlist',
      'find_settings',
      'open_settings',
      'change_settings',
      'read_kettu_guide',
      // They only read the skills the user turned on for the session's agent.
      'list_skills',
      'read_skill',
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

/**
 * What the service answers a request of an agent's, as a session's token reaches it; `gateway` for
 * an agent given the short list.
 */
async function answer<T>(
  service: ArtifactService,
  method: string,
  params: unknown,
  gateway = false,
): Promise<{ result?: T; error?: { message: string } }> {
  const [server] = service.servers('s1', '/repo', gateway)
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
  return (await response.json()) as { result?: T; error?: { message: string } }
}

async function rpc<T>(service: ArtifactService, method: string, params: unknown): Promise<T> {
  return (await answer<T>(service, method, params)).result!
}

/** A call of the gateway from a session given the short list. */
async function viaGateway(service: ArtifactService, args: unknown): Promise<CallToolResult> {
  const body = await answer<CallToolResult>(
    service,
    'tools/call',
    { name: GATEWAY_TOOL, arguments: args },
    true,
  )
  if (!body.result) throw new Error(body.error?.message ?? 'No result')
  return body.result
}

const texts = (result: CallToolResult): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

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
    skills: { of: () => [] },
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
  it('lists the plan tool and the entries to artifacts, sessions, workflows and the browser from the start', async () => {
    const service = await everythingOn()
    const { tools } = await rpc<{ tools: Tool[] }>(service, 'tools/list', {})
    const loaded = tools
      .filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true)
      .map((tool) => tool.name)
    expect(loaded.sort()).toEqual(
      [
        'browser_navigate',
        'create_artifact',
        'list_workflows',
        'set_plan',
        'start_session',
        'suggest_workflow',
      ].sort(),
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
      'marketplace_convert',
      'marketplace_publish',
      'marketplace_mine',
      'marketplace_unlist',
    ])
  })
})

// agy drops the largest MCP tools past a budget of its own and cannot call a dropped one over ACP.
describe('an agent that drops tools past a budget of its own', () => {
  it('is listed the core tools and the gateway, within 16000 bytes, the gateway the smallest', async () => {
    const service = await everythingOn()
    const { result } = await answer<{ tools: Tool[] }>(service, 'tools/list', {}, true)
    const tools = result!.tools
    expect(tools.map((tool) => tool.name).sort()).toEqual([...CORE_TOOLS, GATEWAY_TOOL].sort())
    const size = (tool: Tool) => JSON.stringify(declared(tool)).length
    expect(tools.reduce((sum, tool) => sum + size(tool), 0)).toBeLessThanOrEqual(16000)
    const gateway = tools.find((tool) => tool.name === GATEWAY_TOOL)!
    for (const tool of tools) {
      if (tool !== gateway) expect(size(gateway)).toBeLessThan(size(tool))
    }
  })

  it("leaves every other agent's list as it is", async () => {
    const service = await everythingOn()
    const { tools } = await rpc<{ tools: Tool[] }>(service, 'tools/list', {})
    const names = tools.map((tool) => tool.name)
    expect(names).not.toContain(GATEWAY_TOOL)
    expect(names).toEqual(service.toolSummaries().map((tool) => tool.name))
  })

  it("runs only a tool of the session's full list", async () => {
    const service = await everythingOn()
    // A step's own tool, which a session outside a workflow step is not given.
    for (const tool of ['report_step', 'no_such_tool', GATEWAY_TOOL]) {
      const result = await viaGateway(service, { tool, arguments: {} })
      expect(result.isError).toBe(true)
      expect(texts(result)).toContain(`${tool} is not a Kettu tool this session can use`)
    }
    const odd = await viaGateway(service, { tool: 'list_agents', arguments: [] })
    expect(odd.isError).toBe(true)
  })

  it('describes a tool without running it when the call has no arguments', async () => {
    // Memory has no store here, so running a memory tool would fail.
    const service = await everythingOn()
    const result = await viaGateway(service, { tool: 'forget_memory' })
    expect(result.isError).toBeUndefined()
    expect(texts(result)).toContain('Arguments of forget_memory (JSON Schema): {')
  })

  it("runs a tool as a direct call does, and a topic lists its part's tools with their arguments", async () => {
    const service = await everythingOn()
    const result = await viaGateway(service, {
      tool: 'read_kettu_guide',
      arguments: { topic: 'devices' },
    })
    expect(result.isError).toBeUndefined()
    expect(texts(result)).toContain('### device_tap')
    expect(texts(result)).toContain('Arguments of device_tap (JSON Schema): {')
    // The harness may drop a core tool too, so the topic gives its arguments as well.
    const artifacts = await viaGateway(service, {
      tool: 'read_kettu_guide',
      arguments: { topic: 'artifacts' },
    })
    expect(texts(artifacts)).toContain('Arguments of create_artifact (JSON Schema): {')
    expect(texts(artifacts)).not.toContain(`### ${GATEWAY_TOOL}`)

    const direct = await rpc<CallToolResult>(service, 'tools/call', {
      name: 'read_kettu_guide',
      arguments: { topic: 'devices' },
    })
    expect(texts(direct)).not.toContain(GATEWAY_TOOL)
  })

  it('adds the arguments to a call that failed', async () => {
    const service = await everythingOn()
    const result = await viaGateway(service, {
      tool: 'read_kettu_guide',
      arguments: { topic: 'nope' },
    })
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('Arguments of read_kettu_guide (JSON Schema)')
  })

  it('is no tool for a session given the full list', async () => {
    const service = await everythingOn()
    const body = await answer(service, 'tools/call', {
      name: GATEWAY_TOOL,
      arguments: { tool: 'list_agents', arguments: {} },
    })
    expect(body.error?.message).toContain(`Unknown tool ${GATEWAY_TOOL}`)
  })
})

describe("a plugin's tools", () => {
  const tool: Tool = {
    name: 'acme__lookup',
    description: 'Looks a word up.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  }
  const calls: unknown[] = []
  const plugins = {
    listed: () => [tool],
    has: (name: string) => name === tool.name,
    argumentsWrong: (_name: string, input: unknown) =>
      Object.keys(input as object).some((key) => key !== 'query'),
    call: (name: string, input: unknown): CallToolResult => {
      calls.push([name, input])
      if ((input as { query?: string }).query === 'boom') {
        return {
          content: [{ type: 'text', text: 'lookup failed: the script broke' }],
          isError: true,
        }
      }
      if (Object.keys(input as object).some((key) => key !== 'query')) {
        return { content: [{ type: 'text', text: 'Unknown argument "word".' }], isError: true }
      }
      return { content: [{ type: 'text', text: 'found' }] }
    },
  } as unknown as PluginTools

  async function withPlugins(): Promise<ArtifactService> {
    const deps = {
      log: () => {},
      plan: {},
      sessions: {},
      plugins,
    } as unknown as ArtifactServiceDeps
    const service = new ArtifactService(deps)
    services.push(service)
    await service.start()
    return service
  }

  it('are listed in their own group, asked about, and never allowed without asking', async () => {
    const service = await withPlugins()
    expect(service.toolSummaries().find((entry) => entry.name === tool.name)).toMatchObject({
      group: 'plugins',
    })
    for (const server of service.servers('s1', '/repo')) {
      expect(server.type === 'stdio' ? [] : (server.autoAllow ?? [])).not.toContain(tool.name)
    }
    const { tools } = await rpc<{ tools: Tool[] }>(service, 'tools/list', {})
    expect(tools.map((entry) => entry.name)).toContain(tool.name)
  })

  it('run as a direct call does, and an error of the script is an error result', async () => {
    const service = await withPlugins()
    const ok = await rpc<CallToolResult>(service, 'tools/call', {
      name: tool.name,
      arguments: { query: 'clock' },
    })
    expect(texts(ok)).toBe('found')
    const failed = await rpc<CallToolResult>(service, 'tools/call', {
      name: tool.name,
      arguments: { query: 'boom' },
    })
    expect(failed.isError).toBe(true)
    expect(texts(failed)).toContain('the script broke')
  })

  it('reach an agent given the short list through the gateway, which describes them first', async () => {
    const service = await withPlugins()
    const { result } = await answer<{ tools: Tool[] }>(service, 'tools/list', {}, true)
    expect(result!.tools.map((entry) => entry.name)).not.toContain(tool.name)
    const described = await viaGateway(service, { tool: tool.name })
    expect(texts(described)).toContain(`Arguments of ${tool.name} (JSON Schema): {`)
    const ran = await viaGateway(service, { tool: tool.name, arguments: { query: 'clock' } })
    expect(texts(ran)).toBe('found')
  })

  it('come back through the gateway with their arguments only when the call was wrong', async () => {
    const service = await withPlugins()
    const broke = await viaGateway(service, { tool: tool.name, arguments: { query: 'boom' } })
    expect(broke.isError).toBe(true)
    expect(texts(broke)).toBe('lookup failed: the script broke')
    const wrong = await viaGateway(service, { tool: tool.name, arguments: { word: 'clock' } })
    expect(wrong.isError).toBe(true)
    expect(texts(wrong)).toContain(`Arguments of ${tool.name} (JSON Schema): {`)
  })
})
