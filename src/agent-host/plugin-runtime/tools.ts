// The tools plugins give agents, on Kettu's MCP service beside its own. A tool is declared in its
// plugin's manifest, so the list is known without loading any script; a call wakes the plugin,
// checks the arguments against the declaration and runs the function the script exports under the
// tool's name. A crash, a timeout or an error of the script is an error result, never a hang.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { PluginRequestError } from '@shared/plugin-host'
import { pluginToolName, toolTrigger, type PluginToolSchema } from '@shared/plugins'
import type { InstalledTool } from '../plugins/service'
import type { LogFn } from '../storage'

/** The most of a tool's answer an agent is given, cut at its end. */
export const TOOL_RESULT_CHARS = 100_000

export interface PluginToolsDeps {
  /** The tools of the plugins that are on, in the order the plugins were installed. */
  installed(): InstalledTool[]
  client: {
    activate(pluginId: string, trigger: string): Promise<void>
    call(pluginId: string, name: string, args: unknown[]): Promise<unknown>
  }
  log: LogFn
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The arguments a call gave, as the tool's declaration takes them, or what is wrong with them. */
export function checkToolArguments(
  schema: PluginToolSchema,
  input: unknown,
): { value: Record<string, unknown> } | { error: string } {
  const given = input ?? {}
  if (!isRecord(given)) return { error: 'The arguments must be an object.' }
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(schema.properties, key)) return { error: `Unknown argument "${key}".` }
  }
  for (const key of schema.required ?? []) {
    if (given[key] === undefined) return { error: `The argument "${key}" is required.` }
  }
  const value: Record<string, unknown> = {}
  for (const [key, argument] of Object.entries(schema.properties)) {
    const item = given[key]
    if (item === undefined) continue
    const wrong = (what: string): { error: string } => ({ error: `The argument "${key}" ${what}.` })
    switch (argument.type) {
      case 'string':
        if (typeof item !== 'string') return wrong('must be a string')
        if (argument.enum && !argument.enum.includes(item)) {
          return wrong(`must be one of ${argument.enum.map((v) => JSON.stringify(v)).join(', ')}`)
        }
        break
      case 'boolean':
        if (typeof item !== 'boolean') return wrong('must be true or false')
        break
      case 'integer':
      case 'number':
        if (typeof item !== 'number' || !Number.isFinite(item)) return wrong('must be a number')
        if (argument.type === 'integer' && !Number.isInteger(item)) {
          return wrong('must be a whole number')
        }
        if (argument.minimum !== undefined && item < argument.minimum) {
          return wrong(`must be at least ${argument.minimum}`)
        }
        if (argument.maximum !== undefined && item > argument.maximum) {
          return wrong(`must be at most ${argument.maximum}`)
        }
        break
    }
    value[key] = item
  }
  return { value }
}

function failed(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Why a call failed, in words the agent can pass on: the script's own message when it threw. */
function reasonOf(error: unknown): string {
  if (!(error instanceof PluginRequestError)) {
    return error instanceof Error ? error.message : String(error)
  }
  switch (error.code) {
    case 'failed':
      // The script's error arrives as `Error: message`; the name says nothing for a plain one.
      return error.message.replace(/^Error: /, '')
    case 'timeout':
      return 'the plugin did not answer in time'
    case 'crashed':
      return 'the plugin was stopped for using too much time or memory'
    case 'disabled':
      return 'the plugin was turned off after it crashed too often'
    case 'unavailable':
    case 'not_active':
      return 'the plugin could not be started'
    default:
      return error.message
  }
}

/** What the script answered, as the text the agent reads. */
function answerText(answer: unknown): string {
  const text =
    typeof answer === 'string' ? answer : answer === null ? 'Done.' : JSON.stringify(answer)
  return text.length > TOOL_RESULT_CHARS
    ? `${text.slice(0, TOOL_RESULT_CHARS)}\n[The answer was cut at ${TOOL_RESULT_CHARS} characters.]`
    : text
}

export class PluginTools {
  constructor(private readonly deps: PluginToolsDeps) {}

  /** The tools by their names on the service. A name two plugins would share goes to the first. */
  private named(): Map<string, InstalledTool> {
    const named = new Map<string, InstalledTool>()
    for (const tool of this.deps.installed()) {
      const name = pluginToolName(tool.pluginName, tool.name)
      if (named.has(name)) {
        this.deps.log(
          'warn',
          `The plugin ${tool.pluginId} gives ${name}, which another plugin does`,
        )
        continue
      }
      named.set(name, tool)
    }
    return named
  }

  /** The tools as `tools/list` shows them. */
  listed(): Tool[] {
    return [...this.named()].map(([name, tool]) => ({
      name,
      title: `${tool.plugin}: ${tool.name}`,
      description: `${tool.description} (A tool of the plugin "${tool.plugin}".)`,
      inputSchema: {
        type: 'object',
        properties: tool.inputSchema.properties,
        ...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}),
        additionalProperties: false,
      },
    }))
  }

  /** Whether a tool of this name is given by a plugin that is on. */
  has(name: string): boolean {
    return this.named().has(name)
  }

  /** Whether a call's arguments are not what the tool's declaration takes. */
  argumentsWrong(name: string, input: unknown): boolean {
    const tool = this.named().get(name)
    return tool !== undefined && 'error' in checkToolArguments(tool.inputSchema, input)
  }

  async call(name: string, input: unknown): Promise<CallToolResult> {
    const tool = this.named().get(name)
    if (!tool) return failed(`${name} is not available: its plugin is off or removed.`)
    const checked = checkToolArguments(tool.inputSchema, input)
    if ('error' in checked) return failed(checked.error)
    try {
      await this.deps.client.activate(tool.pluginId, toolTrigger(tool.name))
      const answer = await this.deps.client.call(tool.pluginId, tool.name, [checked.value])
      return { content: [{ type: 'text', text: answerText(answer) }] }
    } catch (error) {
      const reason = reasonOf(error)
      this.deps.log('warn', `The tool ${name} of ${tool.pluginId} failed: ${reason}`)
      return failed(`${name} failed: ${reason}`)
    }
  }
}
