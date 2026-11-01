// Hand-written guards for every request on the agent host port. A validator returns a fresh
// params object with only the known fields, or throws `invalid_params` before anything runs.

import type { AgentInstallMethod, HostMethod, HostParams } from '@shared/agent-host'
import { ARTIFACT_ID, ARTIFACT_TITLE_CHARS, longer } from '@shared/artifacts'
import { FILE_READ_LIMIT } from '@shared/files'
import { GITHUB_LOGIN, GITHUB_PULL_REQUEST_URL, isRepositoryName } from '@shared/git'
import type { Platform } from '@shared/platform'
import {
  isPermissionScope,
  isSchedule,
  isTimeLimit,
  ROUTINE_ID,
  ROUTINE_NAME_CHARS,
  ROUTINE_OPTION_CHARS,
  ROUTINE_OPTION_LIMIT,
  PROMPT_CHARS,
  type RoutineChanges,
  type RoutineDraft,
  type RoutineOption,
} from '@shared/routines'
import { ATTACHMENT_BYTES, ATTACHMENT_LIMIT, PROMPT_BYTES, THUMB_CHARS } from '@shared/attachments'
import { isAgentId, type AgentId, type ContentRef, type UserContent } from '@shared/thread'
import { invalidParams } from './errors'
import { isCompletablePath } from './path-completion'
import { isAbsolutePath } from './paths'

const ID_CHARS = 256
const ACP_ID_CHARS = 1_024
// Windows extended-length paths go up to 32,767 characters.
const PATH_CHARS = 32_767
const TEXT_CHARS = 4_096
const URL_CHARS = 2_048
const PROMPT_ITEMS = 1_000
// Sessions with a draft, which the one-time removal keeps.
const KEPT_SESSIONS = 10_000
// The panes a split view shows at most, which a window reports as in front.
const SHOWN_SESSIONS = 9
// Attachments the drafts name, checked once at launch.
const HELD_ATTACHMENTS = 100_000
const INSTALL_METHODS: ReadonlySet<unknown> = new Set<AgentInstallMethod['id']>([
  'archive',
  'brew',
  'script',
  'winget',
  'npm',
])

type Fields = Record<string, unknown>

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
  if (!isAgentId(value)) throw invalidParams(`Unknown agent ${value}`)
  return value
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

function routineId(o: Fields, key = 'routineId'): string {
  const value = string(o, key, ID_CHARS)
  if (!ROUTINE_ID.test(value)) throw invalidParams(`${key} is not a routine id`)
  return value
}

/** A routine's option values, by id. */
function routineOptions(value: unknown): RoutineOption[] {
  if (!Array.isArray(value) || value.length > ROUTINE_OPTION_LIMIT) {
    throw invalidParams(`options must be a list of at most ${ROUTINE_OPTION_LIMIT}`)
  }
  return value.map((item: unknown, index) => {
    if (!isRecord(item)) throw invalidParams(`options[${index}] must be an object`)
    const option = fields(item)
    const id = string(option, 'id', ROUTINE_OPTION_CHARS)
    const v = option.value
    if (!(typeof v === 'boolean' || (typeof v === 'string' && v.length <= ROUTINE_OPTION_CHARS))) {
      throw invalidParams(
        `options[${index}].value must be a boolean or at most ${ROUTINE_OPTION_CHARS} characters`,
      )
    }
    return { id, value: v }
  })
}

function routineTrigger(value: unknown): {
  kind: 'schedule'
  schedule: import('@shared/routines').Schedule
} {
  if (!isRecord(value) || value.kind !== 'schedule' || !isSchedule(value.schedule)) {
    throw invalidParams('trigger must be a schedule')
  }
  return { kind: 'schedule', schedule: value.schedule }
}

function routineScope(value: unknown): import('@shared/routines').PermissionScope {
  if (!isPermissionScope(value)) throw invalidParams('scope must be a permission scope')
  return value
}

function routineTimeLimit(value: unknown): import('@shared/routines').TimeLimitMinutes {
  if (!isTimeLimit(value)) throw invalidParams('timeLimitMinutes is not a time limit')
  return value
}

function routineProjectPath(o: Fields, platform: Platform): string | null {
  return o.projectPath === null ? null : absolutePath(o, 'projectPath', platform)
}

function routineDraft(value: unknown, platform: Platform): RoutineDraft {
  const o = fields(value)
  const name = o.name === undefined ? '' : o.name
  if (typeof name !== 'string' || name.length > ROUTINE_NAME_CHARS) {
    throw invalidParams(`name must be at most ${ROUTINE_NAME_CHARS} characters`)
  }
  if (typeof o.prompt !== 'string' || o.prompt.trim() === '' || o.prompt.length > PROMPT_CHARS) {
    throw invalidParams(`prompt must be 1 to ${PROMPT_CHARS} characters`)
  }
  return {
    name,
    prompt: o.prompt,
    agentId: agentId(o),
    projectPath: routineProjectPath(o, platform),
    options: routineOptions(o.options),
    trigger: routineTrigger(o.trigger),
    scope: routineScope(o.scope),
    timeLimitMinutes: routineTimeLimit(o.timeLimitMinutes),
  }
}

/** The fields of a draft an update may change, each only when named. */
function routineChanges(value: unknown, platform: Platform): RoutineChanges {
  const o = fields(value)
  const known = new Set([
    'name',
    'prompt',
    'agentId',
    'projectPath',
    'options',
    'trigger',
    'scope',
    'timeLimitMinutes',
    'enabled',
  ])
  for (const key of Object.keys(o)) {
    if (!known.has(key)) throw invalidParams(`Unknown change "${key}"`)
  }
  const changes: RoutineChanges = {}
  if (o.name !== undefined) {
    if (typeof o.name !== 'string' || o.name.length > ROUTINE_NAME_CHARS) {
      throw invalidParams(`name must be at most ${ROUTINE_NAME_CHARS} characters`)
    }
    changes.name = o.name
  }
  if (o.prompt !== undefined) {
    if (typeof o.prompt !== 'string' || o.prompt.trim() === '' || o.prompt.length > PROMPT_CHARS) {
      throw invalidParams(`prompt must be 1 to ${PROMPT_CHARS} characters`)
    }
    changes.prompt = o.prompt
  }
  if (o.agentId !== undefined) changes.agentId = agentId(o)
  if (o.projectPath !== undefined) changes.projectPath = routineProjectPath(o, platform)
  if (o.options !== undefined) changes.options = routineOptions(o.options)
  if (o.trigger !== undefined) changes.trigger = routineTrigger(o.trigger)
  if (o.scope !== undefined) changes.scope = routineScope(o.scope)
  if (o.timeLimitMinutes !== undefined)
    changes.timeLimitMinutes = routineTimeLimit(o.timeLimitMinutes)
  if (o.enabled !== undefined) changes.enabled = flag(o, 'enabled')
  return changes
}

function sessionId(o: Fields): string {
  return string(o, 'sessionId', ID_CHARS)
}

function optionalFlag(o: Fields, key: string): boolean | undefined {
  const value = o[key]
  if (value !== undefined && typeof value !== 'boolean')
    throw invalidParams(`${key} must be a boolean`)
  return value
}

function flag(o: Fields, key: string): boolean {
  const value = optionalFlag(o, key)
  if (value === undefined) throw invalidParams(`${key} must be a boolean`)
  return value
}

function artifactId(o: Fields): string {
  const value = string(o, 'id', ID_CHARS)
  if (!ARTIFACT_ID.test(value)) throw invalidParams('id is not an artifact id')
  return value
}

function version(o: Fields, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidParams(`${key} must be a version, a whole number from 1`)
  }
  return value
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
    case 'attachment': {
      // Only the id counts: the host takes everything else from its own record.
      const id = string(fields(o.attachment), 'id', ID_CHARS)
      return { ref: { kind: 'attachment', attachment: attachmentStub(id) }, bytes: 0 }
    }
    default:
      throw invalidParams(`${at}: a prompt can carry images, links and attachments only`)
  }
}

/** An attachment ref holding only its id, until the host fills it in from its record. */
export function attachmentStub(
  id: string,
): Extract<ContentRef, { kind: 'attachment' }>['attachment'] {
  return {
    id,
    type: 'image',
    name: '',
    uri: null,
    mimeType: null,
    size: null,
    sent: null,
    thumb: null,
    blob: null,
  }
}

const HASH = /^[0-9a-f]{64}$/
const THUMB = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/

/** A thumbnail the renderer made: an image data URL, or null. */
function thumbnail(o: Fields): string | null {
  if (o.thumb === null) return null
  const thumb = string(o, 'thumb', THUMB_CHARS)
  if (!THUMB.test(thumb)) throw invalidParams('thumb must be an image data URL')
  return thumb
}

/** Bytes a renderer hands over, not empty and not too large. */
function bytes(o: Fields, key: string, max: number): ArrayBuffer {
  const value = o[key]
  if (!(value instanceof ArrayBuffer)) throw invalidParams(`${key} must be an ArrayBuffer`)
  if (value.byteLength === 0) throw invalidParams(`${key} must not be empty`)
  if (value.byteLength > max) throw invalidParams(`${key} is larger than ${max} bytes`)
  return value
}

/** Prompt content: texts, images and links, at most 10 MB in all, and not empty. */
export function promptContent(value: unknown): UserContent[] {
  if (!Array.isArray(value)) throw invalidParams('content must be an array')
  if (value.length > PROMPT_ITEMS)
    throw invalidParams(`content has more than ${PROMPT_ITEMS} items`)
  const out: UserContent[] = []
  let bytes = 0
  let attachments = 0
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
      if (ref.kind === 'attachment' && ++attachments > ATTACHMENT_LIMIT) {
        throw invalidParams(`A prompt carries at most ${ATTACHMENT_LIMIT} attachments`)
      }
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
  const artifact = (params: unknown): { id: string } => ({ id: artifactId(fields(params)) })
  const queueItem = (params: unknown): { sessionId: string; itemId: string } => {
    const o = fields(params)
    return { sessionId: sessionId(o), itemId: string(o, 'itemId', ID_CHARS) }
  }
  const mediaFile = (o: Fields): { projectPath: string; path: string } => {
    const written = string(o, 'path', PATH_CHARS)
    if (written.includes('\0')) throw invalidParams('path contains a NUL character')
    return { projectPath: absolutePath(o, 'projectPath', platform), path: written }
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
    'agents.skipUpdate': agent,
    'agents.update': agent,
    'agents.updateCli': agent,
    'agents.setApiKey': (params) => {
      const o = fields(params)
      const baseUrl = optionalString(o, 'baseUrl', 2048)
      const model = optionalString(o, 'model', 256)
      return {
        agentId: agentId(o),
        key: string(o, 'key', 4096),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(model !== undefined ? { model } : {}),
      }
    },
    'agents.clearApiKey': agent,
    'agents.install': (params) => {
      const o = fields(params)
      const method = o.method
      if (method !== undefined && !INSTALL_METHODS.has(method)) {
        throw invalidParams('method must be archive, brew, script, winget or npm')
      }
      return {
        agentId: agentId(o),
        ...(method !== undefined ? { method: method as AgentInstallMethod['id'] } : {}),
      }
    },
    'agents.cancelTask': agent,
    'agents.readOptions': (params) => {
      const o = fields(params)
      return {
        agentId: agentId(o),
        projectPath: o.projectPath === null ? null : absolutePath(o, 'projectPath', platform),
      }
    },
    'agents.readFirstOptions': agent,
    'agents.refreshLimits': agent,
    'agents.details': agent,
    'agents.refreshAccount': agent,
    'agents.options': none,
    'mcp.status': none,
    'mcp.retry': none,
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
    'paths.complete': (params) => {
      const value = string(fields(params), 'path', PATH_CHARS)
      if (value.includes('\0')) throw invalidParams('path contains a NUL character')
      if (!isCompletablePath(value, platform)) {
        throw invalidParams('path must be an absolute path or start with ~')
      }
      return { path: value }
    },
    'sessions.list': (params) => {
      const o = params === undefined || params === null ? {} : fields(params)
      return o.projectPath === undefined
        ? {}
        : { projectPath: absolutePath(o, 'projectPath', platform) }
    },
    'sessions.create': (params) => {
      const o = fields(params)
      const parentId = optionalString(o, 'parentId', ID_CHARS)
      const preparedId = optionalString(o, 'preparedId', ID_CHARS)
      const options = o.options === undefined ? undefined : configValues(o.options)
      return {
        agentId: agentId(o),
        // null: no project, so the host makes a scratch folder.
        projectPath: o.projectPath === null ? null : absolutePath(o, 'projectPath', platform),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(o.prompt !== undefined ? { prompt: promptContent(o.prompt) } : {}),
        ...(preparedId !== undefined ? { preparedId } : {}),
      }
    },
    'sessions.prepare': (params) => {
      const o = fields(params)
      const parentId = optionalString(o, 'parentId', ID_CHARS)
      const options = o.options === undefined ? undefined : configValues(o.options)
      if (o.replace !== undefined && typeof o.replace !== 'boolean') {
        throw invalidParams('replace must be a boolean')
      }
      return {
        agentId: agentId(o),
        projectPath: o.projectPath === null ? null : absolutePath(o, 'projectPath', platform),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(o.replace === true ? { replace: true } : {}),
      }
    },
    'sessions.discard': (params) => ({ sessionId: sessionId(fields(params)) }),
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
      return {
        sessionId: sessionId(o),
        before: position(o, 'before'),
        ...(o.from === undefined ? {} : { from: position(o, 'from') }),
      }
    },
    'sessions.outline': session,
    'sessions.outlineTitles': session,
    'sessions.watch': session,
    'sessions.unwatch': session,
    'sessions.show': (params) => {
      const o = fields(params)
      if (!Array.isArray(o.sessionIds)) throw invalidParams('sessionIds must be a list')
      if (o.sessionIds.length > SHOWN_SESSIONS) {
        throw invalidParams(`sessionIds holds more than ${SHOWN_SESSIONS}`)
      }
      return {
        sessionIds: o.sessionIds.map((value) => sessionId({ sessionId: value })),
      }
    },
    'sessions.prompt': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), content: promptContent(o.content) }
    },
    'sessions.cancel': session,
    'sessions.retry': session,
    'sessions.fork': (params) => {
      const o = fields(params)
      const entryId = optionalString(o, 'entryId', ACP_ID_CHARS)
      return { sessionId: sessionId(o), ...(entryId === undefined ? {} : { entryId }) }
    },
    'sessions.context': session,
    'sessions.queue': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), content: promptContent(o.content) }
    },
    'sessions.unqueue': queueItem,
    'sessions.steer': queueItem,
    'sessions.sendNow': queueItem,
    'sessions.resumeQueue': session,
    'sessions.blob': (params) => {
      const o = fields(params)
      const hash = string(o, 'hash', 64)
      if (!HASH.test(hash)) throw invalidParams('hash must be a SHA-256 in hex')
      return { sessionId: sessionId(o), hash }
    },
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
    'sessions.pin': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), pinned: flag(o, 'pinned') }
    },
    'sessions.archive': session,
    'sessions.unarchive': session,
    'sessions.markUnread': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), unread: flag(o, 'unread') }
    },
    'sessions.delete': session,
    'sessions.takeReturned': (params) => {
      const o = fields(params)
      if (o.sessionId === undefined) return {}
      return { sessionId: o.sessionId === null ? null : sessionId(o) }
    },
    'sessions.removeEmpty': (params) => {
      const keep = fields(params).keep
      if (!Array.isArray(keep) || keep.length > KEPT_SESSIONS) {
        throw invalidParams(`keep must be an array of at most ${KEPT_SESSIONS} session ids`)
      }
      return {
        keep: keep.map((id: unknown, index) => {
          if (typeof id !== 'string' || id.length === 0 || id.length > ID_CHARS) {
            throw invalidParams(`keep[${index}] must be a session id`)
          }
          return id
        }),
      }
    },
    'sessions.removeAll': none,
    'routines.list': none,
    'routines.create': (params) => routineDraft(params, platform),
    'routines.update': (params) => {
      const o = fields(params)
      return { routineId: routineId(o), changes: routineChanges(o.changes, platform) }
    },
    'routines.delete': (params) => ({ routineId: routineId(fields(params)) }),
    'routines.runNow': (params) => ({ routineId: routineId(fields(params)) }),
    'routines.cancelRun': (params) => ({ runId: string(fields(params), 'runId', ID_CHARS) }),
    'routines.runs': (params) => {
      const o = fields(params)
      return {
        routineId: routineId(o),
        ...(o.before === undefined ? {} : { before: position(o, 'before') }),
      }
    },
    'routines.markSeen': (params) => ({ routineId: routineId(fields(params)) }),
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
    'git.avatarUrl': (params) => {
      const login = string(fields(params), 'login', 128)
      if (!GITHUB_LOGIN.test(login)) throw invalidParams('login is not a GitHub login')
      return { login }
    },
    'git.currentPullRequest': project,
    'git.tools': none,
    'media.open': (params) => {
      const o = fields(params)
      return { ...mediaFile(o), sessionId: sessionId(o) }
    },
    'media.authorize': (params) => {
      const o = fields(params)
      return { ...mediaFile(o), ...(o.sessionId === undefined ? {} : { sessionId: sessionId(o) }) }
    },
    'usage.summary': (params) => {
      const o = fields(params)
      if (o.scope !== 'computer' && o.scope !== 'kettu') {
        throw invalidParams('scope must be computer or kettu')
      }
      return { dayStarts: dayStarts(o), ...range(o), scope: o.scope }
    },
    'usage.total': (params) => range(fields(params)),
    'usage.status': none,
    'usage.sync': none,
    'usage.reimport': agent,
    'usage.clearRecord': none,
    'attachments.add': (params) => {
      const o = fields(params)
      const source = fields(o.source)
      return {
        source:
          source.grantId !== undefined
            ? { grantId: string(source, 'grantId', ID_CHARS) }
            : source.projectPath !== undefined
              ? {
                  projectPath: absolutePath(source, 'projectPath', platform),
                  path: relativePath(source, 'path', platform),
                }
              : {
                  bytes: bytes(source, 'bytes', ATTACHMENT_BYTES),
                  mimeType: string(source, 'mimeType', ID_CHARS),
                  name: string(source, 'name', TEXT_CHARS),
                },
        thumb: thumbnail(o),
      }
    },
    'attachments.read': (params) => ({ id: string(fields(params), 'id', ID_CHARS) }),
    'attachments.update': (params) => {
      const o = fields(params)
      let scaled = null
      if (o.scaled !== null) {
        const image = fields(o.scaled)
        scaled = {
          bytes: bytes(image, 'bytes', ATTACHMENT_BYTES),
          mimeType: string(image, 'mimeType', ID_CHARS),
        }
      }
      return { id: string(o, 'id', ID_CHARS), thumb: thumbnail(o), scaled }
    },
    'attachments.remove': (params) => ({ id: string(fields(params), 'id', ID_CHARS) }),
    'attachments.held': (params) => {
      const ids = fields(params).ids
      if (!Array.isArray(ids) || ids.length > HELD_ATTACHMENTS) {
        throw invalidParams(`ids must be an array of at most ${HELD_ATTACHMENTS} attachment ids`)
      }
      return {
        ids: ids.map((id: unknown, index) => {
          if (typeof id !== 'string' || id.length === 0 || id.length > ID_CHARS) {
            throw invalidParams(`ids[${index}] must be an attachment id`)
          }
          return id
        }),
      }
    },
    'files.list': project,
    'files.read': (params) => {
      const o = fields(params)
      const asText = optionalFlag(o, 'asText')
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        path: relativePath(o, 'path', platform),
        ...(asText === undefined ? {} : { asText }),
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
    'artifacts.list': (params) => {
      const o = params === undefined || params === null ? {} : fields(params)
      const deleted = optionalFlag(o, 'deleted')
      return deleted === undefined ? {} : { deleted }
    },
    'artifacts.read': (params) => {
      const o = fields(params)
      return {
        id: artifactId(o),
        ...(o.version === undefined ? {} : { version: version(o, 'version') }),
      }
    },
    'artifacts.versions': artifact,
    'artifacts.rename': (params) => {
      const o = fields(params)
      const title = o.title
      if (typeof title !== 'string' || title.trim() === '' || longer(title, ARTIFACT_TITLE_CHARS)) {
        throw invalidParams(`title must be 1 to ${ARTIFACT_TITLE_CHARS} characters, not blank`)
      }
      return { id: artifactId(o), title }
    },
    'artifacts.delete': (params) => {
      const o = fields(params)
      const permanently = optionalFlag(o, 'permanently')
      return { id: artifactId(o), ...(permanently === undefined ? {} : { permanently }) }
    },
    'artifacts.undelete': artifact,
    'artifacts.restoreVersion': (params) => {
      const o = fields(params)
      return {
        id: artifactId(o),
        version: version(o, 'version'),
        baseVersion: version(o, 'baseVersion'),
      }
    },
    'artifacts.watch': artifact,
    'artifacts.unwatch': artifact,
  }
}
