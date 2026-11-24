// What a call of an MCP tool is named in the thread: Kettu's own tools by what they do, in the
// interface language, with the argument that tells the call apart; another server's tools as
// `server: tool`. It is worked out from the call's title when drawn, so earlier sessions read the same.

import type session from '@shared/locales/en/session.json'
import { KETTU_SERVER, mcpCallsOf, type McpCall } from '@shared/mcp-call'
import { isPluginToolName } from '@shared/plugins'
import type { ToolEntry } from '@shared/thread'
import { relativePath } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'

type KettuTool = keyof (typeof session)['kettuTool']

/**
 * Where a call's target comes from: an argument as written, a path shown from the project's
 * folder, a list of words, or the session or terminal an id names, by its name.
 */
type Target =
  | string
  | { path: string }
  | { list: string; separator: string }
  | { session: string }
  | { terminal: string }

// Each tool's target, the first of its arguments the call gives. What the agent types is left out,
// since it may be a password.
const TARGETS = {
  read_kettu_guide: ['topic'],
  call_kettu_tool: ['tool'],
  create_artifact: ['title'],
  read_artifact: ['path'],
  update_artifact: ['title'],
  list_artifacts: ['query'],
  delete_artifact: [],
  list_artifact_versions: [],
  restore_artifact_version: [],
  list_artifact_types: [],
  read_artifact_type: ['reference', 'type'],
  create_artifact_from_type: ['title'],
  read_comments: [],
  reply_comment: [],
  resolve_comment: [],
  read_artifact_data: ['collection'],
  write_artifact_data: ['collection'],
  list_agents: [],
  list_sessions: ['query'],
  get_session: [{ session: 'id' }],
  rename_session: ['title'],
  archive_session: [{ session: 'id' }],
  start_session: ['title'],
  read_session_history: [{ session: 'id' }],
  send_message: [{ session: 'id' }],
  set_plan: [],
  report_problem: ['title'],
  browser_navigate: ['url'],
  browser_navigate_back: [],
  browser_reload: [],
  browser_snapshot: [],
  browser_click: ['element'],
  browser_type: ['element'],
  browser_press_key: ['key'],
  browser_scroll: [],
  browser_select_option: ['element'],
  browser_take_screenshot: [],
  browser_wait_for: ['text', 'text_gone'],
  browser_console_messages: [],
  browser_network_requests: [],
  browser_evaluate: [],
  browser_ask_user: ['reason'],
  browser_tabs: [],
  device_list: [],
  device_open: [],
  device_close: [],
  device_snapshot: [],
  device_tap: [],
  device_fill: [],
  device_type: [],
  device_scroll: [],
  device_swipe: [],
  device_press_button: [],
  device_rotate: [],
  device_screenshot: [],
  device_install_app: [{ path: 'path' }],
  device_launch_app: ['app'],
  device_terminate_app: ['app'],
  device_open_url: ['url'],
  device_logs: [],
  device_set_appearance: [],
  device_set_location: [],
  device_set_permission: ['app'],
  terminal_list: [],
  terminal_run: ['command'],
  terminal_read: [{ terminal: 'terminalId' }],
  terminal_wait: [{ terminal: 'terminalId' }],
  terminal_input: [{ terminal: 'terminalId' }],
  terminal_stop: [{ terminal: 'terminalId' }],
  terminal_rename: ['name', { terminal: 'terminalId' }],
  computer_list_apps: [],
  computer_list_windows: [],
  computer_get_window_state: ['query'],
  computer_click: [],
  computer_type_text: [],
  computer_press_key: ['key'],
  computer_hotkey: [{ list: 'keys', separator: '+' }],
  computer_scroll: [],
  computer_drag: [],
  computer_invoke_menu: [{ list: 'path', separator: ' › ' }],
  list_memories: [],
  read_memory: ['id'],
  remember: ['title'],
  update_memory: ['title', 'id'],
  forget_memory: ['id'],
  marketplace_check: [{ path: 'path' }],
  marketplace_convert: [{ path: 'path' }],
  marketplace_publish: [{ path: 'path' }],
  marketplace_mine: [],
  marketplace_unlist: ['listing'],
  list_workflows: [],
  suggest_workflow: ['title'],
  create_workflow: [],
  report_step: ['outcome'],
  pick_step_agents: [],
  find_settings: ['query'],
  open_settings: ['id'],
  change_settings: [],
} satisfies Record<KettuTool, readonly Target[]>

const known = (tool: string): tool is KettuTool => Object.hasOwn(TARGETS, tool)

/** The names of what an id stands for, where the window knows it. */
export interface CallNames {
  session(id: string): string | null
  terminal(id: string): string | null
  /** The title of the plugin that gives a tool, by the tool's name on Kettu's MCP service. */
  plugin(tool: string): string | null
}

type Args = Record<string, unknown>

/**
 * A call's arguments. The hosts keep a call's input as its JSON, or as the command alone when it
 * has one; a script that calls the tool has none of the tool's.
 */
function argsOf(entry: Pick<ToolEntry, 'rawInput'>, call: McpCall): Args {
  const raw = entry.rawInput
  if (!raw || !call.direct) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Args
    }
  } catch {
    // Not JSON: the command alone.
  }
  return { command: raw }
}

function words(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function targetOf(
  target: Target,
  args: Args,
  projectPath: string,
  names: CallNames | undefined,
): string | null {
  if (typeof target === 'string') return words(args[target])
  if ('path' in target) {
    const path = words(args[target.path])
    return path && relativePath(path, projectPath)
  }
  if ('list' in target) {
    const list = args[target.list]
    if (!Array.isArray(list)) return null
    const parts = list.map(words).filter((part) => part !== null)
    return parts.length > 0 ? parts.join(target.separator) : null
  }
  const id = words(args['session' in target ? target.session : target.terminal])
  if (!id || !names) return null
  return 'session' in target ? names.session(id) : names.terminal(id)
}

/**
 * A plugin's tool, which Kettu lists as `<plugin>__<tool>`: the plugin by its title where the
 * window knows it, else by the short name in the tool's own name, and the tool by its own name.
 */
function pluginTool(tool: string, names: CallNames | undefined): [string, string] | null {
  if (!isPluginToolName(tool)) return null
  const split = tool.indexOf('__')
  return [names?.plugin(tool) ?? tool.slice(0, split), tool.slice(split + 2)]
}

/** A call's name: Kettu's tool by what it does, another server's as `server: tool`. */
function nameOf(call: McpCall, names: CallNames | undefined): string {
  if (call.server !== KETTU_SERVER) {
    return i18n.t('session:tool.mcp', { server: call.server, tool: call.tool })
  }
  if (known(call.tool)) return i18n.t(`session:kettuTool.${call.tool}`)
  const plugin = pluginTool(call.tool, names)
  return plugin ? i18n.t('session:tool.mcp', { server: plugin[0], tool: plugin[1] }) : call.tool
}

/**
 * The label of a call of an MCP tool, null for any other call: Kettu's tool named with its target,
 * or with none when the call gives none; another server's tool as its name alone.
 */
export function mcpLabel(
  entry: Pick<ToolEntry, 'title' | 'rawInput'>,
  projectPath: string,
  names?: CallNames,
): { verb: string | null; target: string | null; kind: 'tool' | 'title' } | null {
  const calls = mcpCallsOf(entry.title)
  if (!calls) return null
  const [call] = calls
  if (calls.length > 1 || call!.server !== KETTU_SERVER) {
    // A script that calls several tools is named by them all.
    const text = calls
      .map((one) => nameOf(one, names))
      .join(i18n.t('session:summary.nameSeparator'))
    return { verb: null, target: text, kind: 'title' }
  }
  const tool = call!.tool
  if (!known(tool)) {
    const plugin = pluginTool(tool, names)
    return plugin
      ? { verb: plugin[0], target: plugin[1], kind: 'tool' }
      : { verb: tool, target: null, kind: 'tool' }
  }
  const args = argsOf(entry, call!)
  let target: string | null = null
  for (const spec of TARGETS[tool] as readonly Target[]) {
    target = targetOf(spec, args, projectPath, names)
    if (target) break
  }
  return { verb: nameOf(call!, names), target, kind: 'tool' }
}
