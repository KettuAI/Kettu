// Hand-written guards for every request on the agent host port. A validator returns a fresh
// params object with only the known fields, or throws `invalid_params` before anything runs.

import type { AgentInstallMethod, HostMethod, HostParams } from '@shared/agent-host'
import { FILE_READ_LIMIT } from '@shared/files'
import { GITHUB_PULL_REQUEST_URL, isRepositoryName } from '@shared/git'
import type { Platform } from '@shared/platform'
import { AGENT_IDS, type AgentId, type ContentRef, type UserContent } from '@shared/thread'
import { invalidParams } from './errors'
import { isAbsolutePath } from './paths'

export const PROMPT_BYTES = 10 * 1024 * 1024
const ID_CHARS = 256
const ACP_ID_CHARS = 1_024
// Windows extended-length paths go up to 32,767 characters.
const PATH_CHARS = 32_767
const TEXT_CHARS = 4_096
const URL_CHARS = 2_048
const PROMPT_ITEMS = 1_000
const INSTALL_METHODS: ReadonlySet<unknown> = new Set<AgentInstallMethod['id']>([
  'brew',
  'script',
  'npm',
])

type Fields = Record<string, unknown>

function fields(params: unknown): Fields {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalidParams('params must be an object')
  }
  return params as Fields
}

function none(params: unknown): void {
  if (params === undefined || params === null) return
  if (Object.keys(fields(params)).length > 0) throw invalidParams('This method takes no params')
}

function string(o: Fields, key: string, max: number): string {
  const value = o[key]
  if (typeof value !== 'string') throw invalidParams(`${key} must be a string`)
  if (value.length === 0) throw invalidParams(`${key} must not be empty`)
  if (value.length > max) throw invalidParams(`${key} is longer than ${max} characters`)
  return value
}

function optionalString(o: Fields, key: string, max: number): string | undefined {
  return o[key] === undefined ? undefined : string(o, key, max)
}

function agentId(o: Fields, key = 'agentId'): AgentId {
  const value = string(o, key, ID_CHARS)
  if (!(AGENT_IDS as readonly string[]).includes(value))
    throw invalidParams(`Unknown agent ${value}`)
  return value as AgentId
}

const CONFIG_VALUES = 64

/** Config values by option id, as `sessions.setConfigOption` takes them one at a time. */
function configValues(value: unknown): Record<string, string | boolean> {
  const o = fields(value)
  const entries = Object.entries(o)
  if (entries.length > CONFIG_VALUES)
    throw invalidParams(`options holds more than ${CONFIG_VALUES}`)
  const values: Record<string, string | boolean> = {}
  for (const [id, v] of entries) {
    if (id.length === 0 || id.length > ID_CHARS) throw invalidParams('An option id is too long')
    if (
      typeof v === 'boolean' ||
      (typeof v === 'string' && v.length > 0 && v.length <= TEXT_CHARS)
    ) {
      values[id] = v
    } else {
      throw invalidParams(`options.${id} must be 1 to ${TEXT_CHARS} characters or a boolean`)
    }
  }
  return values
}

function absolutePath(o: Fields, key: string, platform: Platform): string {
  const value = string(o, key, PATH_CHARS)
  if (value.includes('\0')) throw invalidParams(`${key} contains a NUL character`)
  if (!isAbsolutePath(value, platform)) throw invalidParams(`${key} must be an absolute path`)
  return value
}

function relativePath(o: Fields, key: string, platform: Platform): string {
  const value = string(o, key, PATH_CHARS)
  if (value.includes('\0')) throw invalidParams(`${key} contains a NUL character`)
  if (isAbsolutePath(value, platform) || value.startsWith('/') || value.startsWith('\\')) {
    throw invalidParams(`${key} must be a relative path`)
  }
  return value
}

/** A commit id, full or abbreviated. */
function objectId(o: Fields, key: string): string {
  const value = string(o, key, 64)
  if (!/^[0-9a-f]{4,64}$/i.test(value)) throw invalidParams(`${key} must be a commit id`)
  return value
}

/** A path as git prints it: relative to the repository root, with forward slashes. */
function gitPath(o: Fields, key: string): string {
  const value = string(o, key, PATH_CHARS)
  if (value.includes('\0')) throw invalidParams(`${key} contains a NUL character`)
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) {
    throw invalidParams(`${key} must be a path inside the repository`)
  }
  return value
}

// A remote or branch name that cannot read as an option or carry a refspec's punctuation.
function refName(o: Fields, key: string): string {
  const value = string(o, key, ID_CHARS)
  if (value === '' || value.startsWith('-') || /[\s~^:?*[\\\0]/.test(value)) {
    throw invalidParams(`${key} is not a branch or remote name`)
  }
  return value
}

function position(o: Fields, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidParams(`${key} must be a position, a whole number from 0`)
  }
  return value
}

function time(o: Fields, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidParams(`${key} must be a time in ms, a whole number from 0`)
  }
  return value
}

// Fifty years of days, past any history an agent keeps.
const USAGE_DAYS = 18_263

function dayStarts(o: Fields): number[] {
  const value = o.dayStarts
  if (!Array.isArray(value) || value.length > USAGE_DAYS + 1) {
    throw invalidParams(`dayStarts must be an array of at most ${USAGE_DAYS + 1} times`)
  }
  const days = value.map((day: unknown, index) => {
    if (typeof day !== 'number' || !Number.isSafeInteger(day) || day < 0) {
      throw invalidParams(`dayStarts[${index}] must be a time in ms`)
    }
    return day
  })
  if (days.some((day, index) => index > 0 && day <= days[index - 1]!)) {
    throw invalidParams('dayStarts must ascend')
  }
  return days
}

function range(o: Fields): { from: number; to: number } {
  const from = time(o, 'from')
  const to = time(o, 'to')
  if (to < from) throw invalidParams('to must not be before from')
  return { from, to }
}

function sessionId(o: Fields): string {
  return string(o, 'sessionId', ID_CHARS)
}

const IMAGE_MIME = /^image\/[a-z0-9][a-z0-9.+-]*$/i
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function contentRef(value: unknown, at: string): { ref: ContentRef; bytes: number } {
  const o = fields(value)
  switch (o.kind) {
    case 'image': {
      const mimeType = string(o, 'mimeType', ID_CHARS)
      if (!IMAGE_MIME.test(mimeType)) throw invalidParams(`${at}: ${mimeType} is not an image type`)
      const data = o.data
      if (typeof data !== 'string' || data.length === 0 || !BASE64.test(data)) {
        throw invalidParams(`${at}: image data must be base64`)
      }
      return { ref: { kind: 'image', mimeType, data }, bytes: data.length }
    }
    case 'link': {
      const uri = string(o, 'uri', PATH_CHARS)
      const name = string(o, 'name', TEXT_CHARS)
      return { ref: { kind: 'link', uri, name }, bytes: uri.length + name.length }
    }
    default:
      throw invalidParams(`${at}: a prompt can carry images and links only`)
  }
}

/** Prompt content: texts, images and links, at most 10 MB in all, and not empty. */
export function promptContent(value: unknown): UserContent[] {
  if (!Array.isArray(value)) throw invalidParams('content must be an array')
  if (value.length > PROMPT_ITEMS)
    throw invalidParams(`content has more than ${PROMPT_ITEMS} items`)
  const out: UserContent[] = []
  let bytes = 0
  let substance = false
  value.forEach((item: unknown, index) => {
    const at = `content[${index}]`
    const o = fields(item)
    if (o.type === 'text') {
      if (typeof o.text !== 'string') throw invalidParams(`${at}.text must be a string`)
      bytes += Buffer.byteLength(o.text, 'utf8')
      if (o.text.trim() !== '') substance = true
      out.push({ type: 'text', text: o.text })
    } else if (o.type === 'ref') {
      const { ref, bytes: size } = contentRef(o.ref, at)
      bytes += size
      substance = true
      out.push({ type: 'ref', ref })
    } else {
      throw invalidParams(`${at}.type must be text or ref`)
    }
    if (bytes > PROMPT_BYTES) throw invalidParams('The prompt is larger than 10 MB')
  })
  if (!substance) throw invalidParams('The prompt is empty')
  return out
}

type Validators = { [M in HostMethod]: (params: unknown) => HostParams<M> }

export function createValidators(platform: Platform): Validators {
  const project = (params: unknown): { projectPath: string } => ({
    projectPath: absolutePath(fields(params), 'projectPath', platform),
  })
  const folder = (params: unknown): { path: string } => ({
    path: absolutePath(fields(params), 'path', platform),
  })
  const session = (params: unknown): { sessionId: string } => ({
    sessionId: sessionId(fields(params)),
  })
  const agent = (params: unknown): { agentId: AgentId } => ({ agentId: agentId(fields(params)) })
  const queueItem = (params: unknown): { sessionId: string; itemId: string } => {
    const o = fields(params)
    return { sessionId: sessionId(o), itemId: string(o, 'itemId', ID_CHARS) }
  }

  return {
    'agents.list': none,
    'agents.check': (params) => {
      const o = params === undefined || params === null ? {} : fields(params)
      return o.agentId === undefined ? {} : { agentId: agentId(o) }
    },
    'agents.reloadEnvironment': none,
    'agents.environment': none,
    'agents.authenticate': (params) => {
      const o = fields(params)
      return { agentId: agentId(o), methodId: string(o, 'methodId', ID_CHARS) }
    },
    'agents.logout': agent,
    'agents.retry': agent,
    'agents.reinstall': agent,
    'agents.checkUpdates': none,
    'agents.update': agent,
    'agents.install': (params) => {
      const o = fields(params)
      const method = o.method
      if (method !== undefined && !INSTALL_METHODS.has(method)) {
        throw invalidParams('method must be brew, script or npm')
      }
      return {
        agentId: agentId(o),
        ...(method !== undefined ? { method: method as AgentInstallMethod['id'] } : {}),
      }
    },
    'agents.cancelTask': agent,
    'agents.start': agent,
    'agents.refreshLimits': agent,
    'agents.details': agent,
    'agents.refreshAccount': agent,
    'agents.options': none,
    'agents.listSessions': (params) => {
      const o = fields(params)
      const cursor = optionalString(o, 'cursor', TEXT_CHARS)
      return {
        agentId: agentId(o),
        projectPath: absolutePath(o, 'projectPath', platform),
        ...(cursor !== undefined ? { cursor } : {}),
      }
    },
    'projects.list': none,
    'projects.add': folder,
    'projects.remove': folder,
    'projects.touch': folder,
    'sessions.list': (params) => {
      const o = params === undefined || params === null ? {} : fields(params)
      return o.projectPath === undefined
        ? {}
        : { projectPath: absolutePath(o, 'projectPath', platform) }
    },
    'sessions.create': (params) => {
      const o = fields(params)
      const parentId = optionalString(o, 'parentId', ID_CHARS)
      const options = o.options === undefined ? undefined : configValues(o.options)
      return {
        agentId: agentId(o),
        // null: no project, so the host makes a scratch folder.
        projectPath: o.projectPath === null ? null : absolutePath(o, 'projectPath', platform),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(options !== undefined ? { options } : {}),
      }
    },
    'sessions.import': (params) => {
      const o = fields(params)
      return {
        agentId: agentId(o),
        projectPath: absolutePath(o, 'projectPath', platform),
        acpSessionId: string(o, 'acpSessionId', ACP_ID_CHARS),
      }
    },
    'sessions.open': session,
    'sessions.snapshot': (params) => {
      const o = fields(params)
      return {
        sessionId: sessionId(o),
        ...(o.from === undefined ? {} : { from: position(o, 'from') }),
      }
    },
    'sessions.page': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), before: position(o, 'before') }
    },
    'sessions.watch': session,
    'sessions.unwatch': session,
    'sessions.show': (params) => {
      const o = fields(params)
      return { sessionId: o.sessionId === null ? null : sessionId(o) }
    },
    'sessions.prompt': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), content: promptContent(o.content) }
    },
    'sessions.cancel': session,
    'sessions.retry': session,
    'sessions.fork': session,
    'sessions.context': session,
    'sessions.queue': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), content: promptContent(o.content) }
    },
    'sessions.unqueue': queueItem,
    'sessions.steer': queueItem,
    'sessions.resumeQueue': session,
    'sessions.setConfigOption': (params) => {
      const o = fields(params)
      const value = o.value
      if (typeof value !== 'boolean' && typeof value !== 'string') {
        throw invalidParams('value must be a string or a boolean')
      }
      if (typeof value === 'string' && (value.length === 0 || value.length > TEXT_CHARS)) {
        throw invalidParams(`value must be 1 to ${TEXT_CHARS} characters`)
      }
      return { sessionId: sessionId(o), optionId: string(o, 'optionId', ID_CHARS), value }
    },
    'sessions.rename': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), title: o.title === null ? null : string(o, 'title', 200) }
    },
    'sessions.close': session,
    'sessions.delete': session,
    'sessions.removeAll': none,
    'permissions.respond': (params) => {
      const o = fields(params)
      return {
        sessionId: sessionId(o),
        requestId: string(o, 'requestId', ID_CHARS),
        optionId: string(o, 'optionId', ID_CHARS),
      }
    },
    'diagnostics.collect': none,
    'git.status': project,
    'git.unwatch': project,
    'git.fetch': project,
    'git.pull': project,
    'git.push': (params) => {
      const o = fields(params)
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        remote: refName(o, 'remote'),
        branch: refName(o, 'branch'),
      }
    },
    'git.publish': (params) => {
      const o = fields(params)
      const name = string(o, 'name', 100)
      if (!isRepositoryName(name)) {
        throw invalidParams('name is not a repository name')
      }
      if (o.visibility !== 'private' && o.visibility !== 'public') {
        throw invalidParams('visibility must be private or public')
      }
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        name,
        visibility: o.visibility,
      }
    },
    'git.createPullRequest': (params) => {
      const o = fields(params)
      const title = string(o, 'title', 256)
      if (title.trim() === '') throw invalidParams('title must not be blank')
      const body = o.body === '' ? '' : string(o, 'body', 65_536)
      const base = refName(o, 'base')
      if (typeof o.draft !== 'boolean') throw invalidParams('draft must be a boolean')
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        title,
        body,
        base,
        draft: o.draft,
      }
    },
    'git.commit': (params) => {
      const o = fields(params)
      return { projectPath: absolutePath(o, 'projectPath', platform), oid: objectId(o, 'oid') }
    },
    'git.changes': project,
    'git.incoming': (params) => {
      const o = fields(params)
      if (o.from !== 'upstream' && o.from !== 'base')
        throw invalidParams('from must be upstream or base')
      return { projectPath: absolutePath(o, 'projectPath', platform), from: o.from }
    },
    'git.fileDiff': (params) => {
      const o = fields(params)
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        path: gitPath(o, 'path'),
        oldPath: o.oldPath === null || o.oldPath === undefined ? null : gitPath(o, 'oldPath'),
        ref: o.ref === null || o.ref === undefined ? null : objectId(o, 'ref'),
      }
    },
    'git.pullRequest': (params) => {
      const url = string(fields(params), 'url', URL_CHARS)
      if (!GITHUB_PULL_REQUEST_URL.test(url))
        throw invalidParams('url is not a GitHub pull request')
      return { url }
    },
    'git.currentPullRequest': project,
    'git.tools': none,
    'usage.summary': (params) => {
      const o = fields(params)
      if (o.scope !== 'computer' && o.scope !== 'overbench') {
        throw invalidParams('scope must be computer or overbench')
      }
      return { dayStarts: dayStarts(o), ...range(o), scope: o.scope }
    },
    'usage.total': (params) => range(fields(params)),
    'usage.status': none,
    'usage.sync': none,
    'usage.reimport': agent,
    'usage.clearRecord': none,
    'files.list': project,
    'files.read': (params) => {
      const o = fields(params)
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        path: relativePath(o, 'path', platform),
      }
    },
    'files.search': (params) => {
      const o = fields(params)
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        query: string(o, 'query', TEXT_CHARS),
      }
    },
    'files.write': (params) => {
      const o = fields(params)
      // An empty file is text too, so `string` does not fit; the host checks the size in bytes.
      if (typeof o.text !== 'string') throw invalidParams('text must be a string')
      if (o.text.length > FILE_READ_LIMIT) throw invalidParams('text is larger than 1 MiB')
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        path: relativePath(o, 'path', platform),
        text: o.text,
        version: o.version === null ? null : string(o, 'version', ID_CHARS),
      }
    },
  }
}
