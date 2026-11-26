// Google Antigravity（agy）Auto 模式的统一权限风险评估引擎与本会话授权记忆。
//
// 当会话处于 Auto 模式时，agy 底层保持 default 模式，所有写文件、命令执行、工作区外读写、
// 网页访问与 MCP 工具调用均经此引擎判定：
// - 日常研发可逆操作与只读查询自动放行（0ms，不打断用户）；
// - 敏感、高危与不可逆操作（删除文件/核心文件、修改 .env/凭据/.git/系统文件、
//   工作区外非临时目录写入、提权/强推/reset --hard/gh pr merge、破坏性 MCP 等）拦截并交由用户审批；
// - 用户在 agy 自己的 settings.json 中显式配置的 permissions.ask 规则始终优先，不被自动放行覆盖；
// - 针对 agy ACP 只返回 allow_once / reject_once 的限制，为非高危拦截补齐「本会话总是允许」选项。

import { stat, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { Platform } from '@shared/platform'
import type { PermissionOption } from '@shared/thread'
import type { Shell } from '../command-safety'
import { GUIDE_TOOL } from '../guide/guide'
import { t } from '../i18n'
import { SERVICE_NAME } from '../service-name'
import { GATEWAY_TOOL } from '../tool-gateway'
import type { AgyAutoAllow } from './agy-tools'

/** 权限卡片风险等级：与前端 affectUI PermissionRequest 三档风险一致。 */
export type AgyRiskLevel = 'safe' | 'risky' | 'destructive'

/** 可供用户勾选的「本会话总是允许」授权范围（仅限非高危操作）。 */
export type AgySessionGrantScope =
  | { kind: 'mcp_tool'; tool: string; label: string }
  | { kind: 'write_dir'; dir: string; displayDir: string }
  | { kind: 'command_prefix'; prefix: readonly string[]; display: string }

/** Kettu 合成的「本会话总是允许」选项 ID（回传给 agy 时会映射回原 allow_once 选项）。 */
export const SESSION_ALLOW_OPTION_ID = 'kettu:allow-session'

/** Auto 权限引擎的单次判定结果。 */
export type AgyAutoDecision =
  | { action: 'allow'; source: 'always' | 'auto' | 'session_grant' }
  | {
      action: 'ask'
      risk: AgyRiskLevel
      /** 面向用户的拦截原因说明（显示在审批卡片上）。 */
      reason?: string
      /** 非高危请求附带的本会话允许范围；高危或删除类操作为 null。 */
      sessionGrant: AgySessionGrantScope | null
    }

/** 外部 MCP 工具的运行时元数据注解（来自 MCP tools/list）。 */
export interface McpToolHints {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

/** 评估单次 agy 权限请求所需的上下文。 */
export interface AgyEvalContext {
  readonly cwd: string | null
  readonly autoMode: boolean
  readonly allowed: AgyAutoAllow | undefined
  readonly sessionGrants?: AgySessionGrants
  /** agy 自身 settings.json 中用户显式配置的 permissions.ask 规则列表。 */
  readonly userAskRules?: readonly AgyAskRule[]
  /** 外部 MCP 工具注解查询表（键为 agy 工具名 `mcp_<server>_<tool>`）。 */
  readonly mcpHints?: ReadonlyMap<string, McpToolHints>
  readonly platform?: Platform
  readonly shell?: Shell
  readonly homeDir?: string
  readonly tempDirs?: readonly string[]
  readonly agentHome?: string
  /** Non-default agy app_data_dir (e.g. 'antigravity' for imported IDE sessions). */
  readonly agyAppDataDir?: string
}

const OWN_PREFIX = `mcp_${SERVICE_NAME}_`
const GATEWAY_NAME = `${OWN_PREFIX}${GATEWAY_TOOL}`
const TERMINAL_RUN_NAME = `${OWN_PREFIX}terminal_run`
const TERMINAL_INPUT_NAME = `${OWN_PREFIX}terminal_input`
const DELETE_ARTIFACT_NAME = `${OWN_PREFIX}delete_artifact`
const WRITE_ARTIFACT_DATA_NAME = `${OWN_PREFIX}write_artifact_data`
const COMPUTER_PREFIX = `${OWN_PREFIX}computer_`

const READ_TOOLS = new Set(['read_file', 'view_file', 'list_dir', 'find_by_name', 'grep_search'])
const WRITE_TOOLS = new Set([
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
])
const DELETE_TOOLS = new Set(['delete_file', 'remove_file'])
const WEB_READ_TOOLS = new Set(['search_web', 'read_url', 'read_url_content'])
const COMMAND_TOOLS = new Set(['run_command'])

/** 无论读写均受保护的高敏感目录段（出现在路径任意层级即视为敏感）。 */
const SENSITIVE_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube'])

/** 受保护的凭据/私钥文件名（小写匹配）。 */
const SENSITIVE_FILENAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'authstore.enc',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials',
])

/** 受保护的私钥/证书扩展名。 */
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'])

/** 允许放行的环境变量模板文件名（小写匹配）。 */
const SAFE_ENV_TEMPLATE =
  /^\.env\.(?:example|sample|template|dist|schema|defaults|placeholder|local\.example)$/i

/** 写入时额外保护的全局配置文件名（位于用户主目录下）。 */
const SENSITIVE_HOME_FILES = new Set([
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.gitconfig',
  '.bash_history',
  '.zsh_history',
])

/** 写入时保护的系统根目录前缀（POSIX 与 Windows）。 */
const SYSTEM_WRITE_ROOTS_POSIX = ['/etc', '/system', '/library', '/usr', '/bin', '/sbin', '/boot']
const SYSTEM_WRITE_ROOTS_WIN = ['c:/windows', 'c:/program files', 'c:/program files (x86)']

/** 删除/移走时视为「核心文件或目录」的项目关键路径名（小写匹配）。 */
const CORE_PROJECT_NAMES = new Set([
  '.git',
  '.github',
  '.gitignore',
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'requirements.txt',
  'gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'tsconfig.json',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'makefile',
  'cmakelists.txt',
  'readme.md',
  'claude.md',
  'agents.md',
  'src',
  'app',
  'lib',
  'packages',
  'apps',
  'server',
  'client',
  'config',
  'docs',
])

/** 删除类命令名（一律拦截并标为 destructive）。 */
const DELETE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'trash',
  'rimraf',
  'del',
  'erase',
  'rd',
  'remove-item',
  'ri',
  'remove-itemproperty',
  'rp',
  'clear-content',
  'clc',
  'clear-item',
  'cli',
  'truncate',
])

/** 提权、磁盘格式化与系统关机类命令（一律 destructive）。 */
const PRIVILEGED_OR_SYSTEM_COMMANDS = new Set([
  'sudo',
  'su',
  'doas',
  'gsudo',
  'run0',
  'pkexec',
  'runas',
  'dd',
  'mkfs',
  'newfs',
  'format',
  'format-volume',
  'clear-disk',
  'remove-partition',
  'wipefs',
  'fdisk',
  'sfdisk',
  'parted',
  'diskutil',
  'diskpart',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'stop-computer',
  'restart-computer',
])

/** 权限属主修改与强杀进程命令（一律拦截）。 */
const SYSTEM_MUTATION_COMMANDS = new Set([
  'chmod',
  'chown',
  'chgrp',
  'chattr',
  'chflags',
  'setfacl',
  'icacls',
  'takeown',
  'kill',
  'killall',
  'pkill',
  'taskkill',
  'stop-process',
  'spps',
])

/** 不可判定或不透明执行命令（保守拦截）。 */
const OPAQUE_COMMANDS = new Set([
  'eval',
  'exec',
  'source',
  '.',
  'ssh',
  'scp',
  'sftp',
  'osascript',
  'crontab',
  'at',
  'chroot',
  'nsenter',
  'unshare',
  'invoke-expression',
  'iex',
  'invoke-command',
  'icm',
])

/** 透明包装器命令：解包后递归评估内层命令。 */
const WRAPPERS = new Set([
  'env',
  'command',
  'builtin',
  'nohup',
  'nice',
  'time',
  'timeout',
  'caffeinate',
  'stdbuf',
  'noglob',
  'nocorrect',
  'xargs',
])

const SHELL_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'pwsh',
  'powershell',
])
const SCRIPT_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'tsx',
  'ts-node',
  'bun',
  'deno',
  'perl',
  'ruby',
  'php',
])
const PYTHON_CMD = /^(?:python|pypy)[\d.]*$|^py$/

/** 仅允许在命令前缀中直接传递的无害环境变量名（PATH / LD_PRELOAD 等仍视为风险）。 */
const SAFE_ENV_VAR =
  /^(?:CI|NODE_ENV|DEBUG|PORT|HOST|TZ|LANG|LANGUAGE|LC_[A-Z0-9_]+|TERM|COLUMNS|LINES|FORCE_COLOR|NO_COLOR|CLICOLOR(?:_FORCE)?|VERBOSE|LOG_LEVEL|RUST_LOG|RUST_BACKTRACE|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|NODE_NO_WARNINGS|GOOS|GOARCH|CGO_ENABLED|ELECTRON_RUN_AS_NODE|KETTU_[A-Z0-9_]+|(?:VITE|NEXT_PUBLIC|REACT_APP|PUBLIC)_[A-Z0-9_]+)$/

/** 第三方 MCP 极高危破坏/不可逆词元（命中即标 destructive 且不提供本会话允许）。 */
const MCP_DESTRUCTIVE_TOKENS = new Set([
  'delete',
  'remove',
  'rm',
  'drop',
  'purge',
  'destroy',
  'wipe',
  'truncate',
  'erase',
  'shred',
  'uninstall',
  'kill',
  'terminate',
  'revoke',
  'reset',
  'force',
  'merge',
  'push',
  'publish',
  'unlist',
  'deploy',
])

/** 第三方 MCP 敏感外发/权限变更词元（命中标 risky，允许按单个工具勾选本会话允许）。 */
const MCP_SENSITIVE_TOKENS = new Set([
  'close',
  'archive',
  'retire',
  'share',
  'unshare',
  'transfer',
  'pay',
  'charge',
  'billing',
  'send',
  'email',
  'mail',
  'sms',
  'invite',
  'ban',
  'kick',
  'approve',
  'reject',
  'submit',
  'exec',
  'execute',
  'eval',
  'run',
  'mutate',
  'mutation',
])

/** 第三方 MCP 只读词元。 */
const MCP_READONLY_TOKENS = new Set([
  'get',
  'list',
  'read',
  'search',
  'find',
  'query',
  'lookup',
  'fetch',
  'show',
  'view',
  'describe',
  'inspect',
  'check',
  'verify',
  'validate',
  'count',
  'stats',
  'status',
  'whoami',
  'me',
  'info',
  'ping',
  'health',
  'extract',
  'preview',
  'diff',
  'log',
  'logs',
  'history',
  'timeline',
  'suggest',
  'ui',
])

/** 第三方 MCP 可逆研发协作动作词元（需同时不含任何破坏或敏感词元）。 */
const MCP_REVERSIBLE_TOKENS = new Set([
  'create',
  'add',
  'update',
  'save',
  'edit',
  'set',
  'mark',
  'resolve',
  'restore',
  'request',
  'fork',
  'reply',
  'comment',
  'label',
  'assign',
  'unassign',
  'reopen',
])

const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
])

/** 文件读取类命令：需额外校验其文件参数是否命中敏感凭据路径。 */
const FILE_READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'base64',
  'xxd',
  'hexdump',
  'od',
  'strings',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'sed',
  'jq',
  'yq',
  'diff',
  'cmp',
  'cp',
  'mv',
  'tar',
  'zip',
  'scp',
  'rsync',
])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function toolName(update: acp.ToolCallUpdate): string | null {
  const name = (update as { name?: unknown }).name
  return typeof name === 'string' ? name : null
}

function describesOnly(toolCall: acp.ToolCallUpdate): boolean {
  if (toolName(toolCall) !== GATEWAY_NAME) return false
  const input = record(toolCall.rawInput)
  return typeof input?.tool === 'string' && input.arguments === undefined
}

/** 规范化路径以便跨平台对比（统一正斜杠、展开 ~、在 macOS 上折叠 /private 前缀）。 */
export function normalizePath(
  rawPath: string,
  cwd: string | null,
  platform: Platform = process.platform as Platform,
  homeDir: string = os.homedir(),
): string {
  let target = rawPath.trim()
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    target = homeDir + target.slice(1)
  }
  const p = platform === 'win32' ? path.win32 : path.posix
  const isAbs = platform === 'win32' ? /^[A-Za-z]:[/\\]|^\\\\/.test(target) : target.startsWith('/')
  let resolved = isAbs ? p.normalize(target) : cwd ? p.resolve(cwd, target) : p.normalize(target)
  resolved = resolved.replace(/\\/g, '/')
  // 去掉尾部多余斜杠（根目录 `/` 或 `C:/` 除外）。
  if (resolved.length > 1 && resolved.endsWith('/') && !/^[A-Za-z]:\/$/.test(resolved)) {
    resolved = resolved.replace(/\/+$/, '')
  }
  if (platform === 'darwin') {
    if (
      resolved === '/private/tmp' ||
      resolved.startsWith('/private/tmp/') ||
      resolved === '/private/var' ||
      resolved.startsWith('/private/var/') ||
      resolved === '/private/etc' ||
      resolved.startsWith('/private/etc/')
    ) {
      resolved = resolved.slice('/private'.length)
    }
  }
  return resolved
}

/** 生成用于前缀比较的规范键（macOS 与 Windows 不区分大小写）。 */
function compareKey(normalized: string, platform: Platform): string {
  return platform === 'linux' ? normalized : normalized.toLowerCase()
}

function isInsideDir(normalizedPath: string, normalizedDir: string, platform: Platform): boolean {
  const target = compareKey(normalizedPath, platform)
  const dir = compareKey(normalizedDir, platform)
  if (target === dir) return true
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  return target.startsWith(prefix)
}

function pathSegments(normalized: string): string[] {
  return normalized.split('/').filter(Boolean)
}

function baseName(normalized: string): string {
  const segs = pathSegments(normalized)
  return segs.at(-1) ?? ''
}

function isEnvFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === '.env') return true
  if (!lower.startsWith('.env.')) return false
  return !SAFE_ENV_TEMPLATE.test(lower)
}

/** 判断路径是否属于高敏感凭据/私钥路径（读操作也须拦截）。 */
export function isSensitiveReadPath(
  rawPath: string,
  cwd: string | null,
  platform: Platform = process.platform as Platform,
  homeDir: string = os.homedir(),
): boolean {
  const norm = normalizePath(rawPath, cwd, platform, homeDir)
  const lower = norm.toLowerCase()
  const segs = pathSegments(lower)
  const name = segs.at(-1) ?? ''

  if (segs.some((seg) => SENSITIVE_DIR_SEGMENTS.has(seg))) return true
  if (lower.includes('/.config/gcloud/') || lower.endsWith('/.config/gcloud')) return true
  if (lower.includes('/library/keychains/') || lower.endsWith('/library/keychains')) return true
  if (lower.includes('/.docker/config.json')) return true
  if (lower === '/etc/shadow' || lower === '/etc/master.passwd') return true
  if (SENSITIVE_FILENAMES.has(name)) return true
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (name.endsWith(ext)) return true
  }
  // 浏览器 Cookie 与凭据库。
  if (
    /(?:chrome|edge|brave|arc|safari|firefox|chromium)/i.test(lower) &&
    /(?:cookies|login data|web data|local state|key4\.db|logins\.json)$/i.test(name)
  ) {
    return true
  }
  // Agent 全局认证文件。
  if (name === 'auth.json' && /(?:^|\/)\.(?:codex|claude|gemini|config)\//.test(lower)) {
    return true
  }
  // 工作区外的 .env 文件读取必拦。
  if (isEnvFile(name)) {
    const normCwd = cwd ? normalizePath(cwd, null, platform, homeDir) : null
    if (!normCwd || !isInsideDir(norm, normCwd, platform)) return true
  }
  return false
}

/** 判断路径是否属于受保护的敏感写入目标（无论是否在工作区内均须拦截）。 */
export function isSensitiveWritePath(
  rawPath: string,
  cwd: string | null,
  platform: Platform = process.platform as Platform,
  homeDir: string = os.homedir(),
): { sensitive: boolean; label: string } {
  const norm = normalizePath(rawPath, cwd, platform, homeDir)
  const lower = norm.toLowerCase()
  const segs = pathSegments(lower)
  const name = baseName(norm)
  const lowerName = name.toLowerCase()

  if (isEnvFile(lowerName)) return { sensitive: true, label: name }
  if (segs.includes('.git')) return { sensitive: true, label: '.git' }
  if (isSensitiveReadPath(rawPath, cwd, platform, homeDir)) {
    return { sensitive: true, label: name || norm }
  }

  // 用户主目录根层的 shell / git / agent 配置文件。
  const normHome = normalizePath(homeDir, null, platform, homeDir)
  if (isInsideDir(norm, normHome, platform)) {
    const rel = compareKey(norm, platform).slice(compareKey(normHome, platform).length + 1)
    if (SENSITIVE_HOME_FILES.has(rel)) return { sensitive: true, label: `~/${name}` }
    if (
      rel === '.gemini/antigravity-cli/settings.json' ||
      rel === '.gemini/config/hooks.json' ||
      rel === '.claude/settings.json' ||
      rel === '.codex/config.toml'
    ) {
      return { sensitive: true, label: `~/${rel}` }
    }
  }

  // 系统目录保护。
  const roots = platform === 'win32' ? SYSTEM_WRITE_ROOTS_WIN : SYSTEM_WRITE_ROOTS_POSIX
  for (const root of roots) {
    if (lower === root || lower.startsWith(`${root}/`)) {
      return { sensitive: true, label: norm }
    }
  }
  return { sensitive: false, label: name || norm }
}

/** 判断目标路径是否为项目核心文件或关键目录（用于删除/移走操作的精准高危提示）。 */
export function isCoreProjectPath(
  rawPath: string,
  cwd: string | null,
  platform: Platform = process.platform as Platform,
  homeDir: string = os.homedir(),
): boolean {
  const norm = normalizePath(rawPath, cwd, platform, homeDir)
  const lower = norm.toLowerCase()
  const normHome = normalizePath(homeDir, null, platform, homeDir)
  const normCwd = cwd ? normalizePath(cwd, null, platform, homeDir) : null

  if (
    norm === '/' ||
    /^[A-Za-z]:\/?$/.test(norm) ||
    compareKey(norm, platform) === compareKey(normHome, platform) ||
    (normCwd !== null && compareKey(norm, platform) === compareKey(normCwd, platform))
  ) {
    return true
  }
  if (
    lower === '/applications' ||
    lower.startsWith('/applications/') ||
    lower === '/users' ||
    lower === '/system' ||
    lower.startsWith('/system/') ||
    lower === '/etc' ||
    lower.startsWith('/etc/')
  ) {
    return true
  }
  const name = baseName(norm).toLowerCase()
  if (isEnvFile(name) || CORE_PROJECT_NAMES.has(name)) return true
  if (pathSegments(lower).includes('.git')) return true
  return false
}

/** 判断路径是否落在系统临时目录内。 */
export function isInTempDir(
  rawPath: string,
  cwd: string | null,
  platform: Platform = process.platform as Platform,
  homeDir: string = os.homedir(),
  tempDirs?: readonly string[],
): boolean {
  const norm = normalizePath(rawPath, cwd, platform, homeDir)
  const roots = tempDirs
    ? tempDirs.map((d) => normalizePath(d, null, platform, homeDir))
    : defaultTempRoots(platform, homeDir)
  return roots.some((root) => isInsideDir(norm, root, platform))
}

function defaultTempRoots(platform: Platform, homeDir: string): string[] {
  const raw = new Set<string>()
  if (platform !== 'win32') raw.add('/tmp')
  const sysTmp = os.tmpdir()
  if (sysTmp) raw.add(sysTmp)
  if (process.env.TMPDIR) raw.add(process.env.TMPDIR)
  if (platform === 'win32') {
    if (process.env.TEMP) raw.add(process.env.TEMP)
    if (process.env.TMP) raw.add(process.env.TMP)
  }
  return [...raw].map((dir) => normalizePath(dir, null, platform, homeDir))
}

/** 判断路径是否落在当前工作区、系统临时目录或 agy 自身 brain 目录内。 */
function isInSafeWriteArea(rawPath: string, ctx: AgyEvalContext): boolean {
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  const norm = normalizePath(rawPath, ctx.cwd, platform, home)
  if (ctx.cwd) {
    const normCwd = normalizePath(ctx.cwd, null, platform, home)
    if (isInsideDir(norm, normCwd, platform)) return true
  }
  if (isInTempDir(norm, ctx.cwd, platform, home, ctx.tempDirs)) return true
  const brainBase = normalizePath(
    path.join(ctx.agentHome ?? home, '.gemini', ctx.agyAppDataDir ?? 'antigravity-cli', 'brain'),
    null,
    platform,
    home,
  )
  if (isInsideDir(norm, brainBase, platform)) return true
  return false
}

// ---------------------------------------------------------------------------
// agy settings.json `permissions.ask` 规则读取与匹配
// ---------------------------------------------------------------------------

/** agy settings.json 中单条 `action(target)` 规则。 */
export interface AgyAskRule {
  readonly action: string
  readonly target: string
}

const RULE_SYNTAX = /^([a-z_]+)\((.*)\)$/s

/** 解析 agy 权限规则字符串（如 `command(git push)`、`write_file(src/)`、`mcp(github/*)`）。 */
export function parseAgyRule(raw: string): AgyAskRule | null {
  const match = RULE_SYNTAX.exec(raw.trim())
  if (!match) return null
  return { action: match[1]!, target: match[2]! }
}

/** 检查命令字符串是否命中 `command(...)` / `unsandboxed(...)` 规则。 */
function matchesCommandRule(command: string, target: string): boolean {
  const trimmed = command.trim()
  if (target === '*') return true
  if (target.startsWith('regex:')) {
    const pattern = target.slice('regex:'.length)
    try {
      return new RegExp(`^(?:${pattern})$`).test(trimmed)
    } catch {
      return false
    }
  }
  // 词前缀匹配（遵循 Antigravity CLI 权限文档）。
  return trimmed === target || trimmed.startsWith(`${target} `) || trimmed.startsWith(`${target}\t`)
}

/** 检查文件路径是否命中 `read_file(...)` / `write_file(...)` 规则。 */
function matchesPathRule(
  filePath: string,
  target: string,
  cwd: string | null,
  platform: Platform,
  homeDir: string,
): boolean {
  if (target === '*') return true
  const normFile = normalizePath(filePath, cwd, platform, homeDir)
  const normTarget = normalizePath(target, cwd, platform, homeDir)
  return isInsideDir(normFile, normTarget, platform)
}

/** 检查 MCP 工具名（`mcp_<server>_<tool>`）是否命中 `mcp(...)` 规则。 */
function matchesMcpRule(agyToolName: string, target: string): boolean {
  if (target === '*') return true
  if (!agyToolName.startsWith('mcp_')) return false
  const body = agyToolName.slice('mcp_'.length)
  if (target.endsWith('/*')) {
    const server = target.slice(0, -2)
    return body.startsWith(`${server}_`)
  }
  const slash = target.indexOf('/')
  if (slash > 0) {
    const server = target.slice(0, slash)
    const tool = target.slice(slash + 1)
    return body === `${server}_${tool}`
  }
  return body === target
}

/** 检查 URL 是否命中 `read_url(...)` / `execute_url(...)` 规则。 */
function matchesUrlRule(rawUrl: string, target: string): boolean {
  if (target === '*') return true
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    const pattern = target.toLowerCase()
    return host === pattern || host.endsWith(`.${pattern}`)
  } catch {
    return false
  }
}

/** 按文件 mtime 缓存读取 agy settings.json 中的 `permissions.ask` 规则列表。 */
export class AgyUserAskRules {
  private readonly cache = new Map<string, { mtimeMs: number; rules: AgyAskRule[] }>()

  async read(home?: string): Promise<readonly AgyAskRule[]> {
    const base = home ?? os.homedir()
    const file = path.join(base, '.gemini', 'antigravity-cli', 'settings.json')
    try {
      const info = await stat(file)
      const hit = this.cache.get(file)
      if (hit && hit.mtimeMs === info.mtimeMs) return hit.rules
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
      const perms = record(record(raw)?.permissions)
      const ask = Array.isArray(perms?.ask) ? perms.ask : []
      const rules = ask
        .filter((item): item is string => typeof item === 'string')
        .map(parseAgyRule)
        .filter((rule): rule is AgyAskRule => rule !== null)
      this.cache.set(file, { mtimeMs: info.mtimeMs, rules })
      return rules
    } catch {
      this.cache.delete(file)
      return []
    }
  }
}

// ---------------------------------------------------------------------------
// 本会话总是允许记忆（AgySessionGrants）
// ---------------------------------------------------------------------------

/** 单个 agy 根会话（及其子智能体）内用户点击「本会话总是允许」记住的授权集合。 */
export class AgySessionGrants {
  private readonly mcpTools = new Set<string>()
  private readonly writeDirs = new Set<string>()
  private readonly commandPrefixes: (readonly string[])[] = []

  constructor(private readonly platform: Platform = process.platform as Platform) {}

  add(scope: AgySessionGrantScope): void {
    switch (scope.kind) {
      case 'mcp_tool':
        this.mcpTools.add(scope.tool)
        break
      case 'write_dir':
        this.writeDirs.add(compareKey(scope.dir, this.platform))
        break
      case 'command_prefix':
        if (
          scope.prefix.length > 0 &&
          !this.commandPrefixes.some(
            (existing) =>
              existing.length === scope.prefix.length &&
              existing.every((word, i) => word === scope.prefix[i]),
          )
        ) {
          this.commandPrefixes.push([...scope.prefix])
        }
        break
    }
  }

  allowsMcp(tool: string): boolean {
    return this.mcpTools.has(tool)
  }

  allowsWrite(normalizedPath: string): boolean {
    const target = compareKey(normalizedPath, this.platform)
    for (const dir of this.writeDirs) {
      if (target === dir || target.startsWith(dir.endsWith('/') ? dir : `${dir}/`)) return true
    }
    return false
  }

  allowsCommandWords(words: readonly string[]): boolean {
    if (words.length === 0) return false
    return this.commandPrefixes.some(
      (prefix) => words.length >= prefix.length && prefix.every((word, i) => words[i] === word),
    )
  }
}

/** 构造在权限卡片上显示的「本会话总是允许」选项。 */
export function buildSessionGrantOption(scope: AgySessionGrantScope): PermissionOption {
  switch (scope.kind) {
    case 'mcp_tool':
      return {
        id: SESSION_ALLOW_OPTION_ID,
        name: t('antigravity.auto.allowSessionMcp', { tool: scope.label }),
        kind: 'allow_always',
      }
    case 'write_dir':
      return {
        id: SESSION_ALLOW_OPTION_ID,
        name: t('antigravity.auto.allowSessionDir', { dir: scope.displayDir }),
        kind: 'allow_always',
      }
    case 'command_prefix':
      return {
        id: SESSION_ALLOW_OPTION_ID,
        name: t('antigravity.auto.allowSessionCommand', { command: scope.display }),
        kind: 'allow_always',
      }
  }
}

// ---------------------------------------------------------------------------
// 增强型 Shell 词法拆解与命令风险评估
// ---------------------------------------------------------------------------

interface ParsedClause {
  words: string[]
  /** 文件写入重定向目标（已排除 /dev/null 和 fd 重定向）。 */
  writeRedirects: string[]
  /** 文件输入重定向目标。 */
  readRedirects: string[]
  /** heredoc 正文内容（用于检查 python3 - <<'EOF' 等）。 */
  heredocBody: string | null
  /** 该子句与前一个子句之间是否通过管道连接。 */
  pipedFromPrev: boolean
}

interface ParsedCommand {
  clauses: ParsedClause[]
  /** 命令替换 `$(...)` 或反引号内部的子命令文本。 */
  substitutions: string[]
  /** 无法安全解析的语法（未闭合引号、未知重定向、函数定义等）。 */
  unparseable: boolean
}

/**
 * 解析一条 shell 命令行：
 * - 拆分 `&&`、`||`、`;`、`|`、`&` 与非引号内换行；
 * - 识别并剥离无害重定向（`2>/dev/null`、`2>&1`、`>/dev/null` 等），单独提取文件读写重定向；
 * - 收集 `$(...)` 与反引号子命令供递归风险检查；
 * - 提取 heredoc 正文。
 */
export function parseShellCommand(command: string, shell: Shell = 'posix'): ParsedCommand {
  const clauses: ParsedClause[] = []
  const substitutions: string[] = []
  let words: string[] = []
  let writeRedirects: string[] = []
  let readRedirects: string[] = []
  let heredocDelimiter: string | null = null
  let heredocBody: string | null = null
  let word: string | null = null
  let pipedFromPrev = false
  let pendingRedirect: 'read' | 'write' | 'heredoc' | null = null

  const pushWord = (text: string): void => {
    if (pendingRedirect === 'write') {
      if (text !== '/dev/null' && !/^&[12]$/.test(text)) writeRedirects.push(text)
      pendingRedirect = null
    } else if (pendingRedirect === 'read') {
      if (text !== '/dev/null') readRedirects.push(text)
      pendingRedirect = null
    } else if (pendingRedirect === 'heredoc') {
      heredocDelimiter = text
      pendingRedirect = null
    } else {
      words.push(text)
    }
  }

  const endWord = (): void => {
    if (word !== null) {
      pushWord(word)
      word = null
    }
  }

  const endClause = (nextPiped: boolean): boolean => {
    endWord()
    if (pendingRedirect !== null) return false
    if (words.length > 0 || writeRedirects.length > 0 || readRedirects.length > 0) {
      clauses.push({ words, writeRedirects, readRedirects, heredocBody, pipedFromPrev })
      words = []
      writeRedirects = []
      readRedirects = []
      heredocBody = null
    }
    pipedFromPrev = nextPiped
    return true
  }

  // 解析命令替换 $(...)，返回闭合括号位置，失败返回 -1。
  const readDollarParen = (start: number): number => {
    let depth = 1
    let i = start
    while (i < command.length && depth > 0) {
      const ch = command[i]!
      if (ch === "'") {
        const close = command.indexOf("'", i + 1)
        if (close === -1) return -1
        i = close + 1
        continue
      }
      if (ch === '"') {
        i++
        while (i < command.length && command[i] !== '"') {
          if (command[i] === '\\' && shell === 'posix') i += 2
          else i++
        }
        if (i >= command.length) return -1
        i++
        continue
      }
      if (ch === '\\' && shell === 'posix') {
        i += 2
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    if (depth !== 0) return -1
    substitutions.push(command.slice(start, i - 1))
    return i - 1
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]!
    const next = command[i + 1]

    // 行尾若存在挂起的 heredoc，直接吞入直到单独一行的分隔符。
    if (c === '\n') {
      if (!endClause(false)) return { clauses, substitutions, unparseable: true }
      i++
      if (heredocDelimiter !== null) {
        const delim = heredocDelimiter
        heredocDelimiter = null
        const bodyLines: string[] = []
        let closed = false
        while (i < command.length) {
          const nl = command.indexOf('\n', i)
          const line = nl === -1 ? command.slice(i) : command.slice(i, nl)
          i = nl === -1 ? command.length : nl + 1
          if (line.trim() === delim) {
            closed = true
            break
          }
          bodyLines.push(line)
        }
        if (!closed) return { clauses, substitutions, unparseable: true }
        const lastClause = clauses.at(-1)
        if (lastClause) lastClause.heredocBody = bodyLines.join('\n')
      }
      continue
    }

    if (c === '\r') {
      i++
      continue
    }

    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }

    // 注释：词首 # 忽略到行尾。
    if (c === '#' && word === null) {
      const nl = command.indexOf('\n', i)
      i = nl === -1 ? command.length : nl
      continue
    }

    // 单引号字面量。
    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) return { clauses, substitutions, unparseable: true }
      word = (word ?? '') + command.slice(i + 1, close)
      i = close + 1
      continue
    }

    // 双引号字符串（提取其中的 $(...) 与反引号）。
    if (c === '"') {
      let text = ''
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        const d = command[j]!
        const dn = command[j + 1]
        if (d === '\\' && shell === 'posix' && dn !== undefined) {
          text += dn
          j += 2
        } else if (d === '$' && dn === '(') {
          if (command[j + 2] === '(') {
            // 算术展开 $((...))，跳过至 ))。
            const endArith = command.indexOf('))', j + 3)
            if (endArith === -1) return { clauses, substitutions, unparseable: true }
            text += command.slice(j, endArith + 2)
            j = endArith + 2
          } else {
            const close = readDollarParen(j + 2)
            if (close === -1) return { clauses, substitutions, unparseable: true }
            text += command.slice(j, close + 1)
            j = close + 1
          }
        } else if (d === '`') {
          const close = command.indexOf('`', j + 1)
          if (close === -1) return { clauses, substitutions, unparseable: true }
          substitutions.push(command.slice(j + 1, close))
          text += command.slice(j, close + 1)
          j = close + 1
        } else {
          text += d
          j++
        }
      }
      if (j >= command.length) return { clauses, substitutions, unparseable: true }
      word = (word ?? '') + text
      i = j + 1
      continue
    }

    // 反斜杠转义（POSIX）。
    if (c === '\\' && shell === 'posix') {
      if (next === '\n') {
        // 续行符。
        i += 2
        continue
      }
      if (next === undefined) return { clauses, substitutions, unparseable: true }
      word = (word ?? '') + next
      i += 2
      continue
    }

    // 裸命令替换 $(...) 或算术 $((...))。
    if (c === '$' && next === '(') {
      if (command[i + 2] === '(') {
        const endArith = command.indexOf('))', i + 3)
        if (endArith === -1) return { clauses, substitutions, unparseable: true }
        word = (word ?? '') + command.slice(i, endArith + 2)
        i = endArith + 2
        continue
      }
      const close = readDollarParen(i + 2)
      if (close === -1) return { clauses, substitutions, unparseable: true }
      word = (word ?? '') + command.slice(i, close + 1)
      i = close + 1
      continue
    }

    // 裸反引号命令替换。
    if (c === '`') {
      const close = command.indexOf('`', i + 1)
      if (close === -1) return { clauses, substitutions, unparseable: true }
      substitutions.push(command.slice(i + 1, close))
      word = (word ?? '') + command.slice(i, close + 1)
      i = close + 1
      continue
    }

    // fd 重定向前缀（如 2>/dev/null、2>&1、1>&2、&>/dev/null）。
    if ((word === null || /^[012]$/.test(word)) && (c === '>' || c === '<')) {
      const fd = word
      word = null
      if (c === '>' && next === '&') {
        // 如 2>&1、1>&2、>&2。
        const targetFd = command[i + 2]
        if (targetFd === '1' || targetFd === '2') {
          i += 3
          continue
        }
        // &>/dev/null 之外的 >&file 写入重定向。
        pendingRedirect = 'write'
        i += 2
        continue
      }
      if (c === '>') {
        if (next === '>' || next === '|') i += 2
        else i += 1
        pendingRedirect = 'write'
        continue
      }
      if (c === '<') {
        if (fd !== null) return { clauses, substitutions, unparseable: true }
        if (next === '<') {
          if (command[i + 2] === '<') {
            // here-string <<<，把后续词当作普通输入跳过。
            i += 3
            pendingRedirect = 'read'
            continue
          }
          i += command[i + 2] === '-' ? 3 : 2
          pendingRedirect = 'heredoc'
          continue
        }
        if (next === '(') {
          // 进程替换 <(...)，无法保证安全，保守标记不可解析。
          return { clauses, substitutions, unparseable: true }
        }
        pendingRedirect = 'read'
        i += 1
        continue
      }
    }

    // &>/file 或 &>>/file 重定向。
    if (c === '&' && next === '>') {
      endWord()
      i += command[i + 2] === '>' ? 3 : 2
      pendingRedirect = 'write'
      continue
    }

    // 分隔符 &&、||、;、|、&。
    if (c === '&' || c === '|' || c === ';') {
      if (c === '&' && next === '&') {
        if (!endClause(false)) return { clauses, substitutions, unparseable: true }
        i += 2
        continue
      }
      if (c === '&') {
        // 单个 & 后台执行。
        if (!endClause(false)) return { clauses, substitutions, unparseable: true }
        i += 1
        continue
      }
      if (c === '|' && next === '|') {
        if (!endClause(false)) return { clauses, substitutions, unparseable: true }
        i += 2
        continue
      }
      if (c === '|' && next === '&') {
        if (!endClause(true)) return { clauses, substitutions, unparseable: true }
        i += 2
        continue
      }
      if (c === '|') {
        if (!endClause(true)) return { clauses, substitutions, unparseable: true }
        i += 1
        continue
      }
      if (c === ';') {
        if (next === ';') return { clauses, substitutions, unparseable: true }
        if (!endClause(false)) return { clauses, substitutions, unparseable: true }
        i += 1
        continue
      }
    }

    // 子 shell / 代码块分组 / 函数定义（() { ... }）：保守标记不可安全解析。
    if ((c === '(' || c === ')' || c === '{' || c === '}') && word === null) {
      return { clauses, substitutions, unparseable: true }
    }
    if (c === '(' && next === ')') {
      // 函数定义 foo()。
      return { clauses, substitutions, unparseable: true }
    }

    word = (word ?? '') + c
    i++
  }

  if (!endClause(false) || heredocDelimiter !== null) {
    return { clauses, substitutions, unparseable: true }
  }
  return { clauses, substitutions, unparseable: false }
}

/** 提取可执行程序的基础名（小写，去掉路径与 Windows 脚本后缀）。 */
function commandBaseName(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '')
}

const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/

/** 命令评估的内部结果。 */
interface CommandVerdict {
  safe: boolean
  risk: AgyRiskLevel
  reason?: string
  /** 可用于合成「本会话总是允许」的安全命令前缀（高危操作为 null）。 */
  grantPrefix?: readonly string[] | null
}

const SAFE_VERDICT: CommandVerdict = { safe: true, risk: 'safe' }

function riskPriority(risk: AgyRiskLevel): number {
  return risk === 'destructive' ? 2 : risk === 'risky' ? 1 : 0
}

/** 合并多个子句判定结果，保留最高风险等级。 */
function worseVerdict(a: CommandVerdict, b: CommandVerdict): CommandVerdict {
  if (a.safe) return b
  if (b.safe) return a
  if (riskPriority(b.risk) > riskPriority(a.risk)) return b
  // 两者都需拦截时若有一个禁止本会话允许，合并后也禁止本会话允许。
  if (a.grantPrefix === null || b.grantPrefix === null) {
    return { ...a, grantPrefix: null }
  }
  return a
}

/** 解包常见命令包装器（env / timeout / nice / nohup / xargs 等）。 */
function unwrapWrapper(head: string, args: readonly string[]): readonly string[] | null {
  let i = 0
  if (head === 'env') {
    while (i < args.length) {
      const arg = args[i]!
      if (['-i', '-', '--ignore-environment', '-0', '--null'].includes(arg)) {
        i++
      } else if (arg === '-u' || arg === '--unset') {
        i += 2
      } else if (/^(?:-u|--unset=)./.test(arg)) {
        i++
      } else if (ENV_ASSIGN.test(arg)) {
        const name = ENV_ASSIGN.exec(arg)![1]!
        if (!SAFE_ENV_VAR.test(name)) return null
        i++
      } else {
        break
      }
    }
  } else if (head === 'timeout') {
    while (i < args.length) {
      const arg = args[i]!
      if (['--preserve-status', '--foreground', '-v', '--verbose'].includes(arg)) i++
      else if (['-s', '--signal', '-k', '--kill-after'].includes(arg)) i += 2
      else if (/^(?:-[sk].|--(?:signal|kill-after)=)/.test(arg)) i++
      else break
    }
    if (!/^\d+(?:\.\d+)?[smhd]?$/.test(args[i] ?? '')) return null
    i++
  } else if (head === 'nice') {
    while (i < args.length) {
      const arg = args[i]!
      if (arg === '-n' || arg === '--adjustment') i += 2
      else if (/^(?:-n-?\d+|--adjustment=-?\d+|-\d+)$/.test(arg)) i++
      else break
    }
  } else if (head === 'time' || head === 'command') {
    while (args[i] === '-p') i++
  } else if (head === 'xargs') {
    while (i < args.length) {
      const arg = args[i]!
      if (arg === '--') {
        i++
        break
      }
      if (!arg.startsWith('-') || arg === '-') break
      if (arg === '-I' || arg === '-i' || arg.startsWith('-I')) return null
      if (['-n', '-P', '-L', '-s', '-d', '-E', '-a'].includes(arg)) i += 2
      else i++
    }
  }
  if (args[i] === '--') i++
  return args.slice(i)
}

/** 评估一条完整终端命令在 Auto 模式下的安全性（支持多行、管道、重定向与命令替换递归检查）。 */
export function evaluateAgyCommand(
  command: string,
  ctx: AgyEvalContext,
  depth = 0,
): CommandVerdict {
  const trimmed = command.trim()
  if (trimmed === '') {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.complexCommand'),
      grantPrefix: null,
    }
  }
  if (depth > 4) {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.complexCommand'),
      grantPrefix: null,
    }
  }

  const shell = ctx.shell ?? (ctx.platform === 'win32' ? 'powershell' : 'posix')
  const parsed = parseShellCommand(trimmed, shell)
  if (parsed.unparseable || parsed.clauses.length === 0) {
    // 即使无法完全解析，仍做高危删除关键词扫描以准确标为 destructive。
    const hasDelete = /\b(?:rm|rmdir|unlink|shred|rimraf|mkfs|dd|sudo)\b/.test(trimmed)
    return {
      safe: false,
      risk: hasDelete ? 'destructive' : 'risky',
      reason: t(
        hasDelete
          ? 'antigravity.auto.reason.deleteFiles'
          : 'antigravity.auto.reason.complexCommand',
      ),
      grantPrefix: null,
    }
  }

  let verdict: CommandVerdict = SAFE_VERDICT

  // 1. 递归评估所有 $(...) 与反引号子命令。
  for (const sub of parsed.substitutions) {
    const subVerdict = evaluateAgyCommand(sub, ctx, depth + 1)
    verdict = worseVerdict(verdict, subVerdict)
  }

  // 2. 检测高危管道组合（如 curl/wget | sh/bash/python/node）。
  for (let i = 1; i < parsed.clauses.length; i++) {
    const prev = parsed.clauses[i - 1]!
    const curr = parsed.clauses[i]!
    if (!curr.pipedFromPrev) continue
    const prevHead = commandHeadOf(prev.words)
    const currHead = commandHeadOf(curr.words)
    if (
      (prevHead === 'curl' || prevHead === 'wget') &&
      currHead !== null &&
      (SHELL_INTERPRETERS.has(currHead) ||
        SCRIPT_INTERPRETERS.has(currHead) ||
        PYTHON_CMD.test(currHead))
    ) {
      verdict = worseVerdict(verdict, {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.remoteScript'),
        grantPrefix: null,
      })
    }
  }

  // 3. 逐条评估每个子句的重定向与主命令。
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  for (const clause of parsed.clauses) {
    for (const readTarget of clause.readRedirects) {
      if (isSensitiveReadPath(readTarget, ctx.cwd, platform, home)) {
        verdict = worseVerdict(verdict, {
          safe: false,
          risk: 'risky',
          reason: t('antigravity.auto.reason.sensitiveRead', { target: readTarget }),
          grantPrefix: null,
        })
      }
    }
    for (const writeTarget of clause.writeRedirects) {
      const sensitive = isSensitiveWritePath(writeTarget, ctx.cwd, platform, home)
      if (sensitive.sensitive) {
        verdict = worseVerdict(verdict, {
          safe: false,
          risk: 'destructive',
          reason: t('antigravity.auto.reason.sensitiveWrite', { target: sensitive.label }),
          grantPrefix: null,
        })
      } else if (!isInSafeWriteArea(writeTarget, ctx)) {
        verdict = worseVerdict(verdict, {
          safe: false,
          risk: 'risky',
          reason: t('antigravity.auto.reason.outsideWrite', { target: writeTarget }),
          grantPrefix: null,
        })
      }
    }
    if (clause.words.length > 0) {
      const clauseVerdict = evaluateClauseWords(clause.words, clause.heredocBody, ctx, depth)
      verdict = worseVerdict(verdict, clauseVerdict)
    }
  }

  // 多子句命令禁止合成单条前缀的本会话授权，避免顺带记住复杂组合命令。
  if (!verdict.safe && (parsed.clauses.length > 1 || parsed.substitutions.length > 0)) {
    verdict = { ...verdict, grantPrefix: null }
  }

  return verdict
}

/** 跳过子句头部环境变量赋值，返回主程序小写基础名。 */
function commandHeadOf(words: readonly string[]): string | null {
  for (const w of words) {
    if (!ENV_ASSIGN.test(w)) return commandBaseName(w)
  }
  return null
}

/** 评估单个子句的词列表（去除安全环境变量前缀后分派到各命令规则）。 */
function evaluateClauseWords(
  rawWords: readonly string[],
  heredocBody: string | null,
  ctx: AgyEvalContext,
  depth: number,
): CommandVerdict {
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  let start = 0
  for (; start < rawWords.length; start++) {
    const m = ENV_ASSIGN.exec(rawWords[start]!)
    if (!m) break
    if (!SAFE_ENV_VAR.test(m[1]!)) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.sensitiveEnv', { name: m[1]! }),
        grantPrefix: null,
      }
    }
  }
  const words = rawWords.slice(start)
  if (words.length === 0) return SAFE_VERDICT

  const first = words[0]!
  // 动态命令名（如 $CMD 或含通配符/命令替换的命令头）无法判定，保守拦截。
  if (/[$`*?[\]]/.test(first) || first.startsWith('-')) {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.complexCommand'),
      grantPrefix: null,
    }
  }

  const head = commandBaseName(first)
  const args = words.slice(1)

  // Shell 关键字（说明存在未拆开的控制流，保守拦截）。
  if (
    [
      'if',
      'then',
      'else',
      'elif',
      'fi',
      'for',
      'while',
      'until',
      'do',
      'done',
      'case',
      'esac',
      'function',
    ].includes(head)
  ) {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.complexCommand'),
      grantPrefix: null,
    }
  }

  // 1. 删除类命令：始终拦截并标 destructive，区分核心文件提示。
  if (DELETE_COMMANDS.has(head)) {
    const targets = args.filter((a) => !a.startsWith('-'))
    const hitsCore = targets.some((target) => isCoreProjectPath(target, ctx.cwd, platform, home))
    const recursive = args.some((a) => /^-[A-Za-z]*[rR]/.test(a) || a === '--recursive')
    return {
      safe: false,
      risk: 'destructive',
      reason: hitsCore
        ? t('antigravity.auto.reason.deleteCore', {
            target:
              targets.find((x) => isCoreProjectPath(x, ctx.cwd, platform, home)) ??
              targets[0] ??
              '',
          })
        : recursive
          ? t('antigravity.auto.reason.deleteRecursive')
          : t('antigravity.auto.reason.deleteFiles'),
      grantPrefix: null,
    }
  }

  // 2. 提权、磁盘格式化与系统关机：始终 destructive。
  if (PRIVILEGED_OR_SYSTEM_COMMANDS.has(head) || /^(?:mkfs|newfs)[._]/.test(head)) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.privilegedCommand', { command: head }),
      grantPrefix: null,
    }
  }

  // 3. 权限修改与终止进程：始终拦截。
  if (SYSTEM_MUTATION_COMMANDS.has(head)) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.systemMutation', { command: head }),
      grantPrefix: null,
    }
  }

  // 4. 不透明执行命令：保守拦截。
  if (OPAQUE_COMMANDS.has(head)) {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.opaqueCommand', { command: head }),
      grantPrefix: null,
    }
  }

  // 5. 透明包装器解包（env / timeout / nice / xargs 等）。
  if (WRAPPERS.has(head)) {
    const inner = unwrapWrapper(head, args)
    if (!inner || inner.length === 0) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.complexCommand'),
        grantPrefix: null,
      }
    }
    return evaluateClauseWords(inner, heredocBody, ctx, depth + 1)
  }

  // 6. Shell 解释器（sh -c / bash -lc 等递归评估内层命令）。
  if (SHELL_INTERPRETERS.has(head)) {
    return evaluateShellInterpreter(head, args, heredocBody, ctx, depth)
  }

  // 7. 脚本解释器（node / python3 / ruby 等）。
  if (SCRIPT_INTERPRETERS.has(head) || PYTHON_CMD.test(head)) {
    return evaluateScriptInterpreter(head, args, heredocBody, ctx)
  }

  // 8. 具体高关注 CLI 精细判定。
  switch (head) {
    case 'git':
      return evaluateGitCommand(args)
    case 'gh':
      return evaluateGhCommand(args)
    case 'find':
      return evaluateFindCommand(args)
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      return evaluateAwkCommand(args, ctx)
    case 'sed':
      return evaluateSedCommand(args, ctx)
    case 'mv':
    case 'cp':
    case 'ln':
    case 'tee':
    case 'touch':
    case 'mkdir':
    case 'install':
      return evaluateFileMutationCommand(head, args, ctx)
    case 'rsync':
      return evaluateRsyncCommand(args)
    case 'tar':
      return evaluateTarCommand(args)
    case 'curl':
    case 'wget':
      return evaluateNetworkCommand(head, args, ctx)
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'npx':
    case 'pnpx':
    case 'bunx':
    case 'uvx':
    case 'uv':
    case 'cargo':
    case 'poetry':
      return evaluatePackageToolCommand(head, args, heredocBody, ctx, depth)
    case 'defaults':
      return evaluateDefaultsCommand(args)
    case 'launchctl':
      return args[0] === 'list' || args[0] === 'print'
        ? SAFE_VERDICT
        : {
            safe: false,
            risk: 'risky',
            reason: t('antigravity.auto.reason.systemMutation', { command: 'launchctl' }),
            grantPrefix: null,
          }
    case 'brew':
      return evaluateBrewCommand(args)
    case 'docker':
    case 'podman':
    case 'kubectl':
    case 'helm':
    case 'terraform':
    case 'wrangler':
    case 'vercel':
    case 'fly':
    case 'flyctl':
      return evaluateInfraCommand(head, args)
    case 'sqlite3':
      return evaluateSqliteCommand(args)
    default:
      break
  }

  // 9. 文件读取类命令：校验是否存在读取敏感凭据路径的参数。
  if (FILE_READ_COMMANDS.has(head)) {
    for (const arg of args) {
      if (arg.startsWith('-')) continue
      if (isSensitiveReadPath(arg, ctx.cwd, platform, home)) {
        return {
          safe: false,
          risk: 'risky',
          reason: t('antigravity.auto.reason.sensitiveRead', { target: arg }),
          grantPrefix: null,
        }
      }
    }
  }

  // 10. 通用 CLI 兜底安全扫描：含危险破坏子命令词或 --delete/--destroy/--purge 标志则拦截。
  if (
    args.some((arg) =>
      /^(?:--delete|--destroy|--purge|--wipe|--force-delete)$/.test(arg.toLowerCase()),
    )
  ) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.destructiveCommand', { command: head }),
      grantPrefix: null,
    }
  }

  return SAFE_VERDICT
}

function evaluateShellInterpreter(
  head: string,
  args: readonly string[],
  heredocBody: string | null,
  ctx: AgyEvalContext,
  depth: number,
): CommandVerdict {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) return SAFE_VERDICT
  // sh -c "..." / bash -lc "..." / zsh -c "..."
  if (args.length >= 2 && /^-[A-Za-z]*c$/.test(args[0]!)) {
    return evaluateAgyCommand(args[1]!, ctx, depth + 1)
  }
  if (heredocBody !== null) {
    return evaluateAgyCommand(heredocBody, ctx, depth + 1)
  }
  // 执行外部脚本文件：非安全区域或无法审查其内部命令，保守拦截。
  const script = args.find((a) => !a.startsWith('-'))
  if (script && isInSafeWriteArea(script, ctx)) {
    return SAFE_VERDICT
  }
  return {
    safe: false,
    risk: 'risky',
    reason: t('antigravity.auto.reason.opaqueCommand', { command: head }),
    grantPrefix: null,
  }
}

/** 扫描内联脚本中是否存在破坏性删除、子进程执行、敏感凭据访问或文件写入。 */
const INLINE_DESTRUCTIVE =
  /\b(?:rmtree|unlink|unlinkSync|rmSync|rmdir|rmdirSync|remove\s*\(|shutil\.|os\.system|subprocess\.|child_process|execSync|execFileSync|spawnSync|spawn\(|sudo|chmod|chown|kill|pkill|osascript|DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE)\b|(?:~\/\.ssh|\/\.ssh\/|\/\.aws\/|\/\.gnupg\/|Keychain|\/etc\/shadow|\/etc\/passwd|\.env\b)/i
const INLINE_WRITE =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|open\([^)]*['"`][wax+]|INSERT\s+INTO|UPDATE\s+\w+\s+SET)\b/i

function evaluateScriptInterpreter(
  head: string,
  args: readonly string[],
  heredocBody: string | null,
  ctx: AgyEvalContext,
): CommandVerdict {
  if (args.length === 1 && ['--version', '-v', '-V', '--help', '-h'].includes(args[0]!)) {
    return SAFE_VERDICT
  }
  // 提取 -c / -e / --eval 或 heredoc 内联代码进行安全检查。
  let inlineCode: string | null = heredocBody
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (
      (arg === '-c' || arg === '-e' || arg === '--eval' || arg === '-p') &&
      args[i + 1] !== undefined
    ) {
      inlineCode = args[i + 1]!
      break
    }
  }
  if (inlineCode !== null) {
    if (INLINE_DESTRUCTIVE.test(inlineCode)) {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.destructiveScript', { command: head }),
        grantPrefix: null,
      }
    }
    if (INLINE_WRITE.test(inlineCode)) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.sensitiveScript', { command: head }),
        grantPrefix: null,
      }
    }
    return SAFE_VERDICT
  }

  // 执行工作区或临时目录下的脚本文件（如 `node /tmp/verify.mjs`、`python3 scripts/check.py`）。
  if (head === 'bun' || head === 'deno') {
    const sub = args[0]
    if (sub === 'eval' || sub === 'repl') {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.opaqueCommand', { command: `${head} ${sub}` }),
        grantPrefix: null,
      }
    }
    if (sub === 'x') {
      return evaluateClauseWords(args.slice(1), null, ctx, 1)
    }
  }
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  const scriptFile = args.find((a) => !a.startsWith('-'))
  if (scriptFile) {
    if (isSensitiveReadPath(scriptFile, ctx.cwd, platform, home)) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.sensitiveRead', { target: scriptFile }),
        grantPrefix: null,
      }
    }
    const isAbs =
      platform === 'win32'
        ? /^[A-Za-z]:[/\\]|^\\\\/.test(scriptFile)
        : scriptFile.startsWith('/') || scriptFile.startsWith('~/')
    if (isAbs && !isInSafeWriteArea(scriptFile, ctx)) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.opaqueCommand', { command: head }),
        grantPrefix: null,
      }
    }
  }
  return SAFE_VERDICT
}

const GIT_SAFE_OPTIONS = new Set([
  '--no-pager',
  '-P',
  '-p',
  '--paginate',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
])
const GIT_VALUE_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--namespace'])
const GIT_SAFE_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'annotate',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'describe',
  'shortlog',
  'cat-file',
  'show-ref',
  'merge-base',
  'name-rev',
  'for-each-ref',
  'check-ignore',
  'check-attr',
  'whatchanged',
  'range-diff',
  'cherry',
  'show-branch',
  'count-objects',
  'diff-tree',
  'diff-files',
  'diff-index',
  'version',
  'help',
  'add',
  'commit',
  'init',
  'clone',
])
const GIT_FORCE_FLAG = /^(?:--force|--hard|-f|-D|--delete)$|^--force-/

function evaluateGitCommand(args: readonly string[]): CommandVerdict {
  let i = 0
  for (; i < args.length && args[i]!.startsWith('-'); i++) {
    const arg = args[i]!
    if (GIT_VALUE_OPTIONS.has(arg)) {
      i++
    } else if (!GIT_SAFE_OPTIONS.has(arg) && !/^--(?:git-dir|work-tree|namespace)=/.test(arg)) {
      // 如 `git -c core.pager=...` 可能借配置执行任意命令。
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.gitConfigFlag'),
        grantPrefix: null,
      }
    }
  }
  const sub = args[i]
  if (!sub) return SAFE_VERDICT
  const rest = args.slice(i + 1)

  // 明确破坏性的 git 子命令（不提供本会话允许）。
  if (sub === 'clean' || sub === 'rm' || sub === 'filter-branch' || sub === 'filter-repo') {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.gitDestructive', { command: `git ${sub}` }),
      grantPrefix: null,
    }
  }
  if (sub === 'reset') {
    const hard = rest.some((a) => a === '--hard' || a === '--merge')
    return {
      safe: false,
      risk: hard ? 'destructive' : 'risky',
      reason: t('antigravity.auto.reason.gitDestructive', {
        command: hard ? 'git reset --hard' : 'git reset',
      }),
      grantPrefix: null,
    }
  }
  if (sub === 'push') {
    const force = rest.some((a) => GIT_FORCE_FLAG.test(a))
    return {
      safe: false,
      risk: force ? 'destructive' : 'risky',
      reason: t(force ? 'antigravity.auto.reason.gitForcePush' : 'antigravity.auto.reason.gitPush'),
      grantPrefix: force ? null : ['git', 'push'],
    }
  }
  if (sub === 'restore' || (sub === 'checkout' && rest.includes('--'))) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.gitDiscard'),
      grantPrefix: null,
    }
  }
  if (sub === 'checkout' || sub === 'switch') {
    const force = rest.some((a) => a === '-f' || a === '--force' || a === '--discard-changes')
    return force
      ? {
          safe: false,
          risk: 'destructive',
          reason: t('antigravity.auto.reason.gitDiscard'),
          grantPrefix: null,
        }
      : SAFE_VERDICT
  }
  if (sub === 'branch') {
    const deletes = rest.some((a) => a === '-d' || a === '-D' || a === '--delete' || a === '-M')
    return deletes
      ? {
          safe: false,
          risk: 'destructive',
          reason: t('antigravity.auto.reason.gitDestructive', { command: 'git branch -D' }),
          grantPrefix: null,
        }
      : SAFE_VERDICT
  }
  if (sub === 'tag') {
    const deletes = rest.some((a) => a === '-d' || a === '--delete')
    return deletes
      ? {
          safe: false,
          risk: 'destructive',
          reason: t('antigravity.auto.reason.gitDestructive', { command: 'git tag -d' }),
          grantPrefix: null,
        }
      : SAFE_VERDICT
  }
  if (sub === 'stash') {
    const action = rest[0]
    if (action === 'drop' || action === 'clear') {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.gitDestructive', { command: `git stash ${action}` }),
        grantPrefix: null,
      }
    }
    return SAFE_VERDICT
  }
  if (sub === 'worktree') {
    const action = rest[0]
    if (action === 'remove' || action === 'prune') {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.gitDestructive', { command: `git worktree ${action}` }),
        grantPrefix: null,
      }
    }
    return SAFE_VERDICT
  }
  if (sub === 'rebase' || sub === 'merge' || sub === 'cherry-pick' || sub === 'pull') {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.gitRewrite', { command: `git ${sub}` }),
      grantPrefix: ['git', sub],
    }
  }
  if (sub === 'config') {
    const readOnly = rest.some((a) =>
      ['--get', '--get-all', '--list', '-l', '--show-origin'].includes(a),
    )
    return readOnly
      ? SAFE_VERDICT
      : {
          safe: false,
          risk: 'risky',
          reason: t('antigravity.auto.reason.sensitiveWrite', { target: 'git config' }),
          grantPrefix: null,
        }
  }
  if (sub === 'fetch' || sub === 'ls-remote') {
    return rest.some((a) => /^--upload-pack|^-u/.test(a))
      ? {
          safe: false,
          risk: 'risky',
          reason: t('antigravity.auto.reason.complexCommand'),
          grantPrefix: null,
        }
      : SAFE_VERDICT
  }
  if (sub === 'grep') {
    return rest.some((a) => /^-[^-]*O|^--open-files-in-pager/.test(a))
      ? {
          safe: false,
          risk: 'risky',
          reason: t('antigravity.auto.reason.complexCommand'),
          grantPrefix: null,
        }
      : SAFE_VERDICT
  }
  if (sub === 'remote') {
    const action = rest.find((a) => !a.startsWith('-'))
    if (!action || action === 'show' || action === 'get-url') return SAFE_VERDICT
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.gitRewrite', { command: `git remote ${action}` }),
      grantPrefix: null,
    }
  }
  if (GIT_SAFE_SUBCOMMANDS.has(sub)) {
    if (rest.some((a) => a.startsWith('--output'))) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.complexCommand'),
        grantPrefix: null,
      }
    }
    return SAFE_VERDICT
  }
  return {
    safe: false,
    risk: 'risky',
    reason: t('antigravity.auto.reason.gitRewrite', { command: `git ${sub}` }),
    grantPrefix: ['git', sub],
  }
}

function evaluateGhCommand(args: readonly string[]): CommandVerdict {
  const [group, sub] = args
  if (!group || group.startsWith('-')) return SAFE_VERDICT
  if (group === 'status' || group === 'search') return SAFE_VERDICT
  if (group === 'auth') {
    return sub === 'status'
      ? SAFE_VERDICT
      : {
          safe: false,
          risk: 'risky',
          reason: t('antigravity.auto.reason.remoteIrreversible', {
            command: `gh auth ${sub ?? ''}`.trim(),
          }),
          grantPrefix: null,
        }
  }
  if (group === 'api') {
    let method = 'GET'
    let hasBody = false
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!
      if ((a === '-X' || a === '--method') && args[i + 1]) {
        method = args[i + 1]!.toUpperCase()
        i++
      } else if (a.startsWith('--method=')) {
        method = a.slice('--method='.length).toUpperCase()
      } else if (
        a === '-f' ||
        a === '-F' ||
        a === '--field' ||
        a === '--raw-field' ||
        a === '--input' ||
        a.startsWith('-f') ||
        a.startsWith('-F')
      ) {
        hasBody = true
      }
    }
    if (method === 'DELETE') {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.remoteIrreversible', { command: 'gh api DELETE' }),
        grantPrefix: null,
      }
    }
    if (method !== 'GET' || hasBody) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.remoteWrite', { command: 'gh api' }),
        grantPrefix: ['gh', 'api'],
      }
    }
    return SAFE_VERDICT
  }
  if (group === 'pr') {
    if (sub === 'merge' || sub === 'close') {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.remoteIrreversible', { command: `gh pr ${sub}` }),
        grantPrefix: null,
      }
    }
    if (
      !sub ||
      [
        'view',
        'list',
        'status',
        'checks',
        'diff',
        'ready',
        'create',
        'edit',
        'comment',
        'reopen',
      ].includes(sub)
    ) {
      return SAFE_VERDICT
    }
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.remoteWrite', { command: `gh pr ${sub}` }),
      grantPrefix: ['gh', 'pr', sub],
    }
  }
  if (group === 'issue') {
    if (sub === 'delete' || sub === 'close') {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.remoteIrreversible', { command: `gh issue ${sub}` }),
        grantPrefix: null,
      }
    }
    if (!sub || ['view', 'list', 'status', 'create', 'edit', 'comment', 'reopen'].includes(sub)) {
      return SAFE_VERDICT
    }
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.remoteWrite', { command: `gh issue ${sub}` }),
      grantPrefix: ['gh', 'issue', sub],
    }
  }
  if (group === 'repo') {
    if (sub === 'delete' || sub === 'archive') {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.remoteIrreversible', { command: `gh repo ${sub}` }),
        grantPrefix: null,
      }
    }
    if (!sub || ['view', 'list', 'clone'].includes(sub)) return SAFE_VERDICT
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.remoteWrite', { command: `gh repo ${sub}` }),
      grantPrefix: ['gh', 'repo', sub],
    }
  }
  if (group === 'release') {
    if (sub === 'delete' || sub === 'create') {
      return {
        safe: false,
        risk: sub === 'delete' ? 'destructive' : 'risky',
        reason: t('antigravity.auto.reason.remoteIrreversible', { command: `gh release ${sub}` }),
        grantPrefix: null,
      }
    }
    if (!sub || ['view', 'list', 'download'].includes(sub)) return SAFE_VERDICT
  }
  if (group === 'secret' || group === 'variable') {
    if (sub === 'list') return SAFE_VERDICT
    return {
      safe: false,
      risk: sub === 'delete' || sub === 'remove' ? 'destructive' : 'risky',
      reason: t('antigravity.auto.reason.remoteIrreversible', {
        command: `gh ${group} ${sub ?? ''}`.trim(),
      }),
      grantPrefix: null,
    }
  }
  if (group === 'run' || group === 'workflow') {
    if (!sub || ['list', 'view', 'watch'].includes(sub)) return SAFE_VERDICT
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.remoteWrite', { command: `gh ${group} ${sub}` }),
      grantPrefix: ['gh', group, sub],
    }
  }
  return {
    safe: false,
    risk: 'risky',
    reason: t('antigravity.auto.reason.remoteWrite', { command: `gh ${group}` }),
    grantPrefix: ['gh', group],
  }
}

function evaluateFindCommand(args: readonly string[]): CommandVerdict {
  if (args.includes('-delete')) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.deleteFiles'),
      grantPrefix: null,
    }
  }
  if (
    args.some((a) =>
      ['-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a),
    )
  ) {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.opaqueCommand', { command: 'find -exec' }),
      grantPrefix: null,
    }
  }
  return SAFE_VERDICT
}

function evaluateAwkCommand(args: readonly string[], ctx: AgyEvalContext): CommandVerdict {
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  for (const arg of args) {
    if (/\bsystem\s*\(|\bgetline\b/.test(arg)) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.opaqueCommand', { command: 'awk' }),
        grantPrefix: null,
      }
    }
    if (!arg.startsWith('-') && isSensitiveReadPath(arg, ctx.cwd, platform, home)) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.sensitiveRead', { target: arg }),
        grantPrefix: null,
      }
    }
  }
  return SAFE_VERDICT
}

function evaluateSedCommand(args: readonly string[], ctx: AgyEvalContext): CommandVerdict {
  const inPlace = args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')
  if (!inPlace) return SAFE_VERDICT
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  // 提取 sed -i 真正要原地修改的目标文件（跳过 -e/-f 表达式和 BSD sed -i '' 备份后缀）。
  const targets: string[] = []
  let hasExplicitScript = false
  let skippedScript = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file') {
      hasExplicitScript = true
      i++
      continue
    }
    if (arg === '-i') {
      // BSD sed 的 `-i ''` 或 `-i .bak` 形式：若后一参数为空字符串或明显扩展名备份，则跳过。
      const next = args[i + 1]
      if (next !== undefined && (next === '' || /^\.[A-Za-z0-9_-]+$/.test(next))) i++
      continue
    }
    if (arg.startsWith('-')) continue
    if (!hasExplicitScript && !skippedScript) {
      skippedScript = true
      continue
    }
    targets.push(arg)
  }
  for (const candidate of targets) {
    const sensitive = isSensitiveWritePath(candidate, ctx.cwd, platform, home)
    if (sensitive.sensitive) {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.sensitiveWrite', { target: sensitive.label }),
        grantPrefix: null,
      }
    }
    if (!isInSafeWriteArea(candidate, ctx)) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.outsideWrite', { target: candidate }),
        grantPrefix: null,
      }
    }
  }
  return SAFE_VERDICT
}

function evaluateFileMutationCommand(
  head: string,
  args: readonly string[],
  ctx: AgyEvalContext,
): CommandVerdict {
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  const paths = args.filter((a) => !a.startsWith('-'))
  if (paths.length === 0) return SAFE_VERDICT

  if (head === 'mv') {
    // 移走核心文件等同于破坏核心文件。
    for (const src of paths.slice(0, -1)) {
      if (isCoreProjectPath(src, ctx.cwd, platform, home)) {
        return {
          safe: false,
          risk: 'destructive',
          reason: t('antigravity.auto.reason.moveCore', { target: src }),
          grantPrefix: null,
        }
      }
      if (isSensitiveReadPath(src, ctx.cwd, platform, home)) {
        return {
          safe: false,
          risk: 'destructive',
          reason: t('antigravity.auto.reason.sensitiveWrite', { target: src }),
          grantPrefix: null,
        }
      }
    }
  }

  if (head === 'cp') {
    for (const src of paths.slice(0, -1)) {
      if (isSensitiveReadPath(src, ctx.cwd, platform, home)) {
        return {
          safe: false,
          risk: 'destructive',
          reason: t('antigravity.auto.reason.sensitiveRead', { target: src }),
          grantPrefix: null,
        }
      }
    }
  }

  const writeTargets =
    head === 'mv' || head === 'cp' || head === 'ln' || head === 'install' ? paths.slice(-1) : paths
  for (const target of writeTargets) {
    const sensitive = isSensitiveWritePath(target, ctx.cwd, platform, home)
    if (sensitive.sensitive) {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.sensitiveWrite', { target: sensitive.label }),
        grantPrefix: null,
      }
    }
    if (!isInSafeWriteArea(target, ctx)) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.outsideWrite', { target }),
        grantPrefix: null,
      }
    }
  }
  return SAFE_VERDICT
}

function evaluateRsyncCommand(args: readonly string[]): CommandVerdict {
  if (args.some((a) => /^--(?:del|remove-)/.test(a))) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.deleteFiles'),
      grantPrefix: null,
    }
  }
  if (args.some((a) => /^--(?:rsh|rsync-path)|^-[A-Za-z]*e/.test(a))) {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.opaqueCommand', { command: 'rsync' }),
      grantPrefix: null,
    }
  }
  return SAFE_VERDICT
}

function evaluateTarCommand(args: readonly string[]): CommandVerdict {
  if (args.some((a) => a.startsWith('--remove-files'))) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.deleteFiles'),
      grantPrefix: null,
    }
  }
  if (
    args.some(
      (a, i) =>
        /^--(?:use-compress|to-command|info-script|new-volume-script|checkpoint-action|rsh-command|rmt-command)/.test(
          a,
        ) ||
        ((i === 0 || /^-[^-]/.test(a)) && /^-?[A-Za-z]*[IF]/.test(a)),
    )
  ) {
    return {
      safe: false,
      risk: 'risky',
      reason: t('antigravity.auto.reason.opaqueCommand', { command: 'tar' }),
      grantPrefix: null,
    }
  }
  return SAFE_VERDICT
}

function evaluateNetworkCommand(
  head: string,
  args: readonly string[],
  ctx: AgyEvalContext,
): CommandVerdict {
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (/169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200/.test(a)) {
      return {
        safe: false,
        risk: 'destructive',
        reason: t('antigravity.auto.reason.sensitiveUrl'),
        grantPrefix: null,
      }
    }
    if ((a === '-X' || a === '--request') && args[i + 1]) {
      const method = args[i + 1]!.toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        return {
          safe: false,
          risk: method === 'DELETE' ? 'destructive' : 'risky',
          reason: t('antigravity.auto.reason.remoteWrite', { command: `${head} -X ${method}` }),
          grantPrefix: method === 'DELETE' ? null : [head],
        }
      }
    }
    if (
      [
        '-d',
        '--data',
        '--data-raw',
        '--data-binary',
        '--data-urlencode',
        '-F',
        '--form',
        '-T',
        '--upload-file',
        '--post-data',
        '--post-file',
      ].includes(a)
    ) {
      return {
        safe: false,
        risk: 'risky',
        reason: t('antigravity.auto.reason.remoteWrite', { command: head }),
        grantPrefix: [head],
      }
    }
    if ((a === '-o' || a === '--output' || a === '-O') && args[i + 1] && a !== '-O') {
      const outFile = args[i + 1]!
      const sensitive = isSensitiveWritePath(outFile, ctx.cwd, platform, home)
      if (sensitive.sensitive) {
        return {
          safe: false,
          risk: 'destructive',
          reason: t('antigravity.auto.reason.sensitiveWrite', { target: sensitive.label }),
          grantPrefix: null,
        }
      }
      if (!isInSafeWriteArea(outFile, ctx)) {
        return {
          safe: false,
          risk: 'risky',
          reason: t('antigravity.auto.reason.outsideWrite', { target: outFile }),
          grantPrefix: null,
        }
      }
    }
  }
  return SAFE_VERDICT
}

const PUBLISH_SUBCOMMANDS = new Set([
  'publish',
  'unpublish',
  'deprecate',
  'owner',
  'token',
  'access',
  'adduser',
  'login',
  'logout',
  'dist-tag',
])

function evaluatePackageToolCommand(
  head: string,
  args: readonly string[],
  heredocBody: string | null,
  ctx: AgyEvalContext,
  depth: number,
): CommandVerdict {
  if (head === 'npx' || head === 'pnpx' || head === 'bunx' || head === 'uvx') {
    const idx = args.findIndex(
      (a) => !['--', '-y', '--yes', '-q', '--quiet', '--silent'].includes(a),
    )
    if (idx === -1) return SAFE_VERDICT
    const pkg = args[idx]!.replace(/(.)@[^/]*$/, '$1')
    return evaluateClauseWords([pkg, ...args.slice(idx + 1)], heredocBody, ctx, depth + 1)
  }
  const sub = args.find((a) => !a.startsWith('-'))
  if (!sub) return SAFE_VERDICT
  if (PUBLISH_SUBCOMMANDS.has(sub)) {
    return {
      safe: false,
      risk: sub === 'publish' || sub === 'unpublish' ? 'destructive' : 'risky',
      reason: t('antigravity.auto.reason.remoteIrreversible', { command: `${head} ${sub}` }),
      grantPrefix: null,
    }
  }
  const subIndex = args.indexOf(sub)
  if (
    (head === 'pnpm' || head === 'yarn' || head === 'npm') &&
    (sub === 'exec' || sub === 'dlx' || sub === 'x')
  ) {
    const rest = args.slice(subIndex + 1)
    if (rest.length > 0) return evaluateClauseWords(rest, heredocBody, ctx, depth + 1)
  }
  if ((head === 'uv' || head === 'poetry') && sub === 'run') {
    const rest = args.slice(subIndex + 1)
    if (rest.length > 0) return evaluateClauseWords(rest, heredocBody, ctx, depth + 1)
  }
  return SAFE_VERDICT
}

function evaluateDefaultsCommand(args: readonly string[]): CommandVerdict {
  const sub = args[0]
  if (!sub || sub === 'read' || sub === 'read-type' || sub === 'domains' || sub === 'find') {
    return SAFE_VERDICT
  }
  return {
    safe: false,
    risk: sub === 'delete' ? 'destructive' : 'risky',
    reason: t('antigravity.auto.reason.systemMutation', { command: `defaults ${sub}` }),
    grantPrefix: null,
  }
}

function evaluateBrewCommand(args: readonly string[]): CommandVerdict {
  const sub = args[0]
  if (
    !sub ||
    sub.startsWith('-') ||
    [
      'list',
      'ls',
      'info',
      'search',
      'deps',
      'uses',
      'leaves',
      'outdated',
      'config',
      'doctor',
      'shellenv',
    ].includes(sub)
  ) {
    return SAFE_VERDICT
  }
  if (
    sub === 'uninstall' ||
    sub === 'remove' ||
    sub === 'rm' ||
    sub === 'zap' ||
    sub === 'cleanup'
  ) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.destructiveCommand', { command: `brew ${sub}` }),
      grantPrefix: null,
    }
  }
  return {
    safe: false,
    risk: 'risky',
    reason: t('antigravity.auto.reason.systemMutation', { command: `brew ${sub}` }),
    grantPrefix: ['brew', sub],
  }
}

const INFRA_READONLY = new Set([
  'ps',
  'images',
  'logs',
  'inspect',
  'get',
  'describe',
  'status',
  'list',
  'ls',
  'version',
  'info',
  'plan',
  'whoami',
  'tail',
  'validate',
  'fmt',
  'show',
  'diff',
  'top',
  'events',
  'stats',
])
const INFRA_DESTRUCTIVE = new Set([
  'rm',
  'rmi',
  'prune',
  'delete',
  'destroy',
  'uninstall',
  'down',
  'kill',
])

function evaluateInfraCommand(head: string, args: readonly string[]): CommandVerdict {
  const sub = args.find((a) => !a.startsWith('-'))
  if (!sub || INFRA_READONLY.has(sub)) return SAFE_VERDICT
  if (sub === 'system' && args.includes('prune')) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.destructiveCommand', { command: `${head} system prune` }),
      grantPrefix: null,
    }
  }
  if (sub === 'volume' && args.includes('rm')) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.destructiveCommand', { command: `${head} volume rm` }),
      grantPrefix: null,
    }
  }
  if (INFRA_DESTRUCTIVE.has(sub)) {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.destructiveCommand', { command: `${head} ${sub}` }),
      grantPrefix: null,
    }
  }
  if (sub === 'deploy' || sub === 'publish' || sub === 'apply') {
    return {
      safe: false,
      risk: 'destructive',
      reason: t('antigravity.auto.reason.remoteIrreversible', { command: `${head} ${sub}` }),
      grantPrefix: null,
    }
  }
  return {
    safe: false,
    risk: 'risky',
    reason: t('antigravity.auto.reason.remoteWrite', { command: `${head} ${sub}` }),
    grantPrefix: [head, sub],
  }
}

function evaluateSqliteCommand(args: readonly string[]): CommandVerdict {
  if (args.includes('-readonly')) return SAFE_VERDICT
  const joined = args.join(' ')
  if (/\b(?:DROP|DELETE|UPDATE|INSERT|ALTER|REPLACE|VACUUM|ATTACH)\b/i.test(joined)) {
    return {
      safe: false,
      risk: /\b(?:DROP|DELETE)\b/i.test(joined) ? 'destructive' : 'risky',
      reason: t('antigravity.auto.reason.destructiveCommand', { command: 'sqlite3' }),
      grantPrefix: null,
    }
  }
  return SAFE_VERDICT
}

// ---------------------------------------------------------------------------
// 第三方 MCP 工具与网页 URL 风险评估
// ---------------------------------------------------------------------------

/** 将 MCP 工具名拆分为小写词元（支持 snake_case、kebab-case 与 camelCase）。 */
function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** 从 `mcp_<server>_<tool>` 提取 `<server>` 和 `<tool>`（若无法唯一拆分则将整段作为工具部分）。 */
function splitMcpName(agyName: string): { server: string; tool: string } {
  const rest = agyName.slice('mcp_'.length)
  const sep = rest.indexOf('_')
  if (sep <= 0) return { server: '', tool: rest }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 1) }
}

/** 后台管理、生产、计费或密钥库类 MCP 服务器名特征：此类服务仅自动放行明确只读工具。 */
const SENSITIVE_MCP_SERVER =
  /(?:^|[-_])(?:admin|prod|production|billing|payment|finance|vault|secrets?)(?:$|[-_])/i

/** 尝试从 ACP toolCall._meta 读取可选的 MCP annotations 注解。 */
function hintsFromToolCall(toolCall: acp.ToolCallUpdate): McpToolHints | undefined {
  const meta = record(toolCall._meta)
  const ann = record(meta?.annotations) ?? record(meta?.mcpAnnotations)
  if (!ann) return undefined
  return {
    ...(typeof ann.readOnlyHint === 'boolean' ? { readOnlyHint: ann.readOnlyHint } : {}),
    ...(typeof ann.destructiveHint === 'boolean' ? { destructiveHint: ann.destructiveHint } : {}),
    ...(typeof ann.idempotentHint === 'boolean' ? { idempotentHint: ann.idempotentHint } : {}),
    ...(typeof ann.openWorldHint === 'boolean' ? { openWorldHint: ann.openWorldHint } : {}),
  }
}

/** 评估外部/第三方 MCP 工具在 Auto 模式下的安全性。 */
function evaluateExternalMcp(
  agyName: string,
  toolCall: acp.ToolCallUpdate,
  ctx: AgyEvalContext,
): AgyAutoDecision {
  const { server, tool } = splitMcpName(agyName)
  const displayLabel = server ? `${server}/${tool}` : agyName
  const tokens = tokenizeToolName(tool)
  const hints = ctx.mcpHints?.get(agyName) ?? hintsFromToolCall(toolCall)

  const hasDestructive =
    hints?.destructiveHint === true || tokens.some((tok) => MCP_DESTRUCTIVE_TOKENS.has(tok))
  if (hasDestructive) {
    return {
      action: 'ask',
      risk: 'destructive',
      reason: t('antigravity.auto.reason.mcpDestructive', { tool: displayLabel }),
      sessionGrant: null,
    }
  }

  const hasSensitive = tokens.some((tok) => MCP_SENSITIVE_TOKENS.has(tok))
  if (hasSensitive) {
    return {
      action: 'ask',
      risk: 'risky',
      reason: t('antigravity.auto.reason.mcpSensitive', { tool: displayLabel }),
      sessionGrant: { kind: 'mcp_tool', tool: agyName, label: displayLabel },
    }
  }

  if (hints?.readOnlyHint === true) {
    return { action: 'allow', source: 'auto' }
  }

  const first = tokens[0]
  if (first !== undefined && MCP_READONLY_TOKENS.has(first)) {
    return { action: 'allow', source: 'auto' }
  }

  // 管理后台/生产/计费类 MCP 服务器的写操作必须经用户确认（可按单工具记住本会话允许）。
  if (SENSITIVE_MCP_SERVER.test(server)) {
    return {
      action: 'ask',
      risk: 'risky',
      reason: t('antigravity.auto.reason.mcpSensitive', { tool: displayLabel }),
      sessionGrant: { kind: 'mcp_tool', tool: agyName, label: displayLabel },
    }
  }

  if (first !== undefined && MCP_REVERSIBLE_TOKENS.has(first)) {
    return { action: 'allow', source: 'auto' }
  }

  return {
    action: 'ask',
    risk: 'risky',
    reason: t('antigravity.auto.reason.mcpUnknown', { tool: displayLabel }),
    sessionGrant: { kind: 'mcp_tool', tool: agyName, label: displayLabel },
  }
}

/** 评估网页读取工具 URL 是否属于公开安全地址。 */
function evaluateWebRead(toolCall: acp.ToolCallUpdate): AgyAutoDecision {
  const name = toolName(toolCall)
  if (name === 'search_web') return { action: 'allow', source: 'auto' }
  const input = record(toolCall.rawInput)
  const rawUrl =
    typeof input?.Url === 'string' ? input.Url : typeof input?.url === 'string' ? input.url : null
  if (!rawUrl) return { action: 'allow', source: 'auto' }
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        action: 'ask',
        risk: 'risky',
        reason: t('antigravity.auto.reason.sensitiveUrl'),
        sessionGrant: null,
      }
    }
    if (CLOUD_METADATA_HOSTS.has(parsed.hostname.toLowerCase())) {
      return {
        action: 'ask',
        risk: 'destructive',
        reason: t('antigravity.auto.reason.sensitiveUrl'),
        sessionGrant: null,
      }
    }
    return { action: 'allow', source: 'auto' }
  } catch {
    return {
      action: 'ask',
      risk: 'risky',
      reason: t('antigravity.auto.reason.sensitiveUrl'),
      sessionGrant: null,
    }
  }
}

/** 提取文件类工具调用涉及的所有路径。 */
function extractToolPaths(toolCall: acp.ToolCallUpdate): string[] {
  const paths = new Set<string>()
  for (const loc of toolCall.locations ?? []) {
    if (typeof loc.path === 'string' && loc.path.trim() !== '') paths.add(loc.path)
  }
  const input = record(toolCall.rawInput)
  if (input) {
    for (const key of [
      'Path',
      'TargetFile',
      'AbsolutePath',
      'DirectoryPath',
      'SearchPath',
      'SearchDirectory',
      'path',
    ]) {
      const value = input[key]
      if (typeof value === 'string' && value.trim() !== '') paths.add(value)
    }
  }
  return [...paths]
}

/** 检查当前工具调用是否命中用户在 agy settings.json 中显式配置的 permissions.ask 规则。 */
function matchesUserAskRules(toolCall: acp.ToolCallUpdate, ctx: AgyEvalContext): boolean {
  const rules = ctx.userAskRules
  if (!rules || rules.length === 0) return false
  const name = toolName(toolCall)
  if (!name) return false
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  const input = record(toolCall.rawInput)

  if (COMMAND_TOOLS.has(name) || name === TERMINAL_RUN_NAME) {
    const cmd =
      typeof input?.CommandLine === 'string'
        ? input.CommandLine
        : typeof input?.command === 'string'
          ? input.command
          : null
    if (!cmd) return false
    return rules.some(
      (r) =>
        (r.action === 'command' || r.action === 'unsandboxed') && matchesCommandRule(cmd, r.target),
    )
  }
  if (WRITE_TOOLS.has(name)) {
    const paths = extractToolPaths(toolCall)
    return paths.some((p) =>
      rules.some(
        (r) => r.action === 'write_file' && matchesPathRule(p, r.target, ctx.cwd, platform, home),
      ),
    )
  }
  if (READ_TOOLS.has(name)) {
    const paths = extractToolPaths(toolCall)
    return paths.some((p) =>
      rules.some(
        (r) => r.action === 'read_file' && matchesPathRule(p, r.target, ctx.cwd, platform, home),
      ),
    )
  }
  if (WEB_READ_TOOLS.has(name)) {
    const rawUrl =
      typeof input?.Url === 'string' ? input.Url : typeof input?.url === 'string' ? input.url : null
    if (!rawUrl) return false
    return rules.some(
      (r) =>
        (r.action === 'read_url' || r.action === 'execute_url') && matchesUrlRule(rawUrl, r.target),
    )
  }
  if (name.startsWith('mcp_')) {
    return rules.some((r) => r.action === 'mcp' && matchesMcpRule(name, r.target))
  }
  return false
}

// ---------------------------------------------------------------------------
// 统一入口：evaluateAgyPermission
// ---------------------------------------------------------------------------

/**
 * 评估 agy 经 ACP 发来的单次 `session/request_permission` 请求。
 *
 * 1. 全模式白名单（Kettu 内部管理/只读工具与网关说明查询）始终直接放行；
 * 2. 命中本会话用户已点的「本会话总是允许」规则时直接放行；
 * 3. 非 Auto 模式下不自动放行，但对非高危请求仍可提供「本会话总是允许」选项；
 * 4. Auto 模式下优先尊重用户 settings.json 的 `permissions.ask`，其余按文件、命令、网页与 MCP 风险引擎判定。
 */
export function evaluateAgyPermission(
  toolCall: acp.ToolCallUpdate,
  ctx: AgyEvalContext,
): AgyAutoDecision {
  const name = toolName(toolCall)
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  const allowed = ctx.allowed

  // 1. 全模式无条件放行（Kettu 预批准只读与内部管理工具、网关查询）。
  if (name !== null && allowed) {
    const lookup = describesOnly(toolCall) && allowed.always.has(`${OWN_PREFIX}${GUIDE_TOOL}`)
    if (lookup || allowed.always.has(name)) {
      return { action: 'allow', source: 'always' }
    }
  }

  // 2. 命中用户在当前会话主动授予的「本会话总是允许」规则。
  if (ctx.sessionGrants && matchesSessionGrant(toolCall, ctx)) {
    return { action: 'allow', source: 'session_grant' }
  }

  // 3. 非 Auto 模式：不替用户自动批准，但计算风险等级与可用的「本会话总是允许」选项。
  if (!ctx.autoMode) {
    return evaluateAskMetadata(toolCall, ctx)
  }

  // 4. Auto 模式下，若命中用户自己在 agy settings.json 中配置的 permissions.ask，绝不绕过。
  if (matchesUserAskRules(toolCall, ctx)) {
    const meta = evaluateAskMetadata(toolCall, ctx)
    return {
      action: 'ask',
      risk: meta.action === 'ask' ? meta.risk : 'risky',
      reason: t('antigravity.auto.reason.userRule'),
      sessionGrant: meta.action === 'ask' ? meta.sessionGrant : null,
    }
  }

  if (name === null) {
    return { action: 'ask', risk: 'risky', sessionGrant: null }
  }

  // 5. Kettu 内置 MCP 工具。
  if (name.startsWith(OWN_PREFIX)) {
    if (allowed?.onAuto.has(name)) {
      return { action: 'allow', source: 'auto' }
    }
    if (name === TERMINAL_RUN_NAME && allowed?.hasKettu) {
      const command = record(toolCall.rawInput)?.command
      if (typeof command !== 'string' || command.trim() === '') {
        return { action: 'ask', risk: 'risky', sessionGrant: null }
      }
      const verdict = evaluateAgyCommand(command, ctx)
      if (verdict.safe) return { action: 'allow', source: 'auto' }
      return {
        action: 'ask',
        risk: verdict.risk,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        sessionGrant: verdict.grantPrefix
          ? {
              kind: 'command_prefix',
              prefix: verdict.grantPrefix,
              display: verdict.grantPrefix.join(' '),
            }
          : null,
      }
    }
    if (name === DELETE_ARTIFACT_NAME) {
      return {
        action: 'ask',
        risk: 'destructive',
        reason: t('antigravity.auto.reason.deleteArtifact'),
        sessionGrant: null,
      }
    }
    if (name === TERMINAL_INPUT_NAME) {
      return {
        action: 'ask',
        risk: 'risky',
        reason: t('antigravity.auto.reason.terminalInput'),
        sessionGrant: null,
      }
    }
    if (name.startsWith(COMPUTER_PREFIX)) {
      return {
        action: 'ask',
        risk: 'risky',
        reason: t('antigravity.auto.reason.computerControl'),
        sessionGrant: null,
      }
    }
    if (name === WRITE_ARTIFACT_DATA_NAME) {
      return {
        action: 'ask',
        risk: 'risky',
        reason: t('antigravity.auto.reason.writeArtifactData'),
        sessionGrant: { kind: 'mcp_tool', tool: name, label: name.slice(OWN_PREFIX.length) },
      }
    }
    return { action: 'ask', risk: 'risky', sessionGrant: null }
  }

  // 6. 第三方 / 插件 MCP 工具。
  if (name.startsWith('mcp_')) {
    return evaluateExternalMcp(name, toolCall, ctx)
  }

  // 7. 删除类工具：一律 destructive 拦截，绝不提供本会话允许。
  if (DELETE_TOOLS.has(name) || toolCall.kind === 'delete') {
    const paths = extractToolPaths(toolCall)
    const core = paths.find((p) => isCoreProjectPath(p, ctx.cwd, platform, home))
    return {
      action: 'ask',
      risk: 'destructive',
      reason: core
        ? t('antigravity.auto.reason.deleteCore', { target: core })
        : t('antigravity.auto.reason.deleteFiles'),
      sessionGrant: null,
    }
  }

  // 8. 文件读取 / 搜索工具。
  if (READ_TOOLS.has(name)) {
    const paths = extractToolPaths(toolCall)
    for (const p of paths) {
      if (isSensitiveReadPath(p, ctx.cwd, platform, home)) {
        return {
          action: 'ask',
          risk: 'risky',
          reason: t('antigravity.auto.reason.sensitiveRead', { target: p }),
          sessionGrant: null,
        }
      }
    }
    return { action: 'allow', source: 'auto' }
  }

  // 9. 文件编辑 / 写入工具。
  if (WRITE_TOOLS.has(name)) {
    const paths = extractToolPaths(toolCall)
    if (paths.length === 0) {
      return { action: 'ask', risk: 'risky', sessionGrant: null }
    }
    for (const p of paths) {
      const sensitive = isSensitiveWritePath(p, ctx.cwd, platform, home)
      if (sensitive.sensitive) {
        return {
          action: 'ask',
          risk: 'destructive',
          reason: t('antigravity.auto.reason.sensitiveWrite', { target: sensitive.label }),
          sessionGrant: null,
        }
      }
    }
    const outside = paths.find((p) => !isInSafeWriteArea(p, ctx))
    if (outside) {
      const norm = normalizePath(outside, ctx.cwd, platform, home)
      const dir = path.posix.dirname(norm)
      return {
        action: 'ask',
        risk: 'risky',
        reason: t('antigravity.auto.reason.outsideWrite', { target: outside }),
        sessionGrant: {
          kind: 'write_dir',
          dir,
          displayDir: shortenHome(dir, home, platform),
        },
      }
    }
    return { action: 'allow', source: 'auto' }
  }

  // 10. 网页读取 / 搜索。
  if (WEB_READ_TOOLS.has(name)) {
    return evaluateWebRead(toolCall)
  }

  // 11. 终端命令执行（run_command）。
  if (COMMAND_TOOLS.has(name) || typeof record(toolCall.rawInput)?.CommandLine === 'string') {
    const command = record(toolCall.rawInput)?.CommandLine
    if (typeof command !== 'string' || command.trim() === '') {
      return { action: 'ask', risk: 'risky', sessionGrant: null }
    }
    const verdict = evaluateAgyCommand(command, ctx)
    if (verdict.safe) return { action: 'allow', source: 'auto' }
    return {
      action: 'ask',
      risk: verdict.risk,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      sessionGrant: verdict.grantPrefix
        ? {
            kind: 'command_prefix',
            prefix: verdict.grantPrefix,
            display: verdict.grantPrefix.join(' '),
          }
        : null,
    }
  }

  // 12. 其他未知工具：保守交由用户审批。
  return { action: 'ask', risk: 'risky', sessionGrant: null }
}

/** 在非 Auto 模式（或命中用户规则）时，评估请求的风险级别和是否可提供「本会话总是允许」。 */
function evaluateAskMetadata(toolCall: acp.ToolCallUpdate, ctx: AgyEvalContext): AgyAutoDecision {
  const name = toolName(toolCall)
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()
  if (!name) return { action: 'ask', risk: 'risky', sessionGrant: null }

  if (DELETE_TOOLS.has(name) || toolCall.kind === 'delete') {
    return { action: 'ask', risk: 'destructive', sessionGrant: null }
  }
  if (WRITE_TOOLS.has(name)) {
    const paths = extractToolPaths(toolCall)
    const sensitive = paths.find((p) => isSensitiveWritePath(p, ctx.cwd, platform, home).sensitive)
    if (sensitive) {
      const info = isSensitiveWritePath(sensitive, ctx.cwd, platform, home)
      return {
        action: 'ask',
        risk: 'destructive',
        reason: t('antigravity.auto.reason.sensitiveWrite', { target: info.label }),
        sessionGrant: null,
      }
    }
    const first = paths[0]
    if (!first) return { action: 'ask', risk: 'safe', sessionGrant: null }
    const norm = normalizePath(first, ctx.cwd, platform, home)
    const dir = path.posix.dirname(norm)
    return {
      action: 'ask',
      risk: isInSafeWriteArea(first, ctx) ? 'safe' : 'risky',
      sessionGrant: {
        kind: 'write_dir',
        dir,
        displayDir: shortenHome(dir, home, platform),
      },
    }
  }
  if (COMMAND_TOOLS.has(name) || name === TERMINAL_RUN_NAME) {
    const input = record(toolCall.rawInput)
    const cmd =
      typeof input?.CommandLine === 'string'
        ? input.CommandLine
        : typeof input?.command === 'string'
          ? input.command
          : null
    if (!cmd) return { action: 'ask', risk: 'risky', sessionGrant: null }
    const verdict = evaluateAgyCommand(cmd, ctx)
    if (verdict.safe) {
      const parsed = parseShellCommand(
        cmd,
        ctx.shell ?? (platform === 'win32' ? 'powershell' : 'posix'),
      )
      const single =
        !parsed.unparseable && parsed.clauses.length === 1 && parsed.substitutions.length === 0
          ? parsed.clauses[0]!.words
          : null
      const prefix = single ? safePrefixOf(single) : null
      return {
        action: 'ask',
        risk: 'safe',
        sessionGrant: prefix ? { kind: 'command_prefix', prefix, display: prefix.join(' ') } : null,
      }
    }
    return {
      action: 'ask',
      risk: verdict.risk,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      sessionGrant: verdict.grantPrefix
        ? {
            kind: 'command_prefix',
            prefix: verdict.grantPrefix,
            display: verdict.grantPrefix.join(' '),
          }
        : null,
    }
  }
  if (name.startsWith('mcp_') && !name.startsWith(OWN_PREFIX)) {
    const ext = evaluateExternalMcp(name, toolCall, ctx)
    if (ext.action === 'ask') return ext
    const { server, tool } = splitMcpName(name)
    return {
      action: 'ask',
      risk: 'safe',
      sessionGrant: { kind: 'mcp_tool', tool: name, label: server ? `${server}/${tool}` : name },
    }
  }
  return { action: 'ask', risk: 'safe', sessionGrant: null }
}

/** 检查当前请求是否已由本会话授权记忆覆盖（仍严格阻止敏感/高危路径与命令）。 */
function matchesSessionGrant(toolCall: acp.ToolCallUpdate, ctx: AgyEvalContext): boolean {
  const grants = ctx.sessionGrants
  const name = toolName(toolCall)
  if (!grants || !name) return false
  const platform = ctx.platform ?? (process.platform as Platform)
  const home = ctx.homeDir ?? os.homedir()

  if (name.startsWith('mcp_') && grants.allowsMcp(name)) {
    return true
  }
  if (WRITE_TOOLS.has(name)) {
    const paths = extractToolPaths(toolCall)
    if (paths.length === 0) return false
    return paths.every((p) => {
      if (isSensitiveWritePath(p, ctx.cwd, platform, home).sensitive) return false
      return grants.allowsWrite(normalizePath(p, ctx.cwd, platform, home))
    })
  }
  if (COMMAND_TOOLS.has(name) || name === TERMINAL_RUN_NAME) {
    const input = record(toolCall.rawInput)
    const cmd =
      typeof input?.CommandLine === 'string'
        ? input.CommandLine
        : typeof input?.command === 'string'
          ? input.command
          : null
    if (!cmd) return false
    const shell = ctx.shell ?? (platform === 'win32' ? 'powershell' : 'posix')
    const parsed = parseShellCommand(cmd, shell)
    if (parsed.unparseable || parsed.clauses.length !== 1 || parsed.substitutions.length > 0) {
      return false
    }
    const clause = parsed.clauses[0]!
    if (clause.writeRedirects.length > 0 || clause.readRedirects.length > 0) return false
    // 即便命中命令前缀，仍绝不允许带有 destructive 风险的命令绕过审批（如 git push --force）。
    const verdict = evaluateAgyCommand(cmd, ctx)
    if (!verdict.safe && verdict.risk === 'destructive') return false
    return grants.allowsCommandWords(clause.words)
  }
  return false
}

/** 为单条安全命令提取简洁的本会话授权前缀（例如 `pnpm test` 或 `git status`）。 */
function safePrefixOf(words: readonly string[]): readonly string[] | null {
  const clean = words.filter((w) => !ENV_ASSIGN.test(w))
  if (clean.length === 0) return null
  const head = clean[0]!
  if (/[$`*?[\]]/.test(head)) return null
  const second = clean[1]
  if (second && !second.startsWith('-') && !/[$`*?[\]/\\]/.test(second)) {
    return [head, second]
  }
  return [head]
}

function shortenHome(normalizedDir: string, homeDir: string, platform: Platform): string {
  const normHome = normalizePath(homeDir, null, platform, homeDir)
  if (isInsideDir(normalizedDir, normHome, platform)) {
    const rest = normalizedDir.slice(normHome.length)
    return rest === '' ? '~' : `~${rest}`
  }
  return normalizedDir
}
