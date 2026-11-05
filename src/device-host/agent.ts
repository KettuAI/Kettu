// Agents' actions on devices, carried out by agent-device (MIT): one of its sessions per Kettu
// session and device, its state in Kettu's data folder, its update notice off. Kettu runs only the
// commands it builds here from checked arguments.

import { execFile, spawn } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Env } from '../agent-host/find-command'
import type { DeviceAction, DeviceActionResult } from '@shared/device-agent'
import type { FoundDevice } from './discovery'
import { nodeCommand, packageRoot } from './runtime'

const COMMAND_TIMEOUT_MS = 180_000
const MAX_OUTPUT = 512 * 1024
const SPRINGBOARD = 'com.apple.springboard'

export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
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

/** The Apple development team of the first development certificate in the keychain. */
async function developmentTeam(env: Env): Promise<string | null> {
  const pem = await new Promise<string>((resolve) =>
    execFile(
      '/usr/bin/security',
      ['find-certificate', '-a', '-c', 'Apple Development', '-p'],
      { env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (_, stdout) => resolve(String(stdout ?? '')),
    ),
  )
  for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ??
    []) {
    try {
      const subject = new X509Certificate(block).subject
      const team = /^OU=([A-Z0-9]{10})$/m.exec(subject)?.[1]
      if (team) return team
    } catch {
      // Not a certificate Node can read.
    }
  }
  return null
}

export class AgentActions {
  private team: Promise<string | null> | null = null
  /** The sessions agent-device has open, so the first action on a device opens one. */
  private readonly opened = new Set<string>()

  constructor(
    private readonly dataDir: string,
    private readonly env: () => Promise<Env>,
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
          throw this.failure(out)
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

  private async ensureSession(
    session: string,
    device: FoundDevice,
    selector: string[],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.opened.has(session)) return
    const out = await this.cli(['open', ...selector, '--session', session], signal, device, true)
    if (out.code !== 0 && !/already/i.test(out.stdout + out.stderr)) throw this.failure(out)
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

  private failure(out: Output): ActionError {
    const text = `${out.stdout}\n${out.stderr}`.trim()
    const code = /Error \(([A-Z_]+)\)/.exec(text)?.[1] ?? 'command_failed'
    // The diagnostics lines point at agent-device's own files; the agent needs only the error.
    const message = text
      .split('\n')
      .filter((line) => !/^Diagnostic|^Diagnostics Log/.test(line))
      .join('\n')
      .slice(0, 4_000)
    return new ActionError(code, message || 'The device command failed')
  }

  private async cli(
    args: string[],
    signal: AbortSignal,
    device: FoundDevice,
    allowFailure = false,
  ): Promise<Output> {
    const base = await this.env()
    const extra: Env = {
      AGENT_DEVICE_HOME: path.join(this.dataDir, 'agent-device'),
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
    }
    if (device.platform === 'ios' && device.kind === 'physical') {
      this.team ??= developmentTeam(base)
      const team = await this.team
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
      const timer = setTimeout(() => child.kill('SIGTERM'), COMMAND_TIMEOUT_MS)
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
      if (!allowFailure) throw this.failure(out)
    }
    return out
  }
}
