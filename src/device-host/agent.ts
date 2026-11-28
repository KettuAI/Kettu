// Agents' actions on devices, carried out by agent-device (MIT): one of its sessions per Kettu
// session and device, its state in Kettu's data folder, its update notice off. Kettu runs only the
// commands it builds here from checked arguments.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Env } from '../agent-host/find-command'
import type { DeviceAction, DeviceActionResult } from '@shared/device-agent'
import type { FoundDevice, Tools } from './discovery'
import {
  classifyPhysicalIosRunnerFailure,
  extractDiagnosticLogPath,
  findDevelopmentTeam,
  parseAgentDeviceFailureJson,
  readRunnerLogTail,
  type PhysicalIosRunnerProbeResult,
  type PhysicalIosRunnerProblem,
} from './ios-physical-setup'
import { nodeCommand, packageRoot } from './runtime'

const COMMAND_TIMEOUT_MS = 180_000
const PROBE_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 512 * 1024
const SPRINGBOARD = 'com.apple.springboard'

export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly problem: PhysicalIosRunnerProblem | null = null,
  ) {
    super(message)
  }
}

function cli(): string {
  return path.join(packageRoot('agent-device'), 'bin', 'agent-device.mjs')
}

interface Output {
  code: number | null
  stdout: string
  stderr: string
}

export class AgentActions {
  /** The sessions agent-device has open, so the first action on a device opens one. */
  private readonly opened = new Set<string>()

  constructor(
    private readonly dataDir: string,
    private readonly env: () => Promise<Env>,
    private readonly tools: () => Promise<Tools>,
    private readonly log: (message: string) => void,
  ) {}

  async run(
    sessionId: string,
    device: FoundDevice,
    action: DeviceAction,
    signal: AbortSignal,
  ): Promise<DeviceActionResult> {
    const session = this.sessionName(sessionId, device)
    const selector = this.selector(device)
    if (action.type === 'launch') {
      const out = await this.cli(
        ['open', action.app, ...selector, '--session', session, '--relaunch'],
        signal,
        device,
      )
      this.opened.add(session)
      return { text: this.text(out) }
    }
    if (action.type === 'open_url') {
      const out = await this.cli(
        ['open', action.url, ...selector, '--session', session],
        signal,
        device,
      )
      this.opened.add(session)
      return { text: this.text(out) }
    }
    if (action.type === 'install') {
      const out = await this.cli(
        ['install', action.path, ...selector, '--session', session],
        signal,
        device,
      )
      return { text: this.text(out) }
    }
    await this.ensureSession(session, device, selector, signal)
    switch (action.type) {
      case 'snapshot': {
        let out = await this.cli(['snapshot', '-i', '--session', session], signal, device, true)
        // An iOS session follows one app; reading the screen with none open reads the home screen.
        if (
          out.code !== 0 &&
          /requires an active app session|No foreground app/.test(out.stdout + out.stderr)
        ) {
          await this.cli(['open', SPRINGBOARD, '--session', session], signal, device)
          out = await this.cli(['snapshot', '-i', '--session', session], signal, device)
        } else if (out.code !== 0) {
          throw await this.failure(out, device)
        }
        return { text: this.text(out) }
      }
      case 'tap': {
        const target = 'ref' in action ? [action.ref] : [String(action.x), String(action.y)]
        const verb = action.long ? 'longpress' : 'press'
        return {
          text: this.text(
            await this.cli([verb, ...target, '--settle', '--session', session], signal, device),
          ),
        }
      }
      case 'fill':
        return {
          text: this.text(
            await this.cli(
              ['fill', action.ref, action.text, '--settle', '--session', session],
              signal,
              device,
            ),
          ),
        }
      case 'type':
        return {
          text: this.text(
            await this.cli(['type', action.text, '--session', session], signal, device),
          ),
        }
      case 'scroll':
        return {
          text: this.text(
            await this.cli(
              ['scroll', action.direction, '--settle', '--session', session],
              signal,
              device,
            ),
          ),
        }
      case 'swipe':
        return {
          text: this.text(
            await this.cli(
              [
                'gesture',
                'pan',
                String(action.from.x),
                String(action.from.y),
                String(action.to.x - action.from.x),
                String(action.to.y - action.from.y),
                '--session',
                session,
              ],
              signal,
              device,
            ),
          ),
        }
      case 'button': {
        const args =
          action.button === 'home'
            ? ['home']
            : action.button === 'back'
              ? ['back']
              : action.button === 'recents'
                ? ['app-switcher']
                : [
                    'hardware-button',
                    action.button === 'lock'
                      ? 'power'
                      : action.button === 'volumeUp'
                        ? 'volume-up'
                        : 'volume-down',
                  ]
        return { text: this.text(await this.cli([...args, '--session', session], signal, device)) }
      }
      case 'rotate':
        return {
          text: this.text(
            await this.cli(
              ['orientation', action.orientation.replace(/_/g, '-'), '--session', session],
              signal,
              device,
            ),
          ),
        }
      case 'terminate':
        return {
          text: this.text(
            await this.cli(['close', action.app, '--session', session], signal, device),
          ),
        }
      case 'logs': {
        const out = await this.cli(['logs', 'path', '--session', session], signal, device, true)
        const file = /(\/\S+\.log)\b/.exec(out.stdout)?.[1]
        const text = file ? await readFile(file, 'utf8').catch(() => '') : ''
        if (text) return { text: text.split('\n').slice(-action.lines).join('\n') }
        await this.cli(['logs', 'start', '--session', session], signal, device, true)
        return {
          text: 'Log capture started for the app open in this session. Read the logs again after the app has run.',
        }
      }
      case 'screenshot': {
        const out = await this.cli(['screenshot', '--session', session, '--json'], signal, device)
        const file = (JSON.parse(out.stdout) as { data?: { path?: string } }).data?.path
        if (!file) throw new ActionError('screenshot', 'No screenshot was saved')
        const png = await readFile(file)
        await rm(file, { force: true })
        return { text: 'Screenshot of the device.', image: png.toString('base64') }
      }
      case 'appearance':
        return {
          text: this.text(
            await this.cli(
              ['settings', 'appearance', action.mode, '--session', session],
              signal,
              device,
            ),
          ),
        }
      case 'location':
        return {
          text: this.text(
            await this.cli(
              [
                'settings',
                'location',
                'set',
                String(action.latitude),
                String(action.longitude),
                '--session',
                session,
              ],
              signal,
              device,
            ),
          ),
        }
      case 'permission':
        return {
          text: this.text(
            await this.cli(
              [
                'settings',
                'permission',
                action.grant ? 'grant' : 'deny',
                action.permission,
                '--app',
                action.app,
                '--session',
                session,
              ],
              signal,
              device,
            ),
          ),
        }
    }
  }

  /** Ends the agent-device sessions of a Kettu session, leaving the devices as they are. */
  async endSession(sessionId: string, devices: FoundDevice[]): Promise<void> {
    for (const device of devices) {
      const session = this.sessionName(sessionId, device)
      if (!this.opened.delete(session)) continue
      await this.cli(
        ['close', '--session', session],
        new AbortController().signal,
        device,
        true,
      ).catch(() => undefined)
    }
  }

  /**
   * Prepares and health-checks the XCTest runner on a physical iOS device to verify signing,
   * developer trust and Enable UI Automation.
   */
  async probeIosRunner(
    device: FoundDevice,
    signal: AbortSignal,
  ): Promise<PhysicalIosRunnerProbeResult> {
    if (device.platform !== 'ios' || device.kind !== 'physical') return { ok: true }
    try {
      const out = await this.cli(
        ['prepare', 'ios-runner', '--platform', 'ios', '--udid', device.target, '--json'],
        signal,
        device,
        true,
        PROBE_TIMEOUT_MS,
      )
      if (out.code === 0) return { ok: true }
      const diagnostic = parseAgentDeviceFailureJson(out.stdout, out.stderr)
      if (diagnostic.logPath) {
        diagnostic.logTail = await readRunnerLogTail(diagnostic.logPath, this.dataDir)
      }
      const problem = classifyPhysicalIosRunnerFailure(diagnostic)
      const message =
        diagnostic.message || out.stderr.trim() || out.stdout.trim() || 'Runner check failed'
      return { ok: false, problem, message }
    } catch (error) {
      if (error instanceof ActionError && error.code === 'stopped') {
        return { ok: false, problem: null, message: error.message }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        problem: classifyPhysicalIosRunnerFailure({ message }),
        message,
      }
    }
  }

  private async ensureSession(
    session: string,
    device: FoundDevice,
    selector: string[],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.opened.has(session)) return
    const out = await this.cli(['open', ...selector, '--session', session], signal, device, true)
    if (out.code !== 0 && !/already/i.test(out.stdout + out.stderr)) {
      throw await this.failure(out, device)
    }
    this.opened.add(session)
  }

  private selector(device: FoundDevice): string[] {
    return device.platform === 'ios'
      ? ['--platform', 'ios', '--udid', device.target]
      : ['--platform', 'android', '--serial', device.target]
  }

  private sessionName(sessionId: string, device: FoundDevice): string {
    const hash = createHash('sha256')
      .update(`${sessionId}\0${device.id}`)
      .digest('hex')
      .slice(0, 12)
    return `kettu-${hash}`
  }

  private text(out: Output): string {
    const text = out.stdout.trim()
    return text.length > 0 ? text : 'Done.'
  }

  private async failure(out: Output, device: FoundDevice): Promise<ActionError> {
    const text = `${out.stdout}\n${out.stderr}`.trim()
    const code = /Error \(([A-Z_]+)\)/.exec(text)?.[1] ?? 'command_failed'
    let problem: PhysicalIosRunnerProblem | null = null
    if (device.platform === 'ios' && device.kind === 'physical') {
      const logPath = extractDiagnosticLogPath(text)
      const logTail = logPath ? await readRunnerLogTail(logPath, this.dataDir) : null
      problem = classifyPhysicalIosRunnerFailure({
        code,
        stdout: out.stdout,
        stderr: out.stderr,
        logTail,
      })
    }
    // The diagnostics lines point at agent-device's own files; the agent needs only the error.
    const message = text
      .split('\n')
      .filter((line) => !/^Diagnostic|^Diagnostics Log/.test(line))
      .join('\n')
      .slice(0, 4_000)
    return new ActionError(code, message || 'The device command failed', problem)
  }

  private async cli(
    args: string[],
    signal: AbortSignal,
    device: FoundDevice,
    allowFailure = false,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<Output> {
    const base = await this.env()
    const extra: Env = {
      AGENT_DEVICE_HOME: path.join(this.dataDir, 'agent-device'),
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
    }
    // agent-device looks for adb on PATH; an SDK Kettu found elsewhere, as Homebrew's, joins it.
    const { adb, emulator } = await this.tools()
    const dirs = [adb, emulator]
      .filter((file): file is string => !!file)
      .map((file) => path.dirname(file))
    if (dirs.length > 0) {
      const sdk = adb ? path.dirname(path.dirname(adb)) : null
      extra.PATH = [...new Set(dirs), base.PATH].filter(Boolean).join(path.delimiter)
      if (sdk && !base.ANDROID_HOME && !base.ANDROID_SDK_ROOT) extra.ANDROID_HOME = sdk
    }
    if (device.platform === 'ios' && device.kind === 'physical') {
      const team = await findDevelopmentTeam(base)
      if (team) extra.AGENT_DEVICE_IOS_TEAM_ID = team
    }
    const node = nodeCommand({ ...base, ...extra } as NodeJS.ProcessEnv)
    const out = await new Promise<Output>((resolve, reject) => {
      const child = spawn(node.file, [cli(), ...args], {
        env: node.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString()
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString()
      })
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      const abort = (): void => {
        child.kill('SIGTERM')
      }
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        resolve({ code, stdout, stderr })
      })
    })
    if (signal.aborted) throw new ActionError('stopped', 'The user stopped the agent')
    if (out.code !== 0) {
      this.log(`agent-device ${args[0]} failed: ${(out.stderr || out.stdout).slice(0, 500)}`)
      if (!allowFailure) throw await this.failure(out, device)
    }
    return out
  }
}
