import { afterEach, describe, expect, it } from 'vitest'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { MarketTools } from '../marketplace/publish-tools'
import type { PluginTools } from '../plugin-runtime/tools'
import { SUGGEST_PROMPT, SUGGEST_TOOL } from '../next-message'
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
  it("allow without asking only Kettu's safe read-only, thread, memory, session, workflow, Marketplace and settings tools, and gate reversible edits to Auto mode", async () => {
    const service = await started()
    const process = { closed: new Promise<void>(() => {}) } as AgentProcess
    const expected = [
      'set_plan',
      // It only keeps a line for the composer of the calling session.
      'suggest_next_message',
      'read_artifact',
      'list_artifacts',
      'list_artifact_versions',
      'list_artifact_types',
      'read_artifact_type',
      'read_comments',
      'read_artifact_data',
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
      'device_list',
      'device_snapshot',
      'device_screenshot',
      'device_logs',
      'computer_list_apps',
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
      // Every change of a Routine asks the user in Kettu's own card, in every mode.
      'list_routines',
      'create_routine',
      'update_routine',
      'delete_routine',
      'run_routine',
      // Adding and switching an MCP server ask the user in Kettu's own card, in every mode.
      'list_mcp_servers',
      'read_mcp_server',
      'check_mcp_server',
      'add_mcp_server',
      'switch_mcp_servers',
      'read_kettu_guide',
      // It only searches the descriptions of the tools behind the gateway.
      'find_tools',
      // They only read the skills the user turned on for the session's agent.
      'list_skills',
      'read_skill',
    ]
    const expectedAutoMode = [
      'create_artifact',
      'update_artifact',
      'create_artifact_from_type',
      'restore_artifact_version',
      'reply_comment',
      'resolve_comment',
      'browser_navigate',
      'browser_navigate_back',
      'browser_reload',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_select_option',
      'browser_evaluate',
      'browser_ask_user',
      'browser_tabs',
      'browser_resize',
      'device_open',
      'device_close',
      'device_tap',
      'device_fill',
      'device_type',
      'device_scroll',
      'device_swipe',
      'device_press_button',
      'device_rotate',
      'device_install_app',
      'device_launch_app',
      'device_terminate_app',
      'device_open_url',
      'device_set_appearance',
      'device_set_location',
      'device_set_permission',
      'terminal_stop',
      'computer_list_windows',
      'computer_get_window_state',
    ]
    const guarded = [
      'delete_artifact',
      'write_artifact_data',
      'terminal_run',
      'terminal_input',
      'computer_click',
      'computer_type_text',
      'computer_press_key',
      'computer_hotkey',
      'computer_scroll',
      'computer_drag',
      'computer_invoke_menu',
    ]
    for (const server of [
      ...service.servers('s1', '/repo'),
      ...service.folderServers(process, '/repo', 's2'),
    ]) {
      const always = server.type === 'stdio' ? [] : [...(server.autoAllow ?? [])].sort()
      const onAuto = server.type === 'stdio' ? [] : [...(server.autoModeAllow ?? [])].sort()
      expect(always).toEqual([...expected].sort())
      expect(onAuto).toEqual([...expectedAutoMode].sort())
      for (const name of guarded) {
        expect(always).not.toContain(name)
        expect(onAuto).not.toContain(name)
      }
    }
  })
})

/**
 * What the service answers a request of an agent's, as a session's token reaches it; `gateway` for
 * an agent given the short list, `suggests` for one that suggests the next message by the tool.
 */
async function answer<T>(
  service: ArtifactService,
  method: string,
  params: unknown,
  gateway = false,
  suggests = false,
): Promise<{ result?: T; error?: { message: string } }> {
  const [server] = service.servers('s1', '/repo', gateway, suggests)
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

/**
 * A service with memory, the Marketplace, computer use, workflow suggestions and next-message
 * suggestions on.
 */
async function everythingOn(): Promise<ArtifactService> {
  const deps = {
    log: () => {},
    plan: {},
    suggest: { note: () => true },
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
  it('lists the plan tool, the entries to artifacts, sessions, workflows and the browser, and the memory tools from the start', async () => {
    const service = await everythingOn()
    const { tools } = await rpc<{ tools: Tool[] }>(service, 'tools/list', {})
    const loaded = tools
      .filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true)
      .map((tool) => tool.name)
    expect(loaded.sort()).toEqual(
      [
        'browser_navigate',
        'create_artifact',
        'forget_memory',
        'list_workflows',
        'read_memory',
        'remember',
        'set_plan',
        'start_session',
        'suggest_workflow',
        'update_memory',
      ].sort(),
    )
  })
})

// Only an agent that cannot fork its session suggests by the tool, so no other is asked to call it.
describe('the next-message tool', () => {
  async function suggesting(note: (sessionId: string, message: string) => boolean) {
    const deps = { log: () => {}, plan: {}, suggest: { note }, sessions: {} }
    const service = new ArtifactService(deps as unknown as ArtifactServiceDeps)
    services.push(service)
    await service.start()
    return service
  }

  it('is listed and asked for only in a session that suggests by it', async () => {
    const service = await suggesting(() => true)
    for (const suggests of [false, true]) {
      const { result } = await answer<{ tools: Tool[] }>(service, 'tools/list', {}, false, suggests)
      expect(result!.tools.some((tool) => tool.name === SUGGEST_TOOL)).toBe(suggests)
      const [server] = service.servers('s1', '/repo', false, suggests)
      const prompt = server?.type === 'http' ? (server.prompt ?? '') : ''
      expect(prompt.includes(SUGGEST_PROMPT)).toBe(suggests)
      expect(service.guidePrompt(false, false, suggests).includes(SUGGEST_PROMPT)).toBe(suggests)
    }
  })

  it('keeps one line for the calling session and refuses anything else', async () => {
    const noted: [string, string][] = []
    const service = await suggesting((sessionId, message) => {
      noted.push([sessionId, message])
      return true
    })
    const call = async (args: unknown) => {
      const params = { name: SUGGEST_TOOL, arguments: args }
      return (await answer<CallToolResult>(service, 'tools/call', params, false, true)).result!
    }
    expect((await call({ message: '  Run the tests too ' })).isError).toBeFalsy()
    expect(noted).toEqual([['s1', 'Run the tests too']])
    for (const args of [
      {},
      { message: '' },
      { message: 'one\ntwo' },
      { message: 'x'.repeat(301) },
      { message: 'ok', extra: true },
      { message: 42 },
    ]) {
      expect((await call(args)).isError).toBe(true)
    }
    expect(noted).toHaveLength(1)
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
  it('is listed the core tools and the gateway, within 16500 bytes, the gateway the smallest', async () => {
    const service = await everythingOn()
    const { result } = await answer<{ tools: Tool[] }>(service, 'tools/list', {}, true, true)
    const tools = result!.tools
    expect(tools.map((tool) => tool.name).sort()).toEqual([...CORE_TOOLS, GATEWAY_TOOL].sort())
    const size = (tool: Tool) => JSON.stringify(declared(tool)).length
    expect(tools.reduce((sum, tool) => sum + size(tool), 0)).toBeLessThanOrEqual(16500)
    const gateway = tools.find((tool) => tool.name === GATEWAY_TOOL)!
    for (const tool of tools) {
      if (tool !== gateway) expect(size(gateway)).toBeLessThan(size(tool))
    }
  })

  it("leaves every other agent's list as it is", async () => {
    const service = await everythingOn()
    const { result } = await answer<{ tools: Tool[] }>(service, 'tools/list', {}, false, true)
    const names = result!.tools.map((tool) => tool.name)
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
      expect(server.type === 'stdio' ? [] : (server.autoModeAllow ?? [])).not.toContain(tool.name)
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
