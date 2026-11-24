import { describe, expect, it, vi } from 'vitest'
import { PluginRequestError } from '@shared/plugin-host'
import type { PluginToolSchema } from '@shared/plugins'
import type { InstalledTool } from '../plugins/service'
import { checkToolArguments, PluginTools, TOOL_RESULT_CHARS } from './tools'

const SCHEMA: PluginToolSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    mode: { type: 'string', enum: ['fast', 'deep'] },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
    ratio: { type: 'number' },
    exact: { type: 'boolean' },
  },
  required: ['query'],
  additionalProperties: false,
}

describe('the arguments of a plugin tool', () => {
  it('are taken as declared, with what is left out left out', () => {
    expect(checkToolArguments(SCHEMA, { query: 'clock', limit: 3, exact: true })).toEqual({
      value: { query: 'clock', limit: 3, exact: true },
    })
  })

  it.each([
    [undefined, 'The argument "query" is required.'],
    [[], 'The arguments must be an object.'],
    [{ query: 'a', other: 1 }, 'Unknown argument "other".'],
    [{ query: 1 }, 'The argument "query" must be a string.'],
    [{ query: 'a', mode: 'slow' }, 'The argument "mode" must be one of "fast", "deep".'],
    [{ query: 'a', limit: 1.5 }, 'The argument "limit" must be a whole number.'],
    [{ query: 'a', limit: 0 }, 'The argument "limit" must be at least 1.'],
    [{ query: 'a', limit: 11 }, 'The argument "limit" must be at most 10.'],
    [{ query: 'a', ratio: Infinity }, 'The argument "ratio" must be a number.'],
    [{ query: 'a', exact: 'yes' }, 'The argument "exact" must be true or false.'],
    // A key that names a property of every object is no argument.
    [{ query: 'a', constructor: 1 }, 'Unknown argument "constructor".'],
  ])('are refused when wrong: %j', (input, error) => {
    expect(checkToolArguments(SCHEMA, input)).toEqual({ error })
  })
})

function installed(overrides: Partial<InstalledTool> = {}): InstalledTool {
  return {
    name: 'lookup',
    description: 'Looks a word up.',
    inputSchema: SCHEMA,
    pluginId: 'p000000000001',
    pluginName: 'Acme Tools',
    plugin: 'Acme',
    ...overrides,
  }
}

function tools(list: InstalledTool[], call?: (...args: unknown[]) => Promise<unknown>) {
  const client = {
    activate: vi.fn(async () => {}),
    call: vi.fn(call ?? (async () => 'answer')),
  }
  const log = vi.fn()
  return { tools: new PluginTools({ installed: () => list, client, log }), client, log }
}

describe("a plugin's tools on Kettu's MCP service", () => {
  it('are listed under the plugin’s short name, with the arguments the manifest declares', () => {
    const { tools: listed } = tools([installed()])
    expect(listed.listed()).toEqual([
      {
        name: 'acme_tools__lookup',
        title: 'Acme: lookup',
        description: 'Looks a word up. (A tool of the plugin "Acme".)',
        inputSchema: SCHEMA,
      },
    ])
    expect(listed.has('acme_tools__lookup')).toBe(true)
    expect(listed.has('lookup')).toBe(false)
  })

  it('go to the first plugin when two would have the same name', () => {
    const { tools: listed, log } = tools([
      installed(),
      installed({ pluginId: 'p000000000002', plugin: 'Other' }),
    ])
    expect(listed.listed().map((tool) => tool.title)).toEqual(['Acme: lookup'])
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('p000000000002'))
  })

  it('wake the plugin for the call and give its function the checked arguments', async () => {
    const { tools: listed, client } = tools([installed()], async () => ({ found: 2 }))
    const result = await listed.call('acme_tools__lookup', { query: 'clock' })
    expect(client.activate).toHaveBeenCalledWith('p000000000001', 'tool:lookup')
    expect(client.call).toHaveBeenCalledWith('p000000000001', 'lookup', [{ query: 'clock' }])
    expect(result).toEqual({ content: [{ type: 'text', text: '{"found":2}' }] })
  })

  it('answer with an error, and run nothing, for arguments the manifest does not take', async () => {
    const { tools: listed, client } = tools([installed()])
    const result = await listed.call('acme_tools__lookup', { query: 3 })
    expect(result).toMatchObject({ isError: true })
    expect(client.activate).not.toHaveBeenCalled()
    expect(client.call).not.toHaveBeenCalled()
  })

  it.each([
    [
      'throws',
      new PluginRequestError({ code: 'failed', message: 'Error: boom' }),
      'acme_tools__lookup failed: boom',
    ],
    [
      'throws another kind of error',
      new PluginRequestError({ code: 'failed', message: 'TypeError: boom' }),
      'acme_tools__lookup failed: TypeError: boom',
    ],
    [
      'runs too long',
      new PluginRequestError({ code: 'timeout', message: 'slow' }),
      'acme_tools__lookup failed: the plugin did not answer in time',
    ],
    [
      'crashes',
      new PluginRequestError({ code: 'crashed', message: 'gone' }),
      'acme_tools__lookup failed: the plugin was stopped for using too much time or memory',
    ],
    [
      'is not reachable',
      new PluginRequestError({ code: 'unavailable', message: 'none' }),
      'acme_tools__lookup failed: the plugin could not be started',
    ],
  ])('answer with an error the agent reads when the script %s', async (_, error, text) => {
    const { tools: listed } = tools([installed()], async () => {
      throw error
    })
    const result = await listed.call('acme_tools__lookup', { query: 'a' })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text }])
  })

  it('answer that the plugin is off, rather than fail, for a tool that is gone', async () => {
    const { tools: listed, client } = tools([])
    const result = await listed.call('acme_tools__lookup', { query: 'a' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('off or removed')
    expect(client.call).not.toHaveBeenCalled()
  })

  it('cut a long answer at its end and say so', async () => {
    const { tools: listed } = tools([installed()], async () => 'x'.repeat(TOOL_RESULT_CHARS + 5))
    const result = await listed.call('acme_tools__lookup', { query: 'a' })
    const text = (result.content[0] as { text: string }).text
    expect(text.startsWith('x'.repeat(TOOL_RESULT_CHARS))).toBe(true)
    expect(text).toContain('was cut')
  })
})
