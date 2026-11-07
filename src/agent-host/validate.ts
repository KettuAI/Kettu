// Hand-written guards for every request on the agent host port. A validator returns a fresh
// params object with only the known fields, or throws `invalid_params` before anything runs.

import type { AgentInstallMethod, HostMethod, HostParams } from '@shared/agent-host'
import { COMMENT_CHARS, THREAD_ID, type CommentAnchor } from '@shared/artifact-comments'
import { artifactPathProblem, isHtmlPath } from '@shared/artifact-files'
import {
  checkedStyle,
  EDIT_TEXT_CHARS,
  SNIPPET_CHARS,
} from '@shared/artifact-runtime/page-messages'
import { ARTIFACT_ID, ARTIFACT_TITLE_CHARS, longer } from '@shared/artifacts'
import { CanvasError, parseCanvasOps, type CanvasOp } from '@shared/canvas-doc'
import type { BrowserCallAnswer, BrowserOriginAnswer, BrowserOriginDecision } from '@shared/browser'
import { isComputerAppDecision } from '@shared/computer-use'
import { FILE_READ_LIMIT } from '@shared/files'
import {
  GITHUB_LOGIN,
  GITHUB_PULL_REQUEST_URL,
  githubReferenceOf,
  isRepositoryName,
} from '@shared/git'
import type { Platform } from '@shared/platform'
import type { ClockRequest, ClockZone } from '@shared/usage'
import {
  isPermissionScope,
  isSchedule,
  isTimeLimit,
  isKeptRunSessions,
  DEFAULT_KEPT_RUN_SESSIONS,
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
import {
  isAgentId,
  type AgentId,
  type ContentRef,
  type FormValues,
  type QuestionAnswer,
  type UserContent,
} from '@shared/thread'
import { FORM_FIELDS, FORM_KEY_CHARS } from './elicitation'
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

// An ask holds a few questions; Codex's schema sets no bound, so this is generous.
const ASK_QUESTIONS = 20
const ASK_CHOICES = 100
const ANSWER_CHARS = 10_000

/** The answers to an ask's questions; their fit to the questions is checked where those are known. */
function questionAnswers(value: unknown): QuestionAnswer[] {
  if (!Array.isArray(value) || value.length > ASK_QUESTIONS) {
    throw invalidParams(`answers must be an array of at most ${ASK_QUESTIONS} answers`)
  }
  return value.map((item: unknown, index) => {
    const at = `answers[${index}]`
    const o = fields(item)
    const { choices, text } = o
    if (!Array.isArray(choices) || choices.length > ASK_CHOICES) {
      throw invalidParams(`${at}.choices must be an array of at most ${ASK_CHOICES} choices`)
    }
    if (text !== undefined && (typeof text !== 'string' || text.length > ANSWER_CHARS)) {
      throw invalidParams(`${at}.text must be a string of at most ${ANSWER_CHARS} characters`)
    }
    return {
      question: position(o, 'question'),
      choices: choices.map((choice: unknown) => position({ choice }, 'choice')),
      ...(text === undefined ? {} : { text }),
    }
  })
}

const NOTE_CHARS = 4_000
const FORM_TEXT_CHARS = 10_000
const FORM_LIST_ITEMS = 100
const FORM_LIST_ITEM_CHARS = 1_000

/** A note sent with an option, such as what to change in a plan; empty means none. */
function noteText(value: unknown): string {
  if (typeof value !== 'string' || value.length > NOTE_CHARS) {
    throw invalidParams(`note must be a string of at most ${NOTE_CHARS} characters`)
  }
  return value
}

/** A form's values by field key; their fit to the form is checked where the form is known. */
function formValues(value: unknown): FormValues {
  if (!isRecord(value)) throw invalidParams('values must be an object')
  const entries = Object.entries(value)
  if (entries.length > FORM_FIELDS) {
    throw invalidParams(`values holds more than ${FORM_FIELDS} fields`)
  }
  return Object.fromEntries(
    entries.map(([key, v]): [string, FormValues[string]] => {
      if (key.length === 0 || key.length > FORM_KEY_CHARS) {
        throw invalidParams(`A field key must be 1 to ${FORM_KEY_CHARS} characters`)
      }
      const at = `values.${key}`
      if (typeof v === 'string') {
        if (v.length > FORM_TEXT_CHARS) {
          throw invalidParams(`${at} is longer than ${FORM_TEXT_CHARS} characters`)
        }
        return [key, v]
      }
      if (typeof v === 'boolean') return [key, v]
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw invalidParams(`${at} must be a finite number`)
        return [key, v]
      }
      if (
        Array.isArray(v) &&
        v.length <= FORM_LIST_ITEMS &&
        v.every((item) => typeof item === 'string' && item.length <= FORM_LIST_ITEM_CHARS)
      ) {
        return [key, [...(v as string[])]]
      }
      throw invalidParams(
        `${at} must be text, a number, true or false, or a list of at most ${FORM_LIST_ITEMS} texts of at most ${FORM_LIST_ITEM_CHARS} characters`,
      )
    }),
  )
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

// The pull requests and issues one window shows, at most as many as a request should carry.
const WATCHED_REFERENCES = 100

// The files of one commit or discard, at most as many as a request should carry.
const GIT_PATHS = 1_000

function gitPaths(o: Fields, key: string): string[] {
  const value = o[key]
  if (!Array.isArray(value) || value.length === 0 || value.length > GIT_PATHS) {
    throw invalidParams(`${key} must be an array of 1 to ${GIT_PATHS} paths`)
  }
  const paths = value.map((path: unknown, index) => {
    const at = `${key}[${index}]`
    return gitPath({ [at]: path }, at)
  })
  if (new Set(paths).size !== paths.length) throw invalidParams(`${key} names a path twice`)
  return paths
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

// Two changes of the clocks a year over fifty years, with room to spare.
const CLOCK_ZONES = 256
// UTC offsets run from -12:00 to +14:00, in quarter hours.
const QUARTER_MS = 900_000
const OFFSET_MIN = -720
const OFFSET_MAX = 840

function clock(value: unknown): ClockRequest {
  const o = fields(value)
  const { from, to } = range(o)
  if (!Array.isArray(o.zones) || o.zones.length === 0 || o.zones.length > CLOCK_ZONES) {
    throw invalidParams(`clock.zones must be a list of 1 to ${CLOCK_ZONES} zones`)
  }
  const zones = o.zones.map((zone: unknown, index): ClockZone => {
    const z = fields(zone)
    const start = time(z, 'from')
    if (start % QUARTER_MS !== 0) {
      throw invalidParams(`clock.zones[${index}].from must begin a quarter hour`)
    }
    const offset = z.offset
    if (
      typeof offset !== 'number' ||
      !Number.isInteger(offset) ||
      offset % 15 !== 0 ||
      offset < OFFSET_MIN ||
      offset > OFFSET_MAX
    ) {
      throw invalidParams(
        `clock.zones[${index}].offset must be quarter hours from ${OFFSET_MIN} to ${OFFSET_MAX} minutes`,
      )
    }
    return { from: start, offset }
  })
  if (zones.some((zone, index) => index > 0 && zone.from <= zones[index - 1]!.from)) {
    throw invalidParams('clock.zones must ascend')
  }
  if (zones[0]!.from > from) throw invalidParams('clock.zones must start at or before clock.from')
  return { from, to, zones }
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

function routineKeptRunSessions(value: unknown): import('@shared/routines').KeptRunSessions {
  if (!isKeptRunSessions(value)) throw invalidParams('keptRunSessions is not one of the choices')
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
    // Clients older than the setting send none.
    keptRunSessions:
      o.keptRunSessions === undefined
        ? DEFAULT_KEPT_RUN_SESSIONS
        : routineKeptRunSessions(o.keptRunSessions),
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
    'keptRunSessions',
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
  if (o.keptRunSessions !== undefined)
    changes.keptRunSessions = routineKeptRunSessions(o.keptRunSessions)
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

/** A browser call's or a site question's id, which the side that made it gave. */
function callId(o: Fields, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidParams(`${key} must be a whole number from 1`)
  }
  return value
}

const ORIGIN_ANSWERS: ReadonlySet<unknown> = new Set<BrowserOriginAnswer>([
  'session',
  'project',
  'deny',
  'timeout',
])
const ORIGIN_DECISIONS: ReadonlySet<unknown> = new Set<BrowserOriginDecision>([
  'session',
  'project',
  'deny',
])

/** An http(s) origin as a browser names it: scheme, host and port alone. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
  } catch {
    return false
  }
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

const ELEMENT_TAG = /^[a-z][a-z0-9-]{0,31}$/
const PAGE_NAME_CHARS = 200
const MAX_OFFSET = 64 * 1024 * 1024
const SENT_THREADS = 1_000

function htmlPath(o: Fields, key: string): string {
  const value = o[key]
  if (typeof value !== 'string' || artifactPathProblem(value) !== null || !isHtmlPath(value)) {
    throw invalidParams(`${key} must be the path of one of the artifact's HTML files`)
  }
  return value
}

function offset(o: Fields, key: string): number {
  const value = o[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_OFFSET) {
    throw invalidParams(`${key} must be an offset in the file`)
  }
  return value as number
}

function threadId(o: Fields): string {
  const value = string(o, 'threadId', ID_CHARS)
  if (!THREAD_ID.test(value)) throw invalidParams('threadId is not a thread id')
  return value
}

function commentBody(o: Fields): string {
  const value = o.body
  if (typeof value !== 'string' || value.trim() === '' || longer(value, COMMENT_CHARS)) {
    throw invalidParams(`body must be 1 to ${COMMENT_CHARS} characters, not blank`)
  }
  return value
}

/** A new thread's anchor: what the page reported, checked and capped; never already missing. */
function commentAnchor(value: unknown): CommentAnchor {
  const o = fields(value)
  let page: CommentAnchor['page'] = null
  if (o.page !== null) {
    const p = fields(o.page)
    const number = p.number
    if (!Number.isSafeInteger(number) || (number as number) < 1 || (number as number) > 9_999) {
      throw invalidParams('anchor.page.number must be a page number')
    }
    if (p.name !== null && (typeof p.name !== 'string' || longer(p.name, PAGE_NAME_CHARS))) {
      throw invalidParams(`anchor.page.name must be text of at most ${PAGE_NAME_CHARS} characters`)
    }
    page = { number: number as number, name: p.name as string | null }
  }
  const tag = o.tag
  if (tag !== null && (typeof tag !== 'string' || !ELEMENT_TAG.test(tag))) {
    throw invalidParams('anchor.tag must be an element name')
  }
  if (typeof o.text !== 'string' || longer(o.text, SNIPPET_CHARS)) {
    throw invalidParams(`anchor.text must be text of at most ${SNIPPET_CHARS} characters`)
  }
  return {
    version: version(o, 'version'),
    path: htmlPath(o, 'path'),
    page,
    offset: o.offset === null ? null : offset(o, 'offset'),
    tag: tag as string | null,
    text: o.text,
    missing: false,
  }
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
    'agents.providerAction': (params) => {
      const o = fields(params)
      const providerId = string(o, 'providerId', ID_CHARS)
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(providerId)) {
        throw invalidParams('providerId contains invalid characters')
      }
      const action = o.action
      if (action !== 'logout' && action !== 'activate' && action !== 'set-key') {
        throw invalidParams('action must be logout, activate or set-key')
      }
      const base = { agentId: agentId(o), providerId, action }
      if (action === 'set-key') {
        if (o.credentialId !== undefined) throw invalidParams('set-key takes no credentialId')
        const key = string(o, 'key', 4096)
        if (/[\r\n\0]/.test(key) || !key.trim()) throw invalidParams('key is invalid')
        return { ...base, action, key }
      }
      if (o.key !== undefined) throw invalidParams('Only set-key accepts a key')
      return { ...base, action, credentialId: string(o, 'credentialId', ID_CHARS) }
    },
    'agents.retry': agent,
    'agents.reinstall': agent,
    'agents.checkUpdates': none,
    'agents.skipUpdate': agent,
    'agents.unskipUpdate': agent,
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
    'agents.uninstall': (params) => {
      const o = fields(params)
      if (o.removeProgram !== undefined && typeof o.removeProgram !== 'boolean') {
        throw invalidParams('removeProgram must be a boolean')
      }
      return {
        agentId: agentId(o),
        ...(o.removeProgram !== undefined ? { removeProgram: o.removeProgram as boolean } : {}),
      }
    },
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
    'agents.refreshAccount': (params) => {
      const o = fields(params)
      const force = optionalFlag(o, 'force')
      return { agentId: agentId(o), ...(force !== undefined ? { force } : {}) }
    },
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
    'sessions.switchAgent': (params) => {
      const o = fields(params)
      if (o.summarize !== undefined && typeof o.summarize !== 'boolean') {
        throw invalidParams('summarize must be a boolean')
      }
      const options = o.options === undefined ? undefined : configValues(o.options)
      return {
        sessionId: sessionId(o),
        agentId: agentId(o),
        content: promptContent(o.content),
        ...(options !== undefined ? { options } : {}),
        ...(o.summarize === true ? { summarize: true } : {}),
      }
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
      const base = { sessionId: sessionId(o), requestId: string(o, 'requestId', ID_CHARS) }
      const given = [o.optionId, o.answers, o.values].filter((value) => value !== undefined)
      if (given.length !== 1) throw invalidParams('Give one of optionId, answers and values')
      if (o.note !== undefined && o.optionId === undefined) {
        throw invalidParams('note goes only with optionId')
      }
      if (o.optionId !== undefined) {
        return {
          ...base,
          optionId: string(o, 'optionId', ID_CHARS),
          ...(o.note === undefined ? {} : { note: noteText(o.note) }),
        }
      }
      return o.answers !== undefined
        ? { ...base, answers: questionAnswers(o.answers) }
        : { ...base, values: formValues(o.values) }
    },
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
    'git.branches': project,
    'git.switchBranch': (params) => {
      const o = fields(params)
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        branch: refName(o, 'branch'),
        create: flag(o, 'create'),
      }
    },
    'git.publishBranch': (params) => {
      const o = fields(params)
      return { projectPath: absolutePath(o, 'projectPath', platform), remote: refName(o, 'remote') }
    },
    'git.commitChanges': (params) => {
      const o = fields(params)
      const message = string(o, 'message', 65_536)
      if (message.trim() === '') throw invalidParams('message must not be blank')
      if (message.includes('\0')) throw invalidParams('message contains a NUL character')
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        message,
        paths: gitPaths(o, 'paths'),
      }
    },
    'git.discardChanges': (params) => {
      const o = fields(params)
      return { projectPath: absolutePath(o, 'projectPath', platform), paths: gitPaths(o, 'paths') }
    },
    'git.pullRequest': (params) => {
      const url = string(fields(params), 'url', URL_CHARS)
      if (!GITHUB_PULL_REQUEST_URL.test(url))
        throw invalidParams('url is not a GitHub pull request')
      return { url }
    },
    'git.issue': (params) => {
      const url = string(fields(params), 'url', URL_CHARS)
      if (githubReferenceOf(url)?.kind !== 'issue') throw invalidParams('url is not a GitHub issue')
      return { url }
    },
    'git.watchReferences': (params) => {
      const value = fields(params).urls
      if (!Array.isArray(value) || value.length > WATCHED_REFERENCES) {
        throw invalidParams(`urls must be an array of at most ${WATCHED_REFERENCES} addresses`)
      }
      const urls = value.map((url: unknown, index) => {
        const at = `urls[${index}]`
        const checked = string({ [at]: url }, at, URL_CHARS)
        if (!githubReferenceOf(checked)) throw invalidParams(`${at} is not a GitHub reference`)
        return checked
      })
      return { urls }
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
      return {
        dayStarts: dayStarts(o),
        ...range(o),
        scope: o.scope,
        ...(o.clock === undefined ? {} : { clock: clock(o.clock) }),
      }
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
    'artifacts.file': (params) => {
      const o = fields(params)
      const path = o.path
      if (typeof path !== 'string' || artifactPathProblem(path) !== null) {
        throw invalidParams("path must be a path of one of the artifact's files")
      }
      return { id: artifactId(o), version: version(o, 'version'), path }
    },
    'artifacts.content': (params) => {
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
    'artifacts.comments': artifact,
    'artifacts.comment': (params) => {
      const o = fields(params)
      return { id: artifactId(o), anchor: commentAnchor(o.anchor), body: commentBody(o) }
    },
    'artifacts.reply': (params) => {
      const o = fields(params)
      return { id: artifactId(o), threadId: threadId(o), body: commentBody(o) }
    },
    'artifacts.resolve': (params) => {
      const o = fields(params)
      return { id: artifactId(o), threadId: threadId(o), resolved: flag(o, 'resolved') }
    },
    'artifacts.markSent': (params) => {
      const o = fields(params)
      const ids = o.threadIds
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > SENT_THREADS) {
        throw invalidParams(`threadIds must list 1 to ${SENT_THREADS} threads`)
      }
      return {
        id: artifactId(o),
        threadIds: ids.map((value: unknown) => threadId({ threadId: value })),
        sessionId: sessionId(o),
      }
    },
    'artifacts.editElement': (params) => {
      const o = fields(params)
      const style = o.style === null ? null : checkedStyle(o.style)
      if (o.style !== null && !style) {
        throw invalidParams('style may set only the editable properties, to values they take')
      }
      const text = o.text
      if (text !== null && (typeof text !== 'string' || text.length > EDIT_TEXT_CHARS)) {
        throw invalidParams(`text must be text of at most ${EDIT_TEXT_CHARS} characters, or null`)
      }
      if (style === null && text === null) throw invalidParams('Give a style, a text or both')
      return {
        id: artifactId(o),
        baseVersion: version(o, 'baseVersion'),
        path: htmlPath(o, 'path'),
        offset: offset(o, 'offset'),
        style,
        text: text as string | null,
      }
    },
    'artifacts.canvas': artifact,
    'artifacts.canvasOps': (params) => {
      const o = fields(params)
      let ops: CanvasOp[]
      try {
        ops = parseCanvasOps(o.ops)
      } catch (error) {
        if (error instanceof CanvasError) throw invalidParams(error.message)
        throw error
      }
      if (ops.length === 0) throw invalidParams('Give at least one canvas operation')
      const clientSeq = o.clientSeq
      if (typeof clientSeq !== 'number' || !Number.isSafeInteger(clientSeq) || clientSeq < 0) {
        throw invalidParams('clientSeq must be a whole number from 0')
      }
      return { id: artifactId(o), ops, client: string(o, 'client', ID_CHARS), clientSeq }
    },
    // The message is the page's, which the runtime itself checks.
    'artifacts.runtime': (params) => {
      const o = fields(params)
      const artifactId = string(o, 'artifactId', ID_CHARS)
      if (!ARTIFACT_ID.test(artifactId)) throw invalidParams('artifactId is not an artifact id')
      const stream = optionalString(o, 'stream', ID_CHARS)
      return { artifactId, message: o.message, ...(stream === undefined ? {} : { stream }) }
    },
    'artifacts.consent': (params) => {
      const o = fields(params)
      return { requestId: string(o, 'requestId', ID_CHARS), allow: flag(o, 'allow') }
    },
    'artifacts.consents': none,
    'artifacts.revokeConsent': artifact,
    'artifacts.export': (params) => {
      const o = fields(params)
      const format = o.format
      // The type decides which of them a version takes; the host refuses the others.
      if (format !== 'docx' && format !== 'md' && format !== 'pptx' && format !== 'pdf') {
        throw invalidParams('format must be docx, md, pptx or pdf')
      }
      return { id: artifactId(o), version: version(o, 'version'), format }
    },
    // The host checks the answer's shape as it checks main's.
    'browser.answer': (params) => {
      const o = fields(params)
      return { callId: callId(o, 'callId'), answer: fields(o.answer) as BrowserCallAnswer }
    },
    'browser.waiting': (params) => {
      const o = fields(params)
      return { callId: callId(o, 'callId'), waiting: flag(o, 'waiting') }
    },
    'browser.origin': (params) => {
      const o = fields(params)
      const origin = string(o, 'origin', URL_CHARS)
      if (!isOrigin(origin)) throw invalidParams('origin must be an http or https origin')
      return { sessionId: sessionId(o), requestId: callId(o, 'requestId'), origin }
    },
    'browser.originSettled': (params) => {
      const o = fields(params)
      if (!ORIGIN_ANSWERS.has(o.decision)) {
        throw invalidParams('decision must be session, project, deny or timeout')
      }
      return {
        requestId: callId(o, 'requestId'),
        decision: o.decision as BrowserOriginAnswer,
      }
    },
    'browser.answerOrigin': (params) => {
      const o = fields(params)
      if (!ORIGIN_DECISIONS.has(o.decision)) {
        throw invalidParams('decision must be session, project or deny')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision as BrowserOriginDecision,
      }
    },
    'devices.allowed': (params) => {
      fields(params ?? {})
      return {}
    },
    'devices.forget': (params) => {
      const o = fields(params)
      const deviceId = string(o, 'deviceId', 256)
      if (!/^(ios-sim|ios|android|avd):[\w.:\-@]+$/.test(deviceId)) {
        throw invalidParams('deviceId is not a device id')
      }
      return { deviceId }
    },
    'devices.answerAccess': (params) => {
      const o = fields(params)
      if (o.decision !== 'session' && o.decision !== 'always' && o.decision !== 'deny') {
        throw invalidParams('decision must be session, always or deny')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision,
      }
    },
    'computer.answerApp': (params) => {
      const o = fields(params)
      if (!isComputerAppDecision(o.decision)) {
        throw invalidParams('decision must be session, always or deny')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision,
      }
    },
    'computer.stop': (params) => ({ sessionId: sessionId(fields(params)) }),
    'computer.declineSetup': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), entryId: string(o, 'entryId', ID_CHARS) }
    },
  }
}
