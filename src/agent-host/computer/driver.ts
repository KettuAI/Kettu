// Cua Driver as computer use runs it: `cua-driver mcp --direct`, a child of this host spoken to
// over stdio, started on the first call and ended when idle, on Stop and at shutdown. As a direct
// child it is in Kettu's responsibility chain, so macOS answers its permission checks with
// Kettu's grants, and in embedded mode it never prompts or relaunches itself.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ComputerPermissions } from '@shared/computer-use'
import type { LogFn } from '../storage'

/** An idle driver ends after this; the next call starts it again. */
export const DRIVER_IDLE_MS = 5 * 60_000
/** A call the driver does not answer in this time fails. */
export const DRIVER_CALL_MS = 60_000

/** What a desktop session needs to reach its display, accessibility bus and input. */
const DESKTOP_VARIABLES = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_DESKTOP',
  'DBUS_SESSION_BUS_ADDRESS',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TMP',
  'TEMP',
]

/**
 * The driver's environment beside the MCP SDK's safe defaults: the desktop session's variables,
 * and the switches that keep it embedded, off the network and out of the unrestricted mode. No
 * variable of the user's own Cua setup passes, so none can change its mode or reports.
 */
export function driverEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of DESKTOP_VARIABLES) {
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  // Without it the driver reaches a Wayland desktop only through XWayland.
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY)
    out.CUA_DRIVER_RS_ENABLE_WAYLAND = '1'
  return {
    ...out,
    CUA_DRIVER_EMBEDDED: '1',
    // Its usage reports are on by default; this switch wins over every other setting.
    DO_NOT_TRACK: '1',
    // Otherwise it asks GitHub and cua.ai for a newer release on every start.
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
    CUA_DRIVER_DISABLE_UNRESTRICTED: '1',
  }
}

export interface ComputerDriverDeps {
  /** The `cua-driver` program the app ships. */
  path: string
  log: LogFn
  env?: NodeJS.ProcessEnv
  idleMs?: number
}

function loadClient() {
  return Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]).then(([client, stdio]) => ({ ...client, ...stdio }))
}

export class ComputerDriver {
  private client: Promise<Client> | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  /** Calls in flight; the driver never ends while one runs. */
  private running = 0

  constructor(private readonly deps: ComputerDriverDeps) {}

  /** Calls one of the driver's tools; a driver that exited is started again for it. */
  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.running++
    this.clearIdle()
    try {
      const client = await this.connect()
      return (await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: DRIVER_CALL_MS,
      })) as CallToolResult
    } finally {
      this.running--
      this.armIdle()
    }
  }

  /** Ends the driver, and with it any call still in flight. */
  async stop(): Promise<void> {
    this.clearIdle()
    const client = this.client
    this.client = null
    if (!client) return
    try {
      await (await client).close()
    } catch {
      // A driver that never started has nothing to close.
    }
  }

  private connect(): Promise<Client> {
    this.client ??= this.start().catch((error: unknown) => {
      this.client = null
      throw error
    })
    return this.client
  }

  private async start(): Promise<Client> {
    const sdk = await loadClient()
    const transport = new sdk.StdioClientTransport({
      command: this.deps.path,
      args: ['mcp', '--direct'],
      env: driverEnv(this.deps.env ?? process.env),
      stderr: 'pipe',
    })
    let tail = ''
    transport.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2_000)
    })
    const client = new sdk.Client({ name: 'kettu', version: '1' })
    const started = this.client
    client.onclose = () => {
      // An exit nobody asked for: the next call starts a new driver.
      if (this.client === started) this.client = null
      if (tail.trim()) this.deps.log('warn', `Cua Driver exited: ${tail.trim().slice(-500)}`)
    }
    await client.connect(transport)
    this.deps.log('info', `Cua Driver started, process ${transport.pid ?? 'unknown'}`)
    return client
  }

  private armIdle(): void {
    if (this.running > 0 || !this.client) return
    this.idle = setTimeout(() => void this.stop(), this.deps.idleMs ?? DRIVER_IDLE_MS)
    this.idle.unref?.()
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }
}

/**
 * Kettu's macOS grants as a driver started for the check reports them, read-only, without a
 * prompt: a new process, since a running one may keep an old Screen Recording answer. Null when
 * the answer is not one this knows.
 */
export async function probePermissions(
  deps: Omit<ComputerDriverDeps, 'idleMs'>,
): Promise<ComputerPermissions | null> {
  const driver = new ComputerDriver(deps)
  try {
    const result = await driver.call('check_permissions', { prompt: false })
    const found = result.structuredContent as Record<string, unknown> | undefined
    if (
      result.isError ||
      typeof found?.accessibility !== 'boolean' ||
      typeof found.screen_recording !== 'boolean'
    ) {
      return null
    }
    return { accessibility: found.accessibility, screenRecording: found.screen_recording }
  } finally {
    await driver.stop()
  }
}
