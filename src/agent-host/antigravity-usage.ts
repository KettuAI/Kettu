// Google Antigravity's plan limits, read through the registry's ACP server, which answers `/usage`
// itself (see vendor-usage/antigravity.ts). Kettu downloads it on the first read and keeps one
// session of its own in it per host, resumed for every read, so its history holds that session
// alone; agy's history and the Antigravity app's never see it.

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { AcpConnection, processTransport } from './acp/connection'
import { installArchive, listArchiveInstalls, programPath } from './archive-install'
import { archiveEntry } from './binary-install'
import { AgentRequestError } from './connection'
import type { VendorUsage } from './vendor-usage/common'
import {
  ANTIGRAVITY_PLAN_SIGN_INS,
  ANTIGRAVITY_USAGE_SERVER,
  namesProxy,
  parseAntigravityUsage,
  systemProxyEnv,
} from './vendor-usage/antigravity'

const AGENT_ID = 'antigravity'
const SESSION_FILE = 'usage-session.json'
const INSTALL_MS = 5 * 60_000
const STOP_MS = 2_000

export interface AntigravityUsageDeps {
  /** Kettu's harness folder; the server goes into its `antigravity` folder. */
  adaptersDir: string
  /** The folder the server's session works in. */
  reportsDir: string
  platform: Platform
  arch: string
  appVersion: string
  /** The agent's environment, which the server runs with. */
  env: NodeJS.ProcessEnv
  /** The method agy is signed in with, which the server signs in with too when it must. */
  signIn: string | null
  /** What `scutil --proxy` prints, on macOS; null when it cannot run. */
  systemProxy(): Promise<string | null>
  timeoutMs: number
  log(message: string): void
}

/** The server's program, downloaded and checked against the registry's hash on first use. */
async function serverProgram(
  deps: AntigravityUsageDeps,
): Promise<{ file: string; args: string[] }> {
  const { version } = ANTIGRAVITY_USAGE_SERVER
  const entry = archiveEntry(ANTIGRAVITY_USAGE_SERVER, deps.platform, deps.arch)
  if (!entry) throw new Error(`The usage server has no build for ${deps.platform} ${deps.arch}`)
  const installs = await listArchiveInstalls(deps.adaptersDir, AGENT_ID)
  let current = installs.find(
    (install) => install.version === version && install.sha256 === entry.sha256,
  )
  if (!current) {
    current = await installArchive({
      root: deps.adaptersDir,
      agentId: AGENT_ID,
      version,
      url: entry.url,
      sha256: entry.sha256,
      cmd: entry.cmd,
      ...(entry.args ? { args: entry.args } : {}),
      platform: deps.platform,
      timeoutMs: INSTALL_MS,
    })
    // Earlier versions, the one sessions once ran on included, are no longer used.
    for (const install of installs) {
      if (install.dir !== current.dir) await rm(install.dir, { recursive: true, force: true })
    }
  }
  return { file: programPath(current.dir, current.cmd, deps.platform), args: current.args }
}

async function savedSession(file: string): Promise<string | null> {
  try {
    const id = (JSON.parse(await readFile(file, 'utf8')) as { sessionId?: unknown }).sessionId
    return typeof id === 'string' && /^[\w-]{1,128}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * The environment the server runs with: the agent's, and on macOS the system's HTTP(S) proxy when
 * the agent's names none, since the server reads no system settings and fails on a system SOCKS
 * proxy it cannot use.
 */
async function serverEnv(deps: AntigravityUsageDeps): Promise<NodeJS.ProcessEnv> {
  if (deps.platform !== 'darwin' || namesProxy(deps.env)) return deps.env
  const scutil = await deps.systemProxy()
  return scutil ? { ...deps.env, ...systemProxyEnv(scutil) } : deps.env
}

/**
 * Reads the account's quota groups: starts the server, resumes Kettu's session in it or opens one
 * and keeps its id, sends `/usage`, and stops the server. Only for a Google or Gemini Enterprise
 * sign-in; a reply it cannot read is a failed read.
 */
export async function readAntigravityUsage(
  deps: AntigravityUsageDeps,
  now: number,
): Promise<VendorUsage> {
  if (!deps.signIn || !ANTIGRAVITY_PLAN_SIGN_INS.includes(deps.signIn)) {
    throw new Error('Plan limits are read only for a Google or Gemini Enterprise sign-in')
  }
  const program = await serverProgram(deps)
  const env = await serverEnv(deps)
  await mkdir(deps.reportsDir, { recursive: true })
  const child = spawn(program.file, program.args, {
    cwd: deps.reportsDir,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  const connection = AcpConnection.connect(processTransport(child.stdin, child.stdout), {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: deps.log,
    name: 'The Antigravity usage server',
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The usage server gave no answer within ${deps.timeoutMs / 1000} s`)),
      deps.timeoutMs,
    )
  })
  const gone = exited.then((): never => {
    throw new Error('The usage server exited before it answered')
  })
  try {
    const messages = await Promise.race([read(connection, deps), late, gone])
    const usage = messages
      .map((text) => parseAntigravityUsage(text, now))
      .findLast((parsed) => parsed !== null)
    if (!usage) throw new Error('The usage server gave no report Kettu can read')
    return usage
  } finally {
    if (timer) clearTimeout(timer)
    connection.close()
    child.stdin.end()
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_MS).unref()),
    ])
    if (!stopped) child.kill('SIGKILL')
  }
}

async function read(connection: AcpConnection, deps: AntigravityUsageDeps): Promise<string[]> {
  const init = await connection.initialize(deps.appVersion)
  const file = path.join(deps.adaptersDir, AGENT_ID, SESSION_FILE)
  const saved = await savedSession(file)
  const open = async (): Promise<string> => {
    if (saved && init.capabilities.resumeSession) {
      try {
        await connection.resumeSession(saved, deps.reportsDir)
        return saved
      } catch (error) {
        if (error instanceof AgentRequestError && error.kind === 'auth_required') throw error
        deps.log(`could not resume its usage session, opening another: ${(error as Error).message}`)
      }
    }
    const opened = await connection.newSession(deps.reportsDir)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ sessionId: opened.sessionId })}\n`)
    return opened.sessionId
  }
  let sessionId: string
  try {
    sessionId = await open()
  } catch (error) {
    // The server keeps its own sign-in settings; with none it signs in as agy does, from the
    // credentials agy keeps.
    if (!(error instanceof AgentRequestError && error.kind === 'auth_required')) throw error
    await connection.authenticate(deps.signIn!)
    sessionId = await open()
  }
  return connection.collect(sessionId, '/usage')
}
