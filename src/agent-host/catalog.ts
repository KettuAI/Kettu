// What every built-in agent shares: the types, the launch and detection helpers, and the list of
// one module per agent in agents/.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { InstalledCli, LimitsReason } from '@shared/agent-host'
import type { NodeRuntime } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { HostSettings } from '@shared/settings'
import { harnessOf, type AgentId, type HarnessId } from '@shared/thread'
import { listInstalled, type InstalledAdapter } from './adapter-install'
import { AGORAGENTIC } from './agents/agoragentic'
import { AMP } from './agents/amp'
import { ANTIGRAVITY } from './agents/antigravity'
import { AUGGIE } from './agents/auggie'
import { AUTOHAND } from './agents/autohand'
import { BOB } from './agents/bob'
import { CLAUDE_CODE } from './agents/claude-code'
import { CLINE } from './agents/cline'
import { CODEBUDDY } from './agents/codebuddy'
import { CODEWHALE } from './agents/codewhale'
import { CODEX } from './agents/codex'
import { COPILOT } from './agents/copilot'
import { CURSOR } from './agents/cursor'
import { CORTEX_CODE } from './agents/cortex-code'
import { CORUST_AGENT } from './agents/corust-agent'
import { CROW_CLI } from './agents/crow-cli'
import { DEEPAGENTS } from './agents/deepagents'
import { DEEPSEEK } from './agents/deepseek'
import { DEVIN } from './agents/devin'
import { DIMCODE } from './agents/dimcode'
import { DIRAC } from './agents/dirac'
import { DROID } from './agents/droid'
import { fakeAgent } from './agents/fake-agent'
import { FAST_AGENT } from './agents/fast-agent'
import { GEMINI } from './agents/gemini'
import { GLM } from './agents/glm'
import { GOOSE } from './agents/goose'
import { GROK } from './agents/grok'
import { HARN } from './agents/harn'
import { HERMES } from './agents/hermes'
import { KILO } from './agents/kilo'
import { KIMCHI } from './agents/kimchi'
import { KIMI } from './agents/kimi'
import { MINIMAX } from './agents/minimax'
import { MINION } from './agents/minion'
import { MUSE } from './agents/muse'
import { JUNIE } from './agents/junie'
import { MISTRAL_VIBE } from './agents/mistral-vibe'
import { NOVA } from './agents/nova'
import { OMP } from './agents/omp'
import { OPENCODE } from './agents/opencode'
import { PI } from './agents/pi'
import { POOLSIDE } from './agents/poolside'
import { QODER } from './agents/qoder'
import { QODER_CN } from './agents/qoder-cn'
import { QWEN } from './agents/qwen'
import { SIGIT } from './agents/sigit'
import { STAKPAK } from './agents/stakpak'
import { VTCODE } from './agents/vtcode'
import { listArchiveInstalls, programPath, type InstalledArchive } from './archive-install'
import type { BinaryInstalls } from './binary-install'
import type { AdapterLookup } from './codex-binary'
import { findCommand, needsShell, type Env } from './find-command'
import { t, type HostKey } from './i18n'
import {
  CLI_FILES,
  checkCli,
  findInstalledCli,
  type AdapterCli,
  type CliFiles,
  type CliProbe,
  type FoundCli,
} from './installed-cli'
import { orderInstalls, type VersionChoice } from './harness-versions'
import { satisfiesNode, type ConfigFolder, type NodeProbe } from './shell-env'
import { readUvxVersion } from './uvx-install'
import { compareVersions } from './versions'

/** The router's flag that starts each session's process in the session's folder. */
export const FOLDER_PER_SESSION = '--folder-per-session'
/** The router's flag naming the flag a session's process may start with when Kettu asks. */
const SESSION_FLAG = '--session-flag='

export type LaunchKind =
  // Installed from npm into the data directory and run on the user's Node.js. With `perSession`,
  // through the session router, which gives each session an adapter process of its own. `args`
  // turns on its ACP mode, and `env` keeps its variables to its own launches. A `library` is
  // not run: its driver loads its entry module into the agent host. Its version comes from the
  // Registry or the bundled versions, never from here.
  | {
      kind: 'package'
      package: string
      perSession?: true
      library?: true
      /**
       * Not in the Registry as Kettu installs it: the bundled version is the oldest that runs, and
       * npm's newer ones are offered as updates.
       */
      fromVendor?: true
      /** The oldest version the mapping accepts; the Registry's older ones are not used. */
      minimum?: string
      /** With `fromVendor`, the versions an update may move to, as an npm range. */
      updates?: string
      args?: string[]
      env?: Record<string, string>
    }
  // With `perSession`, through the session router, which starts each session's process in the
  // session's own folder, for a program that runs everything in the folder it started in, and
  // with `sessionFlag` added for a session Kettu asks for it, once the program's help lists it.
  | { kind: 'binary'; command: string; args: string[]; perSession?: true; sessionFlag?: string }
  // Run as `uvx <package>==<version> <args>`, which installs the package on first use.
  | { kind: 'uvx'; package: string; args: string[]; minimum?: string }
  // A script run with Electron's own Node.js, so it needs no Node.js on the machine.
  | { kind: 'node-script'; script: string }

/** How Kettu talks to an agent; each protocol has its driver in `drivers.ts`. */
export type AgentProtocol =
  'acp' | 'claude-sdk' | 'cline-sdk' | 'codex-app-server' | 'dsh-sdk' | 'opencode-server' | 'pi-rpc'

/**
 * An interface of the harness's own that an agent runs on in place of the definition's protocol
 * whenever it can. The definition's protocol runs instead for a version of the program the
 * interface was not checked on, one the compatibility manifest holds back, or after a start over
 * it failed. A session opens the same either way.
 */
export interface PreferredProtocol {
  protocol: AgentProtocol
  /** The versions of the harness's program it was checked on, as an npm range. */
  checked: string
}

export interface AgentDefinition {
  id: HarnessId
  name: string
  registryId: string
  /** The protocol it speaks; ACP when not given. */
  protocol?: AgentProtocol
  preferred?: PreferredProtocol
  launch: LaunchKind
  requiresNode?: string
  /** Variables every launch adds. */
  env?: Record<string, string>
  /** Variables the launch of an added agent adds, which keep it apart from the default agent. */
  addedEnv?: Record<string, string>
  install: { hint: HostKey; url: string; notice?: HostKey }
  /** Pushes `_auth/status_update` as it starts, naming its account. */
  reportsAccount?: boolean
  /**
   * Accounts its vendor moved to another harness, which it now refuses: the refusal's words, where
   * they went, who it is still for, and Kettu's message in place of the refusal, since signing in
   * again never helps.
   */
  movedAccounts?: MovedAccounts
  limitsReason?: LimitsReason
  /**
   * Its agent sign-in methods that send their page as a URL elicitation, which opens on the client
   * that asked, so a paired device may run them.
   */
  pageSignIns?: readonly string[]
  /**
   * Keeps MCP servers by name for each folder rather than each session, and names the session on
   * each tool call, so the artifacts service gives its process one token per folder.
   */
  mcpServersByName?: boolean
  /** How Kettu can install the harness's program for the user, by its vendor's routes. */
  installs?: BinaryInstalls
  /** The user's own CLI that runs: the SDK's for Claude Code, the program itself for Codex. */
  cli?: AdapterCli
  /** The variable that moves its configuration folder, which gives each agent a folder of its own. */
  configVariable?: string
  /**
   * The file in which it keeps MCP servers of its own, besides its settings file: `project` is a
   * project's own, relative to its folder, and `listCommand` lists them in a session.
   */
  mcpConfig?: { project: string; listCommand?: string }
  /** What Kettu knows of the models it lists, for an agent that picks who does a workflow step. */
  modelNotes?: readonly ModelNote[]
  /**
   * Shares its sign-in and session history with the vendor's own apps, so signing out and deleting
   * a session say what reaches them (agy 1.5.9 and the Antigravity app).
   */
  sharesSignIn?: true
  /**
   * A sign-in method that reads a key Kettu keeps from `variable`: shown as a key, and run once the
   * key is set, since the agent switches to the key only through `authenticate`.
   */
  keySignIn?: { method: string; variable: string }
  /** Its sign-in runs the program itself in a terminal, in place of the declared `replaces`. */
  terminalSignIn?: { replaces: readonly string[] }
}

/**
 * A model Kettu knows: matched by a model's id or menu value, ranked from 1 (smallest) up within
 * its harness, with its API price when confirmed and a line on when it fits.
 */
export interface ModelNote {
  /** Lowercase ids and menu values it is listed by, such as `claude-opus-5-5` and `opus`. */
  match: readonly string[]
  name: string
  rank: number
  /** US dollars per million tokens. */
  price?: { input: number; output: number }
  note: string
}

/** The note of a listed model, by its menu value or resolved id. */
export function modelNoteOf(
  notes: readonly ModelNote[] | undefined,
  model: { value: string; modelId?: string },
): ModelNote | null {
  const keys = [model.value, model.modelId]
    .filter((key): key is string => typeof key === 'string')
    .map((key) =>
      key
        .toLowerCase()
        .replace(/\[[^\]]*\]$/, '')
        .replace(/-\d{8}$/, ''),
    )
  return notes?.find((note) => keys.some((key) => note.match.includes(key))) ?? null
}

export interface MovedAccounts {
  refusal: RegExp
  to: HarnessId
  audience: HostKey
  refused: HostKey
}

export function protocolOf(def: AgentDefinition): AgentProtocol {
  return def.protocol ?? 'acp'
}

// Re-exported so a definition is still read from the catalog that lists it.
export {
  AGORAGENTIC,
  AMP,
  ANTIGRAVITY,
  AUGGIE,
  AUTOHAND,
  BOB,
  CLAUDE_CODE,
  CLINE,
  CODEBUDDY,
  CODEWHALE,
  CODEX,
  COPILOT,
  CURSOR,
  CORTEX_CODE,
  CORUST_AGENT,
  CROW_CLI,
  DEEPAGENTS,
  DEEPSEEK,
  DEVIN,
  DIMCODE,
  DIRAC,
  DROID,
  fakeAgent,
  FAST_AGENT,
  GEMINI,
  GLM,
  GOOSE,
  GROK,
  HARN,
  HERMES,
  KILO,
  KIMCHI,
  KIMI,
  MINIMAX,
  MINION,
  MUSE,
  JUNIE,
  MISTRAL_VIBE,
  NOVA,
  OMP,
  OPENCODE,
  PI,
  POOLSIDE,
  QODER,
  QODER_CN,
  QWEN,
  SIGIT,
  STAKPAK,
  VTCODE,
}

/** The catalog; the fake agent exists only when main passes its path. */
export function buildCatalog(fakeAgentPath: string | null): AgentDefinition[] {
  const catalog = [
    CLAUDE_CODE,
    CODEX,
    OPENCODE,
    PI,
    DEEPSEEK,
    AUGGIE,
    CODEBUDDY,
    DEEPAGENTS,
    DIMCODE,
    DIRAC,
    GLM,
    NOVA,
    QODER,
    QODER_CN,
    SIGIT,
    AGORAGENTIC,
    AUTOHAND,
    ANTIGRAVITY,
    GEMINI,
    COPILOT,
    QWEN,
    GROK,
    CLINE,
    DROID,
    BOB,
    MINIMAX,
    CURSOR,
    KIMI,
    AMP,
    GOOSE,
    KILO,
    OMP,
    HERMES,
    MUSE,
    CODEWHALE,
    HARN,
    KIMCHI,
    DEVIN,
    CORTEX_CODE,
    CORUST_AGENT,
    CROW_CLI,
    JUNIE,
    MISTRAL_VIBE,
    POOLSIDE,
    STAKPAK,
    VTCODE,
    FAST_AGENT,
    MINION,
  ]
  if (fakeAgentPath) catalog.push(fakeAgent(fakeAgentPath))
  return catalog
}

/**
 * Each agent's own configuration folder: every added agent's, and the one a default agent was
 * given before agents could be added. Other default agents use their harness's default folder.
 */
export function configFolders(
  catalog: readonly AgentDefinition[],
  settings: Pick<HostSettings, 'agents' | 'addedAgents'>,
): Partial<Record<AgentId, ConfigFolder>> {
  const folders: Partial<Record<AgentId, ConfigFolder>> = {}
  for (const def of catalog) {
    const folder = settings.agents[def.id]?.configDir
    if (def.configVariable && folder)
      folders[def.id] = { variable: def.configVariable, path: folder }
  }
  for (const agent of settings.addedAgents) {
    const def = catalog.find((candidate) => candidate.id === harnessOf(agent.id))
    if (def?.configVariable)
      folders[agent.id] = { variable: def.configVariable, path: agent.configDir }
  }
  return folders
}

/** A command line as words, for display and for building terminal sign-in commands. */
export interface CommandWords {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface LaunchSpec {
  /** An absolute path to the program. */
  command: string
  args: string[]
  /** Variables added for this agent only. */
  env: Record<string, string>
  /** True only for a resolved `.cmd` or `.bat` on Windows. */
  shell: boolean
  display: CommandWords
  /** The user's own CLI this launch passes to the SDK, or runs itself. */
  cli?: string
  /** The version of Kettu's own install it runs: a package, a release archive or a uvx package. */
  version?: string
}

/** Kettu's own files a driver writes for an agent, such as Pi's extension, beside the installs. */
export const EXTENSIONS_FOLDER = '.extensions'

/** Where a package agent's version lives once installed, before detection says more. */
export function packageDir(
  adaptersDir: string,
  def: AgentDefinition,
  version: string,
): string | null {
  const { launch } = def
  if (launch.kind !== 'package') return null
  return path.join(adaptersDir, def.id, version, 'node_modules', launch.package)
}

/** How the launch reads to the user, before or after detection, at the version a start wants. */
export function displayCommand(
  def: AgentDefinition,
  nodeRuntime: NodeRuntime,
  binaryOverride: string | null,
  adaptersDir: string,
  sessionRouterPath: string | null = null,
  version: string | null = null,
): CommandWords {
  switch (def.launch.kind) {
    case 'package': {
      const entry = version ? (packageDir(adaptersDir, def, version) ?? '') : def.launch.package
      if (def.launch.library)
        return { command: entry, args: [], env: { ...def.env, ...def.launch.env } }
      // A per-session agent reads as the router's own command line.
      const prefix = def.launch.perSession && sessionRouterPath ? [sessionRouterPath, 'node'] : []
      const args = [...prefix, entry, ...(def.launch.args ?? [])]
      return { command: 'node', args, env: { ...def.env, ...def.launch.env } }
    }
    case 'binary':
      return {
        command: binaryOverride ?? def.launch.command,
        args: def.launch.args,
        env: { ...def.env },
      }
    case 'uvx':
      return {
        command: 'uvx',
        args: [
          version ? `${def.launch.package}==${version}` : def.launch.package,
          ...def.launch.args,
        ],
        env: { ...def.env },
      }
    case 'node-script':
      return {
        command: nodeRuntime.command,
        args: [def.launch.script],
        env: { ...nodeRuntime.env },
      }
  }
}

/** What a package agent has installed, and what it needs to install the version it wants. */
export interface AdapterPlan {
  package: string
  /** The version a start wants (see `VersionChoice`); the first start installs it. */
  version: string
  /** Whether an install a start runs exists. */
  installed: boolean
  /**
   * The install a start runs: the wanted version, else the one that ran before or the newest;
   * for a vendor's package, the newest from the bundled version up.
   */
  current: InstalledAdapter | null
  /** Null only for an agent whose package is its CLI, which needs Node.js just to install. */
  node: string | null
  nodeVersion: string | null
  npm: string | null
  /**
   * For a vendor's own package, the newest install below its floor, which runs when the floor
   * cannot be installed.
   */
  fallback: { version: string; dir: string; spec: LaunchSpec } | null
}

export type Detection =
  // `spec` is null for a package agent until its pinned version, or a newer one, is installed.
  | {
      state: 'available'
      spec: LaunchSpec | null
      adapter: AdapterPlan | null
      /** The user's CLI that runs, for a harness with a `cli`. */
      cli?: InstalledCli
      /**
       * Kettu's own install of a registry release that a start runs: a release archive and its
       * folder, or a uvx package's version, which uv keeps. Absent when the user's program runs.
       */
      release?: { version: string; dir: string | null }
    }
  | {
      state: 'not-installed' | 'node-missing' | 'node-outdated'
      detail: string
      /** The user's CLI when one was found that cannot run, such as one too old. */
      cli?: InstalledCli
    }

/**
 * Whether detection found the user's own program: their CLI, or a binary outside `kettuDir`, where
 * Kettu keeps the programs it installs. One that is found but cannot run, such as a CLI too old,
 * counts.
 */
export function userProgramFound(
  def: AgentDefinition,
  detection: Detection,
  kettuDir: string,
): boolean {
  if (detection.cli) return true
  if (detection.state !== 'available') return false
  const command = def.launch.kind === 'binary' ? detection.spec?.command : undefined
  if (!command) return false
  const relative = path.relative(kettuDir, command)
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative)
}

/** `node <entry>`, or `node <router> node <entry>` for a per-session agent. */
export function packageSpec(
  node: string,
  entry: string,
  platform: Platform,
  env: Record<string, string> = {},
  prefix: string[] = [],
  args: string[] = [],
): LaunchSpec {
  const words = [...prefix, entry, ...args]
  return {
    command: node,
    args: words,
    env,
    shell: needsShell(node, platform),
    display: { command: node, args: words, env },
  }
}

/** A library's entry module, which its driver loads instead of a process running it. */
export function librarySpec(entry: string, env: Record<string, string>): LaunchSpec {
  return { command: entry, args: [], env, shell: false, display: { command: entry, args: [], env } }
}

/** `node <entry>` for an installed adapter. */
export async function installedSpec(
  def: AgentDefinition,
  /** The user's Node.js, which only a library runs without. */
  node: string | null,
  installed: InstalledAdapter,
  lookup: Omit<AdapterLookup, 'dir' | 'entry'>,
  extraEnv: Record<string, string> = {},
  sessionRouterPath: string | null = null,
): Promise<LaunchSpec> {
  const launch = def.launch
  const env = {
    ...def.env,
    ...(launch.kind === 'package' ? launch.env : {}),
    ...extraEnv,
  }
  if (launch.kind === 'package' && launch.library) return librarySpec(installed.entry, env)
  if (node === null) throw new Error(`${def.name} runs on Node.js, which was not found`)
  const prefix =
    launch.kind === 'package' && launch.perSession && sessionRouterPath
      ? [sessionRouterPath, node]
      : []
  return packageSpec(
    node,
    installed.entry,
    lookup.platform,
    env,
    prefix,
    launch.kind === 'package' ? (launch.args ?? []) : [],
  )
}

export interface DetectContext {
  platform: Platform
  env: Env
  nodeRuntime: NodeRuntime
  binaryOverride: string | null
  node: NodeProbe
  /** `<userData>/agents`, where package agents and release archives are installed. */
  adaptersDir: string
  /** Which version of Kettu's own install a start runs; null for a harness Kettu never installs. */
  versions: VersionChoice | null
  /** The session router every per-session agent launches through; null in a test without one. */
  sessionRouterPath?: string | null
  isExecutable(file: string): Promise<boolean>
  isFile?(file: string): Promise<boolean>
  realpath?(file: string): Promise<string>
  installed?(agentId: AgentId, packageName: string): Promise<InstalledAdapter[]>
  /** The release archives Kettu has installed; read from disk when not given. */
  installedArchives?(agentId: AgentId): Promise<InstalledArchive[]>
  /** The uvx version an update recorded; read from disk when not given. */
  uvxVersion?(agentId: AgentId): Promise<string | null>
  /** Asks a CLI its version; without it, no installed CLI is looked for. */
  probeCli?: CliProbe
  cliFiles?: CliFiles
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * A binary agent whose program was found, from PATH, the chosen binary or Kettu's install, which
 * names its `version`.
 */
function binaryDetection(
  command: string,
  args: string[],
  platform: Platform,
  display: CommandWords,
  env: Record<string, string>,
  version?: string,
): Extract<Detection, { state: 'available' }> {
  return {
    state: 'available',
    spec: {
      command,
      args,
      env,
      shell: needsShell(command, platform),
      display: { ...display, env },
      ...(version ? { version } : {}),
    },
    adapter: null,
  }
}

/**
 * A per-session binary agent, run as `<node> <router> --folder-per-session <program> <args>`: the
 * router runs on the node runtime and starts each session's program in the session's folder.
 */
function routedDetection(
  program: string,
  launch: Extract<LaunchKind, { kind: 'binary' }>,
  ctx: Pick<DetectContext, 'nodeRuntime' | 'sessionRouterPath'>,
  display: CommandWords,
  env: Record<string, string>,
): Detection {
  const runtime = ctx.nodeRuntime
  const flag = launch.sessionFlag ? [`${SESSION_FLAG}${launch.sessionFlag}`] : []
  return {
    state: 'available',
    spec: {
      command: runtime.command,
      args: [ctx.sessionRouterPath!, FOLDER_PER_SESSION, ...flag, program, ...launch.args],
      env: { ...runtime.env, ...env },
      shell: false,
      display: { ...display, env },
    },
    adapter: null,
  }
}

type PackageLaunch = Extract<LaunchKind, { kind: 'package' }>

/** The installs of a package agent a start may run, the first it runs, and one below a floor. */
async function packageInstalls(
  def: AgentDefinition,
  launch: PackageLaunch,
  choice: VersionChoice,
  ctx: DetectContext,
): Promise<{ atPin: InstalledAdapter[]; other: InstalledAdapter | null }> {
  const installed = await (
    ctx.installed ?? ((id, name) => listInstalled(ctx.adaptersDir, id, name))
  )(def.id, launch.package)
  const { runs, below } = orderInstalls(installed, choice)
  return { atPin: runs, other: below }
}

/**
 * The install a start runs and the CLI version it needs. An SDK pins its CLI, so it is the newest
 * install the user's CLI fits; when none does, the pin installs on the first start, and only a
 * pinned install the CLI does not fit either makes the CLI too old.
 */
async function installForCli(
  cli: AdapterCli,
  launch: PackageLaunch,
  wanted: string,
  installs: { atPin: InstalledAdapter[]; other: InstalledAdapter | null },
  found: InstalledCli,
  files: CliFiles,
): Promise<{ current: InstalledAdapter | null; minimum: string | null | undefined }> {
  const minimumOf = async (install: InstalledAdapter) =>
    (await cli.minimum?.(install.dir, launch.package, files)) ?? null
  const [newest] = installs.atPin
  // Until the pinned version is installed, the older install a start falls back to says it.
  if (!newest) {
    return { current: null, minimum: installs.other ? await minimumOf(installs.other) : undefined }
  }
  // A program the environment names runs whatever its version.
  if (!cli.pinsVersion || !found.version || found.variable) {
    return { current: newest, minimum: await minimumOf(newest) }
  }
  for (const install of installs.atPin) {
    const minimum = await minimumOf(install)
    if (minimum === null || compareVersions(found.version, minimum) >= 0) {
      return { current: install, minimum }
    }
  }
  const pinned = installs.atPin.find((install) => install.version === wanted)
  return { current: null, minimum: pinned ? await minimumOf(pinned) : undefined }
}

/** Why the user's CLI cannot run, in the user's terms, or null when it can. */
function cliDetail(def: AgentDefinition, cli: AdapterCli, installed: InstalledCli): string | null {
  const problem = installed.problem
  if (!problem) return null
  const agent = def.name
  switch (problem.kind) {
    case 'unsupported':
      return t('detect.cliUnsupported', { agent, path: installed.path })
    case 'failed':
      return t('detect.cliFailed', { agent, reason: problem.reason })
    case 'too-old':
      return t('detect.cliOutdated', {
        agent,
        command: cli.command,
        required: problem.minimum,
        installed: installed.version ?? '?',
      })
  }
}

/** The user's CLI as found, or the detection that says it is missing. */
async function findUserCli(
  def: AgentDefinition,
  cli: AdapterCli,
  ctx: DetectContext,
): Promise<{ found: FoundCli } | { missing: Detection }> {
  const files = ctx.cliFiles ?? CLI_FILES
  const found = ctx.probeCli
    ? await findInstalledCli(cli, { ...ctx, files, probe: ctx.probeCli })
    : null
  if (!found) {
    return {
      missing: {
        state: 'not-installed',
        detail: t('detect.cliMissing', { agent: def.name, command: cli.command }),
      },
    }
  }
  return { found }
}

/** The user's CLI, or the detection that says it is missing or cannot run. */
async function userCli(
  def: AgentDefinition,
  cli: AdapterCli,
  ctx: DetectContext,
  minimum: string | null | undefined,
): Promise<{ found: FoundCli } | { missing: Detection }> {
  const result = await findUserCli(def, cli, ctx)
  return 'missing' in result ? result : checkUserCli(def, cli, result.found, minimum)
}

/** The CLI found, or the detection that says it cannot run, such as one below `minimum`. */
function checkUserCli(
  def: AgentDefinition,
  cli: AdapterCli,
  found: FoundCli,
  minimum: string | null | undefined,
): { found: FoundCli } | { missing: Detection } {
  const installed = checkCli(found.installed, minimum)
  const detail = cliDetail(def, cli, installed)
  // A program the environment names is the user's choice, and runs whatever its version.
  if (detail && !installed.variable) {
    return { missing: { state: 'not-installed', detail, cli: installed } }
  }
  return { found: { ...found, installed } }
}

/** Finds what an agent needs without starting it, so it can run at startup and on demand. */
export async function detectAgent(def: AgentDefinition, ctx: DetectContext): Promise<Detection> {
  const choice = ctx.versions
  const display = displayCommand(
    def,
    ctx.nodeRuntime,
    ctx.binaryOverride,
    ctx.adaptersDir,
    ctx.sessionRouterPath ?? null,
    choice?.wanted ?? null,
  )
  const launch = def.launch
  switch (launch.kind) {
    case 'package': {
      const { nodePath, nodeVersion, npmPath } = ctx.node
      const { library } = launch
      if (!choice)
        return { state: 'not-installed', detail: t('detect.noVersion', { agent: def.name }) }
      const installs = await packageInstalls(def, launch, choice, ctx)
      const { other } = installs
      let current: InstalledAdapter | null = installs.atPin[0] ?? null
      const files = ctx.cliFiles ?? CLI_FILES
      // Only the user's own CLI runs: one missing or too old is said before anything installs.
      let cli: FoundCli | null = null
      if (def.cli) {
        const found = await findUserCli(def, def.cli, ctx)
        if ('missing' in found) return found.missing
        const runs = await installForCli(
          def.cli,
          launch,
          choice.wanted,
          installs,
          found.found.installed,
          files,
        )
        current = runs.current
        const result = checkUserCli(def, def.cli, found.found, runs.minimum)
        if ('missing' in result) return result.missing
        cli = result.found
      }
      // A library runs in the host, so the user's Node.js only runs npm, to install it.
      if (!library && (!nodePath || !nodeVersion)) {
        return {
          state: 'node-missing',
          detail: t('detect.nodeMissing', { agent: def.name }),
        }
      }
      if (
        !library &&
        nodeVersion &&
        def.requiresNode &&
        !satisfiesNode(nodeVersion, def.requiresNode)
      ) {
        return {
          state: 'node-outdated',
          detail: t('detect.nodeOutdated', {
            agent: def.name,
            required: def.requiresNode.replace('>=', ''),
            installed: nodeVersion,
          }),
        }
      }
      if (!current && !other && (!nodePath || !nodeVersion)) {
        return {
          state: 'node-missing',
          detail: t('detect.nodeToInstall', { agent: def.name }),
        }
      }
      if (!current && !npmPath && !other) {
        return {
          state: 'not-installed',
          detail: t('detect.npmMissing', { agent: def.name, hint: t(def.install.hint) }),
        }
      }
      // A per-session agent runs only through the router, which every packaged build carries.
      if (launch.perSession && !ctx.sessionRouterPath) {
        return { state: 'not-installed', detail: 'The session router is missing from this build.' }
      }
      const prefix =
        launch.perSession && ctx.sessionRouterPath && nodePath
          ? [ctx.sessionRouterPath, nodePath]
          : []
      const lookup = {
        platform: ctx.platform,
        env: ctx.env,
        ...(ctx.isFile ? { isFile: ctx.isFile } : {}),
        ...(ctx.realpath ? { realpath: ctx.realpath } : {}),
      }
      // A program the environment names reaches the adapter by itself.
      const passed = cli && !cli.installed.variable ? cli : null
      const specFor = async (install: InstalledAdapter): Promise<LaunchSpec | null> => {
        const spec = await launchFor(install)
        return spec && { ...spec, version: install.version }
      }
      const launchFor = async (install: InstalledAdapter): Promise<LaunchSpec | null> => {
        if (passed && def.cli) {
          const env = {
            ...def.env,
            ...(launch.kind === 'package' ? launch.env : {}),
            ...passed.env,
            ...(def.cli.variable ? { [def.cli.variable]: passed.installed.path } : {}),
          }
          if (launch.library) {
            return { ...librarySpec(install.entry, env), cli: passed.installed.path }
          }
          if (!nodePath) return null
          return {
            ...packageSpec(
              nodePath,
              install.entry,
              ctx.platform,
              env,
              prefix,
              launch.kind === 'package' ? (launch.args ?? []) : [],
            ),
            cli: passed.installed.path,
          }
        }
        return installedSpec(def, nodePath, install, lookup, {}, ctx.sessionRouterPath ?? null)
      }
      const spec = current ? await specFor(current) : null
      const fallbackSpec = other ? await specFor(other) : null
      return {
        state: 'available',
        spec,
        adapter: {
          package: launch.package,
          version: choice.wanted,
          installed: !!current,
          current: current ?? null,
          node: nodePath,
          nodeVersion,
          npm: npmPath,
          fallback:
            other && fallbackSpec
              ? { version: other.version, dir: other.dir, spec: fallbackSpec }
              : null,
        },
        ...(cli ? { cli: cli.installed } : {}),
      }
    }
    case 'binary': {
      const env = { ...def.env }
      // A harness that runs the user's CLI itself, such as Codex, finds it as the SDK would.
      if (def.cli && !ctx.binaryOverride) {
        const result = await userCli(def, def.cli, ctx, def.cli.oldest ?? null)
        if ('missing' in result) return result.missing
        const { installed, env: cliEnv } = result.found
        const program = installed.path
        const runEnv = { ...env, ...cliEnv }
        if (launch.perSession && ctx.sessionRouterPath) {
          return {
            ...routedDetection(program, launch, ctx, display, runEnv),
            cli: installed,
          }
        }
        return {
          ...binaryDetection(program, launch.args, ctx.platform, display, runEnv),
          cli: installed,
        }
      }
      if (ctx.binaryOverride) {
        if (!(await ctx.isExecutable(ctx.binaryOverride))) {
          return {
            state: 'not-installed',
            detail: t('detect.programUnusable', { agent: def.name, path: ctx.binaryOverride }),
          }
        }
        return binaryDetection(ctx.binaryOverride, launch.args, ctx.platform, display, env)
      }
      const program = await findCommand(launch.command, ctx)
      if (program) return binaryDetection(program, launch.args, ctx.platform, display, env)
      // The user's own copy wins, so their sign-in and configuration stay; without one,
      // Kettu's archive install runs: the version wanted, else the one that ran before.
      if (def.installs?.archive && choice) {
        const installs = await (
          ctx.installedArchives ?? ((id) => listArchiveInstalls(ctx.adaptersDir, id))
        )(def.id)
        for (const installed of orderInstalls(installs, choice).runs) {
          try {
            const command = programPath(installed.dir, installed.cmd, ctx.platform)
            if (!(await ctx.isExecutable(command))) continue
            const display = { command, args: installed.args, env }
            const { version, dir } = installed
            return {
              ...binaryDetection(command, installed.args, ctx.platform, display, env, version),
              release: { version, dir },
            }
          } catch {
            // A record whose command leaves the install folder is no install.
          }
        }
      }
      return {
        state: 'not-installed',
        detail: t('detect.commandMissing', { command: launch.command, hint: t(def.install.hint) }),
      }
    }
    case 'uvx': {
      const program = await findCommand('uvx', ctx)
      if (!program) {
        return {
          state: 'not-installed',
          detail: t('detect.commandMissing', { command: 'uvx', hint: t(def.install.hint) }),
        }
      }
      if (!choice)
        return { state: 'not-installed', detail: t('detect.noVersion', { agent: def.name }) }
      // uv keeps what it fetched, so the version recorded runs, else the one that ran before;
      // with neither, the wanted one, which uvx fetches as it starts.
      const fetched = await (ctx.uvxVersion ?? ((id) => readUvxVersion(ctx.adaptersDir, id)))(
        def.id,
      )
      const known = [fetched, choice.ran].flatMap((v, at) =>
        v ? [{ version: v, installedAt: -at }] : [],
      )
      const version = orderInstalls(known, choice).runs[0]?.version ?? choice.wanted
      const args = [`${launch.package}==${version}`, ...launch.args]
      return {
        state: 'available',
        spec: {
          command: program,
          args,
          env: { ...def.env },
          shell: needsShell(program, ctx.platform),
          display: { ...display, args },
          version,
        },
        adapter: null,
        release: { version, dir: null },
      }
    }
    case 'node-script': {
      if (!(await (ctx.isFile ?? isFile)(launch.script))) {
        return {
          state: 'not-installed',
          detail: t('detect.scriptMissing', { script: launch.script }),
        }
      }
      return {
        state: 'available',
        spec: {
          command: ctx.nodeRuntime.command,
          args: [launch.script],
          env: { ...ctx.nodeRuntime.env },
          shell: false,
          display,
        },
        adapter: null,
      }
    }
  }
}
