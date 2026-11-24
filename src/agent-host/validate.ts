// Hand-written guards for every request on the agent host port. A validator returns a fresh
// params object with only the known fields, or throws `invalid_params` before anything runs.

import type { AgentInstallMethod, HostMethod, HostParams } from '@shared/agent-host'
import { MAX_TERMINAL_COMMAND, replyCommandProblem } from '@shared/terminal-agent'
import { COMMENT_CHARS, THREAD_ID, type CommentAnchor } from '@shared/artifact-comments'
import { artifactPathProblem, isHtmlPath } from '@shared/artifact-files'
import { DOCUMENT_ENTRY } from '@shared/artifact-document-anchors'
import {
  checkedStyle,
  EDIT_TEXT_CHARS,
  SNIPPET_CHARS,
} from '@shared/artifact-runtime/page-messages'
import { ARTIFACT_ID, ARTIFACT_TITLE_CHARS, longer } from '@shared/artifacts'
import { CanvasError, parseCanvasOps, type CanvasOp } from '@shared/canvas-doc'
import { PARAMS_MAX, type ParamValue } from '@shared/artifact-params'
import type { BrowserCallAnswer, BrowserOriginAnswer, BrowserOriginDecision } from '@shared/browser'
import { isControlOutcome, isSurfaceAccessDecision } from '@shared/control'
import { isComputerAppDecision } from '@shared/computer-use'
import { FILE_READ_LIMIT } from '@shared/files'
import {
  isMemoryScope,
  MEMORY_BODY_CHARS,
  MEMORY_DESCRIPTION_CHARS,
  MEMORY_ID,
  MEMORY_TITLE_CHARS,
  type MemoryDraft,
  type MemoryScope,
} from '@shared/memory'
import { catalogSkillId, skillRepositoryId, type SkillSource } from '@shared/marketplace'
import {
  DIRECTORY_CURSOR,
  HANDLE,
  LISTING_ABOUT_CHARS,
  LISTING_DESCRIPTION_CHARS,
  LISTING_ID,
  LISTING_NAME_CHARS,
  LISTING_NOTES_CHARS,
  VERSION,
  type ListingChange,
  type ListingVisibility,
} from '@shared/market-publish'
import {
  GITHUB_LOGIN,
  GITHUB_PULL_REQUEST_URL,
  githubReferenceOf,
  isRepositoryName,
  type ProjectWorktreeSettings,
  type WorktreeInspection,
} from '@shared/git'
import type { Platform } from '@shared/platform'
import { REPORT_ERROR_MAX, REPORT_ORIGINS, type ReportOrigin } from '@shared/report'
import {
  MAX_WORKFLOW_STEPS,
  PICK_REASON_CHARS,
  WORKFLOW_FILE_BYTES,
  WORKFLOW_ID_CHARS,
  TASK_NOTE_CHARS,
  TASK_TEXT_CHARS,
  TASK_TITLE_CHARS,
  isPace,
  isStepPick,
  type StepPick,
} from '@shared/workflow'
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
  QUEUED_COMMENTS_TEXT,
  isAgentId,
  isQueuedComments,
  type AgentId,
  type ContentRef,
  type FormValues,
  type ProblemReportOutcome,
  type QuestionAnswer,
  type UserContent,
} from '@shared/thread'
import { FORM_FIELDS, FORM_KEY_CHARS } from './elicitation'
import { invalidParams } from './errors'
import { t } from './i18n'
import { bundleToken } from './marketplace/bundles'
import { TASK_ID } from './workflow/model'
import { isCompletablePath } from './path-completion'
import { isAbsolutePath } from './paths'
import {
  PLUGIN_ID,
  PLUGIN_SECRET_BYTES,
  PLUGIN_SETTING_CHARS,
  PLUGIN_SETTING_KEY,
  PLUGIN_TOKEN,
  type PluginSource,
} from '@shared/plugins'
import {
  PLUGIN_CHANNEL_ID,
  PLUGIN_NOTICE_KINDS,
  isPluginNoticeKind,
  type PluginNoticeKind,
} from '@shared/plugin-channels'
import {
  PLUGIN_ACTION_ID,
  PLUGIN_VIEW_ID,
  PLUGIN_VIEW_LIMITS,
  type PluginFormValues,
  type PluginViewParams,
} from '@shared/plugin-views'
import { PLUGIN_REF_ID, PLUGIN_REF_LIMITS } from '@shared/plugin-refs'
import {
  parseFormValues,
  parseParams as parseViewParams,
  ViewDataError,
} from './plugin-runtime/view-data'
import { MAX_WORKTREE_COPY_PATHS } from './storage'
import { checkIncludeEntry } from './worktrees/copy'
import { branchFromTemplate, checkWorktreeBranch } from './worktrees/names'

const ID_CHARS = 256
const ACP_ID_CHARS = 1_024
// Windows extended-length paths go up to 32,767 characters.
const PATH_CHARS = 32_767
const TEXT_CHARS = 4_096
// A terminal tab's name as a message carries it: its process title or the name the user gave.
const TERMINAL_NAME_CHARS = 256
// A side question and the passage it quotes, which a hidden session gets with carried context.
const SIDE_QUESTION_CHARS = 32_000
const SIDE_QUOTE_CHARS = 16_000
const URL_CHARS = 2_048
const PROMPT_ITEMS = 1_000
// Sessions with a draft, which the one-time removal keeps.
const KEPT_SESSIONS = 10_000
// Sessions one archive or delete may take at once, as a selection in the sidebar can.
const STAKED_SESSIONS = 10_000
// The panes a split view shows at most, which a window reports as in front.
const SHOWN_SESSIONS = 9
// The Marketplace's search, which the registry matches against server names.
const MARKET_QUERY_MIN = 3
const MARKET_QUERY_MAX = 100
// What a search of the conversations takes: a few words.
const SEARCH_QUERY_CHARS = 200
// What a bundle's install form sends for its arguments: values by user_config key.
const BUNDLE_VALUES = 64
const BUNDLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const BUNDLE_VALUE_CHARS = 16_384
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

// A request's byte ranges; a request holds a few dozen lines at most.
const RAW_HANDLE_CHARS = 16_384

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
  if (value.length === 0) throw invalidParams(t('validate.empty', { key }))
  if (value.length > max) throw invalidParams(t('validate.tooLong', { key, max }))
  return value
}

function optionalString(o: Fields, key: string, max: number): string | undefined {
  return o[key] === undefined ? undefined : string(o, key, max)
}

function agentId(o: Fields, key = 'agentId'): AgentId {
  const value = string(o, key, ID_CHARS)
  if (!isAgentId(value)) throw invalidParams(t('agent.unknown', { agent: value }))
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

// The rows a file operation takes at once, as many as a selection in the tree may hold.
const FILE_OPERATION_PATHS = 10_000

function relativePaths(o: Fields, key: string, platform: Platform): string[] {
  const value = o[key]
  if (!Array.isArray(value) || value.length === 0 || value.length > FILE_OPERATION_PATHS) {
    throw invalidParams(`${key} must be a list of 1 to ${FILE_OPERATION_PATHS} paths`)
  }
  return value.map((_, index) => relativePath(value as unknown as Fields, String(index), platform))
}

/** A folder of the project, relative to it; '' is the project's own. */
function relativeFolder(o: Fields, key: string, platform: Platform): string {
  return o[key] === '' ? '' : relativePath(o, key, platform)
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

const MAX_SETUP_COMMAND = 8192
const MAX_TEMPLATE = 200

/** A ref to cut a worktree from: never an option, a pathspec or anything with control chars. */
function baseRef(o: Fields, key: string): string {
  const value = string(o, key, 250)
  // eslint-disable-next-line no-control-regex
  if (value.startsWith('-') || /[\s\x00-\x1f\x7f~^:?*[\\]/.test(value)) {
    throw invalidParams(`${key} is not a branch or commit`)
  }
  return value
}

/** `sessions.create`'s new worktree: where it is cut from, and the user's branch name. */
function worktreeRequest(value: unknown): { base: string; branch?: string } {
  const o = fields(value)
  const branch = o.branch === undefined ? undefined : checkWorktreeBranch(string(o, 'branch', 100))
  return { base: baseRef(o, 'base'), ...(branch === undefined ? {} : { branch }) }
}

const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const WORKFLOW_HASH = /^[0-9a-f]{64}$/

function workflowId(o: Fields): string {
  const value = string(o, 'workflowId', WORKFLOW_ID_CHARS)
  if (!WORKFLOW_ID.test(value)) throw invalidParams('workflowId is not a workflow id')
  return value
}

function taskId(o: Fields): string {
  const value = string(o, 'taskId', 20)
  if (!TASK_ID.test(value)) throw invalidParams('taskId is not a task id')
  return value
}

function stepId(o: Fields): string {
  return string(o, 'stepId', 64)
}

function optionalNote(o: Fields, key: string, max: number): string | undefined {
  const value = o[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidParams(`${key} must be a string`)
  if (value.length > max) throw invalidParams(`${key} is longer than ${max} characters`)
  return value
}

function stepPickOf(value: unknown): StepPick | null {
  if (value === null) return null
  if (!isStepPick(value))
    throw invalidParams('pick must name an agent, a model or null and an effort or null')
  return { agentId: value.agentId, model: value.model, effort: value.effort }
}

function stepPicks(value: unknown): Record<string, StepPick> {
  const o = fields(value)
  const entries = Object.entries(o)
  if (entries.length > MAX_WORKFLOW_STEPS)
    throw invalidParams(`pins holds more than ${MAX_WORKFLOW_STEPS}`)
  const out: Record<string, StepPick> = {}
  for (const [key, pick] of entries) {
    if (key.length > 64) throw invalidParams('A pin names a step id that is too long')
    const checked = stepPickOf(pick)
    if (checked) out[key] = checked
  }
  return out
}

function taskStart(value: unknown, platform: Platform): HostParams<'tasks.start'> {
  const o = fields(value)
  const pace = o.pace
  if (!isPace(pace)) throw invalidParams('pace must be quick, balanced or thorough')
  const title = optionalString(o, 'title', TASK_TITLE_CHARS)
  const paceReason = optionalNote(o, 'paceReason', PICK_REASON_CHARS)
  const from = o.from === undefined ? undefined : { sessionId: sessionId(fields(o.from)) }
  return {
    projectPath: absolutePath(o, 'projectPath', platform),
    workflowId: workflowId(o),
    text: string(o, 'text', TASK_TEXT_CHARS),
    ...(title === undefined ? {} : { title }),
    pace,
    ...(paceReason === undefined ? {} : { paceReason }),
    agentId: agentId(o),
    options: configValues(o.options ?? {}),
    ...(o.pins === undefined ? {} : { pins: stepPicks(o.pins) }),
    ...(o.worktree === undefined ? {} : { worktree: worktreeRequest(o.worktree) }),
    ...(from ? { from } : {}),
  }
}

const SUGGESTION_ID = /^wfs-[a-z2-7]{12}$/
const SUGGESTION_ANSWERS: ReadonlySet<unknown> = new Set([
  'start',
  'decline',
  'another',
  'reconsider',
  'save',
  'not_save',
])

function suggestionId(o: Fields): string {
  const id = string(o, 'id', 16)
  if (!SUGGESTION_ID.test(id)) throw invalidParams('id must name a workflow card')
  return id
}

function answerSuggestion(value: unknown): HostParams<'workflows.answerSuggestion'> {
  const o = fields(value)
  if (!SUGGESTION_ANSWERS.has(o.answer)) {
    throw invalidParams('answer must be start, decline, another, reconsider, save or not_save')
  }
  return {
    id: suggestionId(o),
    answer: o.answer as HostParams<'workflows.answerSuggestion'>['answer'],
    ...(o.agentId === undefined ? {} : { agentId: agentId(o) }),
    ...(o.options === undefined ? {} : { options: configValues(o.options) }),
  }
}

function workflowAddSource(value: unknown): HostParams<'workflows.add'> {
  const o = fields(value)
  if (o.kind === 'url') return { kind: 'url', url: string(o, 'url', URL_CHARS) }
  if (o.kind === 'file') {
    return {
      kind: 'file',
      name: string(o, 'name', 255),
      text: string(o, 'text', WORKFLOW_FILE_BYTES),
    }
  }
  throw invalidParams('kind must be url or file')
}

function workflowSettingsChange(value: unknown): HostParams<'workflows.setSettings'> {
  const o = fields(value)
  const suggest = optionalFlag(o, 'suggest')
  let autoPick: Partial<Record<AgentId, boolean | null>> | undefined
  if (o.autoPick !== undefined) {
    const entries = Object.entries(fields(o.autoPick))
    if (entries.length > 64) throw invalidParams('autoPick names too many agents')
    autoPick = {}
    for (const [id, allowed] of entries) {
      if (!isAgentId(id)) throw invalidParams(t('agent.unknown', { agent: id }))
      if (allowed !== null && typeof allowed !== 'boolean') {
        throw invalidParams('autoPick values must be true, false or null')
      }
      autoPick[id] = allowed
    }
  }
  return { ...(suggest === undefined ? {} : { suggest }), ...(autoPick ? { autoPick } : {}) }
}

function count(o: Fields, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidParams(`${key} must be a whole number from 0`)
  }
  return value
}

/** The state the user was shown before removing a worktree. */
function inspection(value: unknown): WorktreeInspection {
  const o = fields(value)
  const head = o.head === null ? null : objectId(o, 'head')
  return {
    exists: flag(o, 'exists'),
    branchExists: flag(o, 'branchExists'),
    head,
    uncommitted: count(o, 'uncommitted'),
    unpushed: count(o, 'unpushed'),
    merged: flag(o, 'merged'),
  }
}

/** A project's worktree settings, each checked as the host will use it. */
function worktreeSettings(value: unknown, platform: Platform): ProjectWorktreeSettings {
  const o = fields(value)
  const template = o.branchTemplate
  if (typeof template !== 'string' || template.length > MAX_TEMPLATE) {
    throw invalidParams(t('validate.branchTemplate', { max: MAX_TEMPLATE }), { field: 'branch' })
  }
  // A template must give a usable name with and without an issue.
  for (const issue of ['', '1']) {
    checkWorktreeBranch(branchFromTemplate(template, { slug: 'slug', type: 'feat', issue }))
  }
  if (!Array.isArray(o.copy) || o.copy.length > MAX_WORKTREE_COPY_PATHS) {
    throw invalidParams(t('validate.copyCount', { max: MAX_WORKTREE_COPY_PATHS }), {
      field: 'copy',
    })
  }
  const copy = o.copy.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024) {
      throw invalidParams(t('validate.copyPaths'), { field: 'copy' })
    }
    const checked = checkIncludeEntry(entry, platform)
    if ('reason' in checked) {
      throw invalidParams(
        t('validate.copyEntry', { entry, reason: t(`worktree.includeProblem.${checked.problem}`) }),
        { field: 'copy' },
      )
    }
    return checked.path
  })
  const setup = o.setup
  if (
    setup !== null &&
    (typeof setup !== 'string' ||
      setup.trim() === '' ||
      setup.length > MAX_SETUP_COMMAND ||
      setup.includes('\0'))
  ) {
    throw invalidParams(t('validate.setupCommand', { max: MAX_SETUP_COMMAND }), { field: 'setup' })
  }
  return {
    branchTemplate: template,
    copy: [...new Set(copy)],
    setup,
    waitForSetup: flag(o, 'waitForSetup'),
  }
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
    throw invalidParams(t('validate.routineName', { max: ROUTINE_NAME_CHARS }))
  }
  if (typeof o.prompt !== 'string' || o.prompt.trim() === '' || o.prompt.length > PROMPT_CHARS) {
    throw invalidParams(t('validate.routinePrompt', { max: PROMPT_CHARS }))
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
      throw invalidParams(t('validate.routineName', { max: ROUTINE_NAME_CHARS }))
    }
    changes.name = o.name
  }
  if (o.prompt !== undefined) {
    if (typeof o.prompt !== 'string' || o.prompt.trim() === '' || o.prompt.length > PROMPT_CHARS) {
      throw invalidParams(t('validate.routinePrompt', { max: PROMPT_CHARS }))
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
    throw invalidParams(t('validate.commentBody', { max: COMMENT_CHARS }))
  }
  return value
}

/** An anchor's file: one of the artifact's HTML files, or a document's Markdown. */
function anchorPath(o: Fields): string {
  return o.path === DOCUMENT_ENTRY ? DOCUMENT_ENTRY : htmlPath(o, 'path')
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
    path: anchorPath(o),
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
    case 'terminal': {
      const terminalId = string(o, 'terminalId', ID_CHARS)
      const name = string(o, 'name', TERMINAL_NAME_CHARS)
      return { ref: { kind: 'terminal', terminalId, name }, bytes: terminalId.length + name.length }
    }
    case 'page': {
      const tabId = string(o, 'tabId', ID_CHARS)
      const name = string(o, 'name', TEXT_CHARS)
      return { ref: { kind: 'page', tabId, name }, bytes: tabId.length + name.length }
    }
    case 'device': {
      const deviceId = string(o, 'deviceId', ID_CHARS)
      const name = string(o, 'name', TERMINAL_NAME_CHARS)
      return { ref: { kind: 'device', deviceId, name }, bytes: deviceId.length + name.length }
    }
    case 'plugin': {
      const pluginId = string(o, 'pluginId', ID_CHARS)
      const source = string(o, 'source', ID_CHARS)
      if (!PLUGIN_ID.test(pluginId) || !PLUGIN_REF_ID.test(source)) {
        throw invalidParams(`${at}: pluginId and source must name a mention source`)
      }
      const item = string(o, 'item', PLUGIN_REF_LIMITS.itemId)
      const word = string(o, 'word', PLUGIN_REF_LIMITS.itemWord)
      if (/\s/.test(word)) throw invalidParams(`${at}: word must not hold white space`)
      const name = string(o, 'name', PLUGIN_REF_LIMITS.itemTitle)
      return {
        ref: { kind: 'plugin', pluginId, source, item, word, name },
        bytes: item.length + word.length + name.length,
      }
    }
    case 'attachment': {
      // Only the id counts: the host takes everything else from its own record.
      const id = string(fields(o.attachment), 'id', ID_CHARS)
      return { ref: { kind: 'attachment', attachment: attachmentStub(id) }, bytes: 0 }
    }
    default:
      throw invalidParams(
        `${at}: a prompt can carry images, links, terminals, tabs, devices, plugin items and attachments only`,
      )
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
    throw invalidParams(t('validate.promptItems', { max: PROMPT_ITEMS }))
  const out: UserContent[] = []
  let bytes = 0
  let attachments = 0
  let mentions = 0
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
        throw invalidParams(t('validate.promptAttachments', { max: ATTACHMENT_LIMIT }))
      }
      if (ref.kind === 'plugin' && ++mentions > PLUGIN_REF_LIMITS.perMessage) {
        throw invalidParams(t('validate.promptMentions', { max: PLUGIN_REF_LIMITS.perMessage }))
      }
      substance = true
      out.push({ type: 'ref', ref })
    } else {
      throw invalidParams(`${at}.type must be text or ref`)
    }
    if (bytes > PROMPT_BYTES) throw invalidParams(t('validate.promptTooLarge'))
  })
  if (!substance) throw invalidParams(t('validate.promptEmpty'))
  return out
}

type Validators = { [M in HostMethod]: (params: unknown) => HostParams<M> }

/** Params that hold at most a `refresh` flag, which skips a cache. */
function marketRead(params: unknown): { refresh?: boolean; cached?: boolean } {
  const o = params === undefined || params === null ? {} : fields(params)
  const refresh = optionalFlag(o, 'refresh')
  const cached = optionalFlag(o, 'cached')
  return {
    ...(refresh === undefined ? {} : { refresh }),
    ...(cached === undefined ? {} : { cached }),
  }
}

// What a report to the Kettu Marketplace says at most, as the service takes it.
const REPORT_CHARS = 2_000

/** A server Kettu keeps: a registry name, `manual:` and a UUID, or `kettu:` and a listing id. */
function marketServerId(o: Fields): string {
  const id = string(o, 'serverId', ID_CHARS)
  if (
    !/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(id) &&
    !/^manual:[0-9a-f-]{36}$/.test(id) &&
    !(id.startsWith('kettu:') && LISTING_ID.test(id.slice('kettu:'.length)))
  ) {
    throw invalidParams('serverId is not a server Kettu keeps')
  }
  return id
}

// A token as RFC 9110 defines a field name.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const PROBE_HEADERS = 64
const HEADER_VALUE_CHARS = 4_096

/** A URL being added by hand, as the settings would keep it. */
function serverUrl(o: Fields): string {
  const url = string(o, 'url', URL_CHARS)
  const parsed = URL.parse(url)
  if (
    !parsed ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    /\s/.test(url)
  ) {
    throw invalidParams('url must be an http or https URL')
  }
  return url
}

/** The headers typed for a server, each named once and on one line, as a request may send them. */
function probeHeaders(raw: unknown): { name: string; value: string }[] {
  if (!Array.isArray(raw) || raw.length > PROBE_HEADERS) {
    throw invalidParams(`headers must list at most ${PROBE_HEADERS} headers`)
  }
  const seen = new Set<string>()
  return raw.map((entry) => {
    const o = fields(entry)
    const name = string(o, 'name', 128)
    if (!HEADER_NAME.test(name)) throw invalidParams('A header name is not a token')
    if (seen.has(name.toLowerCase())) throw invalidParams(`The header ${name} is named twice`)
    seen.add(name.toLowerCase())
    const { value } = o
    if (typeof value !== 'string' || value.length > HEADER_VALUE_CHARS || /[\0\r\n]/.test(value)) {
      throw invalidParams(`The header ${name} must have a value of one line`)
    }
    return { name, value }
  })
}

/** A listing of the Kettu Marketplace, by its opaque id. */
function listingId(o: Fields): string {
  const id = string(o, 'id', ID_CHARS)
  if (!LISTING_ID.test(id)) throw invalidParams('id is not a listing of the Kettu Marketplace')
  return id
}

/** Where a skill to add comes from: the catalog, a github.com URL or a folder on the host. */
function skillSource(value: unknown, platform: Platform): SkillSource {
  const o = fields(value)
  if (o.kind === 'catalog') {
    const id = string(o, 'id', ID_CHARS)
    if (!catalogSkillId(id)) throw invalidParams('id is not a skill of the catalog')
    return { kind: 'catalog', id }
  }
  if (o.kind === 'github') {
    const url = string(o, 'url', URL_CHARS).trim()
    if (!url.startsWith('https://github.com/') || /\s/.test(url)) {
      throw invalidParams('url must be a https://github.com/ address')
    }
    return { kind: 'github', url }
  }
  if (o.kind === 'local') return { kind: 'local', path: absolutePath(o, 'path', platform) }
  if (o.kind === 'kettu') return { kind: 'kettu', id: listingId(o) }
  throw invalidParams('source.kind must be catalog, github, local or kettu')
}

/** Where a plugin comes from: a folder on the host, a github.com URL or a listing. */
function pluginSource(value: unknown, platform: Platform): PluginSource {
  const o = fields(value)
  if (o.kind === 'local') return { kind: 'local', path: absolutePath(o, 'path', platform) }
  if (o.kind === 'github') {
    const url = string(o, 'url', URL_CHARS).trim()
    if (!url.startsWith('https://github.com/') || /\s/.test(url)) {
      throw invalidParams('url must be a https://github.com/ address')
    }
    return { kind: 'github', url }
  }
  if (o.kind === 'kettu') return { kind: 'kettu', id: listingId(o) }
  throw invalidParams('source.kind must be local, github or kettu')
}

function installedPlugin(params: unknown): { pluginId: string } {
  const id = string(fields(params), 'pluginId', ID_CHARS)
  if (!PLUGIN_ID.test(id)) throw invalidParams('pluginId is not a plugin')
  return { pluginId: id }
}

/** The plugin and view a request names, and the parameters the view is opened with. */
function pluginView(params: unknown): { pluginId: string; viewId: string } {
  const o = fields(params)
  const { pluginId } = installedPlugin(params)
  const viewId = string(o, 'viewId', 64)
  if (!PLUGIN_VIEW_ID.test(viewId)) throw invalidParams('viewId is not a view')
  return { pluginId, viewId }
}

function pluginActionRun(params: unknown): HostParams<'plugins.actionRun'> {
  const o = fields(params)
  const { pluginId } = installedPlugin(params)
  const actionId = string(o, 'actionId', 64)
  if (!PLUGIN_ACTION_ID.test(actionId)) throw invalidParams('actionId is not an id')
  return { pluginId, actionId }
}

function viewParams(params: unknown): PluginViewParams {
  try {
    return parseViewParams(fields(params).params, 'params')
  } catch (error) {
    if (error instanceof ViewDataError) throw invalidParams(error.message)
    throw error
  }
}

function refId(o: Fields, key: string): string {
  const value = string(o, key, 64)
  if (!PLUGIN_REF_ID.test(value)) throw invalidParams(`${key} is not an id`)
  return value
}

function pluginViewAction(params: unknown): HostParams<'plugins.viewAction'> {
  const o = fields(params)
  const action = string(o, 'action', 64)
  if (!PLUGIN_ACTION_ID.test(action)) throw invalidParams('action is not an id')
  const row = optionalString(o, 'row', PLUGIN_VIEW_LIMITS.rowId)
  let values: PluginFormValues | undefined
  if (o.values !== undefined) {
    try {
      values = parseFormValues(o.values, 'values')
    } catch (error) {
      if (error instanceof ViewDataError) throw invalidParams(error.message)
      throw error
    }
  }
  return {
    ...pluginView(params),
    params: viewParams(params),
    action,
    ...(row === undefined ? {} : { row }),
    ...(values === undefined ? {} : { values }),
  }
}

function pluginSettingKey(o: Fields): string {
  const key = string(o, 'key', 64)
  if (!PLUGIN_SETTING_KEY.test(key)) throw invalidParams('key is not a setting key')
  return key
}

function pluginChannelKinds(params: unknown): HostParams<'plugins.setChannelKinds'> {
  const o = fields(params)
  const channel = string(o, 'channel', 64)
  if (!PLUGIN_CHANNEL_ID.test(channel)) throw invalidParams('channel is not a channel id')
  const { kinds } = o
  if (!Array.isArray(kinds) || kinds.length > PLUGIN_NOTICE_KINDS.length) {
    throw invalidParams('kinds must be a list of notice kinds')
  }
  for (const kind of kinds as unknown[]) {
    if (!isPluginNoticeKind(kind)) {
      throw invalidParams(`kinds takes only ${PLUGIN_NOTICE_KINDS.join(', ')}`)
    }
  }
  return { ...installedPlugin(params), channel, kinds: kinds as PluginNoticeKind[] }
}

function pluginToken(params: unknown): { token: string } {
  const token = string(fields(params), 'token', ID_CHARS)
  if (!PLUGIN_TOKEN.test(token)) throw invalidParams('token must name an inspected plugin')
  return { token }
}

function listingVersion(o: Fields): string {
  const version = string(o, 'version', 64)
  if (!VERSION.test(version)) throw invalidParams('version is not a version such as 1.2.0')
  return version
}

function publisherHandle(o: Fields, key: string): string | undefined {
  const handle = optionalString(o, key, 32)
  if (handle !== undefined && !HANDLE.test(handle)) {
    throw invalidParams(`${key} must be lowercase letters, digits and hyphens`)
  }
  return handle
}

/** One line of a listing, such as its name: not empty, without a line break. */
function listingLine(o: Fields, key: string, max: number): string | undefined {
  const value = optionalString(o, key, max)
  if (value !== undefined && (value.trim() === '' || /[\r\n]/.test(value))) {
    throw invalidParams(`${key} must be one line of text`)
  }
  return value
}

const LISTING_VISIBILITIES: readonly unknown[] = ['public', 'private', 'unlisted']

function listingChange(value: unknown): ListingChange {
  const o = fields(value)
  const name = listingLine(o, 'name', LISTING_NAME_CHARS)
  const description = listingLine(o, 'description', LISTING_DESCRIPTION_CHARS)
  if (
    o.about !== undefined &&
    (typeof o.about !== 'string' || o.about.length > LISTING_ABOUT_CHARS)
  ) {
    throw invalidParams(`about must be a string of at most ${LISTING_ABOUT_CHARS} characters`)
  }
  if (o.visibility !== undefined && !LISTING_VISIBILITIES.includes(o.visibility)) {
    throw invalidParams('visibility must be public, private or unlisted')
  }
  const change: ListingChange = {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(o.about !== undefined ? { about: o.about as string } : {}),
    ...(o.visibility !== undefined ? { visibility: o.visibility as ListingVisibility } : {}),
  }
  if (Object.keys(change).length === 0) throw invalidParams('change names nothing to change')
  return change
}

// What one import names: each agent's memory of each project, and the entries ticked for global.
const MEMORY_IMPORT_SOURCES = 1_000
const MEMORY_IMPORT_KEYS = 10_000

function memoryScope(value: unknown, platform: Platform): MemoryScope {
  if (!isMemoryScope(value)) {
    throw invalidParams('scope must be { layer: global } or { layer: project, project }')
  }
  if (value.layer === 'global') return { layer: 'global' }
  return { layer: 'project', project: absolutePath(value, 'project', platform) }
}

function memoryId(o: Fields, key = 'id'): string {
  const value = o[key]
  if (typeof value !== 'string' || !MEMORY_ID.test(value)) {
    throw invalidParams(`${key} is not a memory id`)
  }
  return value
}

function memoryText(o: Fields, key: string, max: number, blank: boolean): string {
  const value = o[key]
  if (typeof value !== 'string' || longer(value, max) || (!blank && value.trim() === '')) {
    throw invalidParams(`${key} must be ${blank ? 0 : 1} to ${max} characters`)
  }
  return value
}

function memoryDraft(value: unknown): MemoryDraft {
  const o = fields(value)
  return {
    title: memoryText(o, 'title', MEMORY_TITLE_CHARS, false),
    description: memoryText(o, 'description', MEMORY_DESCRIPTION_CHARS, true),
    body: memoryText(o, 'body', MEMORY_BODY_CHARS, true),
  }
}

export function createValidators(platform: Platform): Validators {
  const project = (params: unknown): { projectPath: string } => ({
    projectPath: absolutePath(fields(params), 'projectPath', platform),
  })
  const watching = (params: unknown): { projectPath: string; watcher?: string } => {
    const o = fields(params)
    const watcher = optionalString(o, 'watcher', ID_CHARS)
    return {
      projectPath: absolutePath(o, 'projectPath', platform),
      ...(watcher === undefined ? {} : { watcher }),
    }
  }
  const folder = (params: unknown): { path: string } => ({
    path: absolutePath(fields(params), 'path', platform),
  })
  const session = (params: unknown): { sessionId: string } => ({
    sessionId: sessionId(fields(params)),
  })
  const agent = (params: unknown): { agentId: AgentId } => ({ agentId: agentId(fields(params)) })
  const agentWithForce = (params: unknown): { agentId: AgentId; force?: boolean } => {
    const o = fields(params)
    const force = optionalFlag(o, 'force')
    return { agentId: agentId(o), ...(force !== undefined ? { force } : {}) }
  }
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
    'agents.detectedPrograms': none,
    'agents.environment': none,
    'agents.authenticate': (params) => {
      const o = fields(params)
      return { agentId: agentId(o), methodId: string(o, 'methodId', ID_CHARS) }
    },
    'agents.cancelSignIn': agent,
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
    'agents.installOffer': agent,
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
    'agents.refreshLimits': agentWithForce,
    'agents.spendReset': (params) => {
      const o = fields(params)
      const creditId = string(o, 'creditId', ID_CHARS)
      if (!/^[\w-]+$/.test(creditId)) throw invalidParams('creditId is not a credit id')
      const requestId = string(o, 'requestId', ID_CHARS)
      // The vendor's idempotency key is a UUID v4, so a retry carries the same one.
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
      ) {
        throw invalidParams('requestId must be a UUID v4')
      }
      return { agentId: agentId(o), creditId, requestId }
    },
    'agents.details': agent,
    'agents.claudeSettings': agent,
    'agents.setClaudeSetting': (params) => {
      const o = fields(params)
      const change = fields(o.change)
      if (change.setting === 'promptCacheTtl') {
        const value = change.value
        if (value !== null && value !== '5m' && value !== '1h') {
          throw invalidParams('change.value must be 5m, 1h or null')
        }
        return { agentId: agentId(o), change: { setting: 'promptCacheTtl', value } }
      }
      if (change.setting !== 'autoCompactWindow') {
        throw invalidParams('change.setting must be autoCompactWindow or promptCacheTtl')
      }
      const value = change.value
      if (value !== null && typeof value !== 'number') {
        throw invalidParams('change.value must be a number or null')
      }
      return {
        agentId: agentId(o),
        change: {
          setting: 'autoCompactWindow',
          model: change.model === null ? null : string(change, 'model', 256),
          value,
        },
      }
    },
    'agents.autoCompact': agent,
    'agents.setAutoCompact': (params) => {
      const o = fields(params)
      const change = fields(o.change)
      const value = change.value
      if (value !== null && (typeof value !== 'number' || !Number.isInteger(value))) {
        throw invalidParams('change.value must be a whole number or null')
      }
      return {
        agentId: agentId(o),
        change: { model: change.model === null ? null : string(change, 'model', 256), value },
      }
    },
    'agents.codebuddySettings': agent,
    'agents.setCodebuddySite': (params) => {
      const o = fields(params)
      const change = fields(o.change)
      if (
        change.site !== 'automatic' &&
        change.site !== 'international' &&
        change.site !== 'china'
      ) {
        throw invalidParams('change.site must be international, china or automatic')
      }
      return { agentId: agentId(o), change: { site: change.site } }
    },
    'agents.refreshAccount': agentWithForce,
    'agents.options': none,
    'agents.pinModel': (params) => {
      const o = fields(params)
      return {
        agentId: agentId(o),
        model: string(o, 'model', TEXT_CHARS),
        pinned: flag(o, 'pinned'),
      }
    },
    'agents.lightAgents': none,
    'agents.draftReport': (params) => {
      const o = fields(params)
      const absent = (key: string): boolean => o[key] === null || o[key] === undefined
      if (!absent('origin') && !(REPORT_ORIGINS as readonly unknown[]).includes(o.origin))
        throw invalidParams('origin is not a place reports open from')
      const error = o.error
      if (!absent('error') && (typeof error !== 'string' || error.length > REPORT_ERROR_MAX))
        throw invalidParams(`error must be text of at most ${REPORT_ERROR_MAX} characters`)
      const language = string(o, 'language', 35)
      if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(language))
        throw invalidParams('language must be a language tag')
      return {
        origin: absent('origin') ? null : (o.origin as ReportOrigin),
        sessionId: absent('sessionId') ? null : sessionId(o),
        agentId: absent('agentId') ? null : agentId(o),
        error: absent('error') ? null : (error as string),
        language,
      }
    },
    'mcp.status': none,
    'mcp.retry': none,
    'market.catalog': marketRead,
    'market.search': (params) => {
      const query = fields(params).query
      const trimmed = typeof query === 'string' ? query.trim() : ''
      if (
        trimmed.length < MARKET_QUERY_MIN ||
        trimmed.length > MARKET_QUERY_MAX ||
        /\p{Cc}/u.test(trimmed)
      ) {
        throw invalidParams(
          `query must be ${MARKET_QUERY_MIN} to ${MARKET_QUERY_MAX} characters on one line`,
        )
      }
      return { query: trimmed }
    },
    'market.keys': none,
    'market.connect': (params) => ({ serverId: marketServerId(fields(params)) }),
    'market.detectSignIn': (params) => {
      const o = fields(params)
      return { url: serverUrl(o), headers: probeHeaders(o.headers) }
    },
    'market.cancelConnect': (params) => {
      const loginId = string(fields(params), 'loginId', ID_CHARS)
      if (!/^[0-9a-f-]{36}$/.test(loginId)) throw invalidParams('loginId is not a login of Connect')
      return { loginId }
    },
    'market.disconnect': (params) => ({ serverId: marketServerId(fields(params)) }),
    'market.connections': none,
    'market.ownPlugins': (params) => {
      const refresh = optionalFlag(
        params === undefined || params === null ? {} : fields(params),
        'refresh',
      )
      return refresh === undefined ? {} : { refresh }
    },
    'market.skills': marketRead,
    'market.skillRepository': (params) => {
      const o = fields(params)
      const id = string(o, 'id', ID_CHARS)
      if (!skillRepositoryId(id)) throw invalidParams('id is not a repository such as owner/repo')
      const refresh = optionalFlag(o, 'refresh')
      return { id, ...(refresh === undefined ? {} : { refresh }) }
    },
    'market.addSkill': (params) => ({ source: skillSource(fields(params).source, platform) }),
    'settings.answerChange': (params) => {
      const o = fields(params)
      if (o.decision !== 'change' && o.decision !== 'keep') {
        throw invalidParams('decision must be change or keep')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision,
      }
    },
    'settings.undoChange': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), entryId: string(o, 'entryId', ID_CHARS) }
    },
    'market.answerPublish': (params) => {
      const o = fields(params)
      if (o.decision !== 'confirm' && o.decision !== 'later') {
        throw invalidParams('decision must be confirm or later')
      }
      if (o.visibility !== undefined && o.visibility !== 'public' && o.visibility !== 'private') {
        throw invalidParams('visibility must be public or private')
      }
      if (
        o.notes !== undefined &&
        (typeof o.notes !== 'string' || o.notes.length > LISTING_NOTES_CHARS)
      ) {
        throw invalidParams(`notes must be a string of at most ${LISTING_NOTES_CHARS} characters`)
      }
      const handle = optionalString(o, 'handle', 32)
      if (handle !== undefined && !HANDLE.test(handle)) {
        throw invalidParams('handle must be lowercase letters, digits and hyphens')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision,
        ...(o.visibility !== undefined ? { visibility: o.visibility } : {}),
        ...(o.notes !== undefined ? { notes: o.notes as string } : {}),
        ...(handle !== undefined ? { handle } : {}),
      }
    },
    'market.publishDrafts': none,
    'market.discardPublishDraft': (params) => ({ id: string(fields(params), 'id', ID_CHARS) }),
    'market.community': (params) => {
      const o = params === undefined || params === null ? {} : fields(params)
      const q = optionalString(o, 'q', MARKET_QUERY_MAX)?.trim()
      if (q !== undefined && /\p{Cc}/u.test(q)) throw invalidParams('q must be on one line')
      const kind = o.kind
      if (
        kind !== undefined &&
        kind !== 'skill' &&
        kind !== 'workflow' &&
        kind !== 'plugin' &&
        kind !== 'mcp-server' &&
        kind !== 'agent-plugin'
      ) {
        throw invalidParams('kind must be skill, workflow, plugin, mcp-server or agent-plugin')
      }
      const cursor = optionalString(o, 'cursor', 256)
      if (cursor !== undefined && !DIRECTORY_CURSOR.test(cursor)) {
        throw invalidParams('cursor must be one the directory gave')
      }
      const refresh = optionalFlag(o, 'refresh')
      return {
        ...(q ? { q } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(cursor ? { cursor } : {}),
        ...(refresh !== undefined ? { refresh } : {}),
      }
    },
    'market.communityListing': (params) => ({ id: listingId(fields(params)) }),
    'market.communityWorkflow': (params) => ({ id: listingId(fields(params)) }),
    'market.communityInstalled': (params) => {
      const refresh = optionalFlag(
        params === undefined || params === null ? {} : fields(params),
        'refresh',
      )
      return refresh === undefined ? {} : { refresh }
    },
    'market.addCommunityWorkflow': (params) => ({ id: listingId(fields(params)) }),
    'market.reportCommunity': (params) => {
      const o = fields(params)
      const message = string(o, 'message', REPORT_CHARS).trim()
      if (message === '') throw invalidParams('message must say what the problem is')
      return { id: listingId(o), message }
    },
    'market.bundlePrepare': (params) => ({ id: listingId(fields(params)) }),
    'market.bundleCommit': (params) => {
      const o = fields(params)
      if (!bundleToken(o.token)) throw invalidParams('token must name a staged bundle')
      const values = o.values
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        throw invalidParams('values must be an object')
      }
      const entries = Object.entries(values)
      if (entries.length > BUNDLE_VALUES) throw invalidParams('values has too many entries')
      for (const [key, value] of entries) {
        if (!BUNDLE_KEY.test(key)) throw invalidParams('values must be keyed by user_config keys')
        if (
          typeof value !== 'string' ||
          value.length > BUNDLE_VALUE_CHARS ||
          value.includes('\0')
        ) {
          throw invalidParams(
            `values.${key} must be a string of at most ${BUNDLE_VALUE_CHARS} characters`,
          )
        }
      }
      return { token: o.token, values: Object.fromEntries(entries) as Record<string, string> }
    },
    'market.bundleCancel': (params) => {
      const o = fields(params)
      if (!bundleToken(o.token)) throw invalidParams('token must name a staged bundle')
      return { token: o.token }
    },
    'market.account': none,
    'market.published': none,
    'market.setPublisher': (params) => {
      const handle = publisherHandle(fields(params), 'handle')
      if (handle === undefined) throw invalidParams('handle must be a string')
      return { handle }
    },
    'market.updateListing': (params) => {
      const o = fields(params)
      return { id: listingId(o), change: listingChange(o.change) }
    },
    'market.withdrawVersion': (params) => {
      const o = fields(params)
      return { id: listingId(o), version: listingVersion(o) }
    },
    'market.deleteListing': (params) => ({ id: listingId(fields(params)) }),
    'market.versionFiles': (params) => {
      const o = fields(params)
      return { id: listingId(o), version: listingVersion(o) }
    },
    'market.checkFolder': (params) => {
      const o = fields(params)
      const draftId = optionalString(o, 'draftId', ID_CHARS)
      return {
        path: absolutePath(o, 'path', platform),
        ...(draftId !== undefined ? { draftId } : {}),
      }
    },
    'market.convertFolder': (params) => ({ path: absolutePath(fields(params), 'path', platform) }),
    'market.convertListing': (params) => ({ id: listingId(fields(params)) }),
    'market.publishFolder': (params) => {
      const o = fields(params)
      const draftId = optionalString(o, 'draftId', ID_CHARS)
      if (o.visibility !== undefined && o.visibility !== 'public' && o.visibility !== 'private') {
        throw invalidParams('visibility must be public or private')
      }
      if (
        o.notes !== undefined &&
        (typeof o.notes !== 'string' || o.notes.length > LISTING_NOTES_CHARS)
      ) {
        throw invalidParams(`notes must be a string of at most ${LISTING_NOTES_CHARS} characters`)
      }
      const handle = publisherHandle(o, 'handle')
      return {
        path: absolutePath(o, 'path', platform),
        ...(draftId !== undefined ? { draftId } : {}),
        ...(o.visibility !== undefined ? { visibility: o.visibility } : {}),
        ...(o.notes !== undefined ? { notes: o.notes as string } : {}),
        ...(handle !== undefined ? { handle } : {}),
      }
    },
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
    'projects.pin': (params) => {
      const o = fields(params)
      return {
        path: o.path === null ? null : absolutePath(o, 'path', platform),
        pinned: flag(o, 'pinned'),
      }
    },
    'projects.move': (params) => {
      const o = fields(params)
      return {
        path: absolutePath(o, 'path', platform),
        before: o.before === null ? null : absolutePath(o, 'before', platform),
      }
    },
    'projects.noProject': none,
    'projects.worktreeSettings': folder,
    'projects.setWorktreeSettings': (params) => {
      const o = fields(params)
      return {
        path: absolutePath(o, 'path', platform),
        settings: worktreeSettings(o.settings, platform),
      }
    },
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
      const role = optionalString(o, 'role', ID_CHARS)
      const options = o.options === undefined ? undefined : configValues(o.options)
      return {
        agentId: agentId(o),
        // null: no project, so the host makes a scratch folder.
        projectPath: o.projectPath === null ? null : absolutePath(o, 'projectPath', platform),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(o.prompt !== undefined ? { prompt: promptContent(o.prompt) } : {}),
        ...(preparedId !== undefined ? { preparedId } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(o.worktree !== undefined ? { worktree: worktreeRequest(o.worktree) } : {}),
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
        ...(o.fork === true ? { fork: true } : {}),
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
    'sessions.entry': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), entryId: string(o, 'entryId', ACP_ID_CHARS) }
    },
    'sessions.requests': session,
    'sessions.outline': session,
    'sessions.modelRequests': (params) => {
      const o = fields(params)
      // A byte offset into a session file, or OpenCode's base64url cursor.
      const before = optionalString(o, 'before', 1024)
      if (before !== undefined && !/^[A-Za-z0-9_-]+$/.test(before))
        throw invalidParams('before must be a position a page gave')
      return { sessionId: sessionId(o), ...(before === undefined ? {} : { before }) }
    },
    'sessions.modelRequestsOverview': session,
    'sessions.modelRequestRaw': (params) => {
      const o = fields(params)
      const raw = string(o, 'raw', RAW_HANDLE_CHARS)
      if (
        raw !== 'system' &&
        !/^\d+-\d+(,\d+-\d+)*$/.test(raw) &&
        !/^msg_[A-Za-z0-9_]+(,msg_[A-Za-z0-9_]+)*$/.test(raw)
      ) {
        throw invalidParams('raw must name records of a page')
      }
      const full = optionalFlag(o, 'full')
      return { sessionId: sessionId(o), raw, ...(full === undefined ? {} : { full }) }
    },
    'sessions.search': (params) => ({ query: string(fields(params), 'query', SEARCH_QUERY_CHARS) }),
    'sessions.find': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), query: string(o, 'query', SEARCH_QUERY_CHARS) }
    },
    'sessions.outputs': session,
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
    'sessions.attachEarly': session,
    'sessions.cancel': session,
    'sessions.runningWork': (params) => {
      const o = fields(params)
      if (!Array.isArray(o.sessionIds)) throw invalidParams('sessionIds must be a list')
      if (o.sessionIds.length > STAKED_SESSIONS) {
        throw invalidParams(`sessionIds holds more than ${STAKED_SESSIONS}`)
      }
      return {
        sessionIds: o.sessionIds.map((value) => sessionId({ sessionId: value })),
      }
    },
    'sessions.idleRelease': none,
    'host.load.watch': none,
    'host.load.unwatch': none,
    'sessions.stopTask': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), taskId: string(o, 'taskId', ID_CHARS) }
    },
    'sessions.taskOutput': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), taskId: string(o, 'taskId', ID_CHARS) }
    },
    'sessions.retry': session,
    'sessions.cancelContinue': session,
    'sessions.rewind': (params) => {
      const o = fields(params)
      // An empty composer keeps nothing for Put back.
      const draft = Array.isArray(o.draft) && o.draft.length === 0 ? [] : promptContent(o.draft)
      return { sessionId: sessionId(o), entryId: string(o, 'entryId', ACP_ID_CHARS), draft }
    },
    'sessions.putBack': session,
    'sessions.sideAsk': (params) => {
      const o = fields(params)
      const question = string(o, 'question', SIDE_QUESTION_CHARS)
      if (question.trim() === '') throw invalidParams('question must not be blank')
      const quote = optionalString(o, 'quote', SIDE_QUOTE_CHARS)
      return {
        sessionId: sessionId(o),
        question,
        ...(quote === undefined ? {} : { quote }),
        ...(o.agentId === undefined ? {} : { agentId: agentId(o) }),
      }
    },
    'sessions.sideStop': session,
    'sessions.sideClear': (params) => {
      const o = fields(params)
      if (o.undo !== undefined && typeof o.undo !== 'boolean') {
        throw invalidParams('undo must be a boolean')
      }
      return { sessionId: sessionId(o), ...(o.undo === true ? { undo: true } : {}) }
    },
    'sessions.sideAgents': session,
    'sessions.fork': (params) => {
      const o = fields(params)
      const entryId = optionalString(o, 'entryId', ACP_ID_CHARS)
      if (o.worktree !== undefined && o.worktree !== 'new' && o.worktree !== 'same') {
        throw invalidParams('worktree must be "new" or "same"')
      }
      return {
        sessionId: sessionId(o),
        ...(entryId === undefined ? {} : { entryId }),
        ...(o.worktree === undefined ? {} : { worktree: o.worktree }),
      }
    },
    'worktrees.inspect': session,
    'worktrees.remove': (params) => {
      const o = fields(params)
      if (o.branch !== 'keep' && o.branch !== 'delete') {
        throw invalidParams('branch must be "keep" or "delete"')
      }
      return { sessionId: sessionId(o), branch: o.branch, expected: inspection(o.expected) }
    },
    'worktrees.retrySetup': session,
    'worktrees.skipSetup': session,
    'worktrees.setupLog': (params) => {
      const o = fields(params)
      return {
        sessionId: sessionId(o),
        ...(o.from === undefined ? {} : { from: count(o, 'from') }),
      }
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
    'sessions.contextEstimates': session,
    'sessions.queue': (params) => {
      const o = fields(params)
      if (o.comments !== undefined && !isQueuedComments(o.comments)) {
        throw invalidParams(
          `comments must be a count from 1 and a text of 1 to ${QUEUED_COMMENTS_TEXT} characters`,
        )
      }
      return {
        sessionId: sessionId(o),
        content: promptContent(o.content),
        ...(o.comments === undefined
          ? {}
          : { comments: { count: o.comments.count, text: o.comments.text } }),
      }
    },
    'sessions.runCommand': (params) => {
      const o = fields(params)
      const command = string(o, 'command', MAX_TERMINAL_COMMAND)
      const problem = replyCommandProblem(command)
      if (problem) throw invalidParams(`command cannot run: ${problem}`)
      return { sessionId: sessionId(o), command, notify: flag(o, 'notify') }
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
    'sessions.refreshModels': session,
    'sessions.rename': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), title: o.title === null ? null : string(o, 'title', 200) }
    },
    'sessions.close': session,
    'sessions.pin': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), pinned: flag(o, 'pinned') }
    },
    'sessions.archive': (params) => {
      const o = fields(params)
      const subSessions = optionalFlag(o, 'subSessions')
      return { sessionId: sessionId(o), ...(subSessions === undefined ? {} : { subSessions }) }
    },
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
    'plugins.list': none,
    'plugins.inspect': (params) => ({ source: pluginSource(fields(params).source, platform) }),
    'plugins.install': pluginToken,
    'plugins.discard': pluginToken,
    'plugins.uninstall': installedPlugin,
    'plugins.setEnabled': (params) => ({
      ...installedPlugin(params),
      enabled: flag(fields(params), 'enabled'),
    }),
    'plugins.setSetting': (params) => {
      const o = fields(params)
      const value = o.value
      if (typeof value !== 'boolean' && typeof value !== 'string') {
        throw invalidParams('value must be a text or true or false')
      }
      if (typeof value === 'string' && value.length > PLUGIN_SETTING_CHARS) {
        throw invalidParams(t('validate.tooLong', { key: 'value', max: PLUGIN_SETTING_CHARS }))
      }
      return { ...installedPlugin(params), key: pluginSettingKey(o), value }
    },
    'plugins.setSecret': (params) => {
      const o = fields(params)
      const value = o.value ?? null
      if (value !== null && typeof value !== 'string') {
        throw invalidParams('value must be a text, or null to clear the secret')
      }
      if (value !== null && Buffer.byteLength(value) > PLUGIN_SECRET_BYTES) {
        throw invalidParams(t('validate.tooLong', { key: 'value', max: PLUGIN_SECRET_BYTES }))
      }
      if (value === '') throw invalidParams(t('validate.empty', { key: 'value' }))
      return { ...installedPlugin(params), key: pluginSettingKey(o), value }
    },
    'plugins.setChannelKinds': pluginChannelKinds,
    'plugins.reload': installedPlugin,
    'plugins.checkUpdates': (params) =>
      params === undefined || params === null || fields(params).pluginId === undefined
        ? {}
        : installedPlugin(params),
    'plugins.applyUpdate': installedPlugin,
    'plugins.declineUpdate': installedPlugin,
    'plugins.rollBack': installedPlugin,
    'plugins.viewData': (params) => ({ ...pluginView(params), params: viewParams(params) }),
    'plugins.viewAction': pluginViewAction,
    'plugins.actionRun': pluginActionRun,
    'plugins.refs': none,
    'plugins.mentionSearch': (params) => {
      const o = fields(params)
      const query = o.query
      if (typeof query !== 'string' || query.length > PLUGIN_REF_LIMITS.query) {
        throw invalidParams(`query must be text of at most ${PLUGIN_REF_LIMITS.query} characters`)
      }
      return { ...installedPlugin(params), source: refId(o, 'source'), query }
    },
    'plugins.linkCard': (params) => {
      const o = fields(params)
      return {
        ...installedPlugin(params),
        link: refId(o, 'link'),
        url: string(o, 'url', URL_CHARS),
      }
    },
    'plugins.resources': (params) => {
      const { kind } = fields(params)
      if (kind !== 'commands' && kind !== 'roles' && kind !== 'themes' && kind !== 'templates') {
        throw invalidParams('kind must be commands, roles, themes or templates')
      }
      return { kind }
    },
    'commands.list': none,
    'roles.list': none,
    'workflows.list': none,
    'workflows.read': (params) => ({ workflowId: workflowId(fields(params)) }),
    'workflows.add': workflowAddSource,
    'workflows.update': (params) => ({ workflowId: workflowId(fields(params)) }),
    'workflows.approve': (params) => {
      const o = fields(params)
      const hash = string(o, 'hash', 64)
      if (!WORKFLOW_HASH.test(hash)) throw invalidParams('hash must be a SHA-256 in hex')
      return { workflowId: workflowId(o), hash }
    },
    'workflows.remove': (params) => ({ workflowId: workflowId(fields(params)) }),
    'workflows.pin': (params) => {
      const o = fields(params)
      return { workflowId: workflowId(o), stepId: stepId(o), pick: stepPickOf(o.pick ?? null) }
    },
    'workflows.settings': none,
    'workflows.setSettings': workflowSettingsChange,
    'workflows.suggestions': (params) => ({ sessionId: sessionId(fields(params)) }),
    'workflows.suggestionFile': (params) => ({ id: suggestionId(fields(params)) }),
    'workflows.answerSuggestion': answerSuggestion,
    'tasks.list': none,
    'tasks.get': (params) => ({ taskId: taskId(fields(params)) }),
    'tasks.sessions': (params) => ({ taskId: taskId(fields(params)) }),
    'tasks.start': (params) => taskStart(params, platform),
    'tasks.review': (params) => {
      const o = fields(params)
      const note = optionalNote(o, 'note', TASK_NOTE_CHARS)
      return {
        taskId: taskId(o),
        roundId: string(o, 'roundId', 64),
        approve: flag(o, 'approve'),
        ...(note === undefined ? {} : { note }),
      }
    },
    'tasks.answer': (params) => {
      const o = fields(params)
      const note = optionalNote(o, 'note', TASK_NOTE_CHARS)
      return {
        taskId: taskId(o),
        roundId: string(o, 'roundId', 64),
        outcome: string(o, 'outcome', 60),
        ...(note === undefined ? {} : { note }),
      }
    },
    'tasks.retry': (params) => {
      const o = fields(params)
      const note = optionalNote(o, 'note', TASK_NOTE_CHARS)
      return { taskId: taskId(o), stepId: stepId(o), ...(note === undefined ? {} : { note }) }
    },
    'tasks.cancel': (params) => ({ taskId: taskId(fields(params)) }),
    'tasks.delete': (params) => ({ taskId: taskId(fields(params)) }),
    'tasks.note': (params) => {
      const o = fields(params)
      return { taskId: taskId(o), text: string(o, 'text', TASK_NOTE_CHARS) }
    },
    'tasks.pin': (params) => {
      const o = fields(params)
      return { taskId: taskId(o), stepId: stepId(o), pick: stepPickOf(o.pick ?? null) }
    },
    'tasks.saveWorkflow': (params) => ({ taskId: taskId(fields(params)) }),
    'tasks.publishWorkflow': (params) => ({ taskId: taskId(fields(params)) }),
    'tasks.update': (params) => {
      const o = fields(params)
      const title = optionalString(o, 'title', TASK_TITLE_CHARS)
      const pinned = optionalFlag(o, 'pinned')
      const archived = optionalFlag(o, 'archived')
      const unread = optionalFlag(o, 'unread')
      return {
        taskId: taskId(o),
        ...(title === undefined ? {} : { title }),
        ...(pinned === undefined ? {} : { pinned }),
        ...(archived === undefined ? {} : { archived }),
        ...(unread === undefined ? {} : { unread }),
      }
    },
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
    'git.status': watching,
    'git.unwatch': watching,
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
    'git.commitMessage': (params) => {
      const o = fields(params)
      return { projectPath: absolutePath(o, 'projectPath', platform), paths: gitPaths(o, 'paths') }
    },
    'git.pullRequestDraft': (params) => {
      const o = fields(params)
      return { projectPath: absolutePath(o, 'projectPath', platform), base: refName(o, 'base') }
    },
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
    'star.state': none,
    'star.add': none,
    'star.dismiss': none,
    'star.opened': none,
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
    'files.agentFolder': session,
    'files.readAgentFile': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), path: absolutePath(o, 'path', platform) }
    },
    'files.write': (params) => {
      const o = fields(params)
      // An empty file is text too, so `string` does not fit; the host checks the size in bytes.
      if (typeof o.text !== 'string') throw invalidParams('text must be a string')
      if (o.text.length > FILE_READ_LIMIT) throw invalidParams(t('validate.textTooLarge'))
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        path: relativePath(o, 'path', platform),
        text: o.text,
        version: o.version === null ? null : string(o, 'version', ID_CHARS),
      }
    },
    'files.create': (params) => {
      const o = fields(params)
      if (o.kind !== 'file' && o.kind !== 'folder')
        throw invalidParams('kind must be file or folder')
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        path: relativePath(o, 'path', platform),
        kind: o.kind,
      }
    },
    'files.rename': (params) => {
      const o = fields(params)
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        from: relativePath(o, 'from', platform),
        to: relativePath(o, 'to', platform),
      }
    },
    'files.copy': (params) => {
      const o = fields(params)
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        paths: relativePaths(o, 'paths', platform),
        folder: relativeFolder(o, 'folder', platform),
      }
    },
    'files.delete': (params) => {
      const o = fields(params)
      const permanently = optionalFlag(o, 'permanently')
      return {
        projectPath: absolutePath(o, 'projectPath', platform),
        paths: relativePaths(o, 'paths', platform),
        ...(permanently === undefined ? {} : { permanently }),
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
    'artifacts.changes': (params) => {
      const o = fields(params)
      const from = version(o, 'from')
      const to = version(o, 'to')
      if (from === to) throw invalidParams('from and to must be two different versions')
      return { id: artifactId(o), from, to }
    },
    'artifacts.rename': (params) => {
      const o = fields(params)
      const title = o.title
      if (typeof title !== 'string' || title.trim() === '' || longer(title, ARTIFACT_TITLE_CHARS)) {
        throw invalidParams(t('validate.artifactTitle', { max: ARTIFACT_TITLE_CHARS }))
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
    'artifacts.repin': (params) => {
      const o = fields(params)
      return { id: artifactId(o), threadId: threadId(o), anchor: commentAnchor(o.anchor) }
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
    'artifacts.view': (params) => {
      const o = fields(params)
      const page = o.page
      if (page !== null && (typeof page !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(page))) {
        throw invalidParams('page must be a canvas page id or null')
      }
      return { id: artifactId(o), page: page as string | null }
    },
    'artifacts.seen': (params) => {
      const o = fields(params)
      return { id: artifactId(o), version: version(o, 'version') }
    },
    'artifacts.setParams': (params) => {
      const o = fields(params)
      const values = o.values
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        throw invalidParams('values must be an object of parameter names and values')
      }
      const entries = Object.entries(values as Record<string, unknown>)
      if (entries.length === 0 || entries.length > PARAMS_MAX) {
        throw invalidParams(`values must set 1 to ${PARAMS_MAX} parameters`)
      }
      for (const [name, value] of entries) {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(name))
          throw invalidParams(`${name} is not a parameter name`)
        if (
          typeof value !== 'boolean' &&
          !(typeof value === 'number' && Number.isFinite(value)) &&
          !(typeof value === 'string' && value.length <= 200)
        ) {
          throw invalidParams(`${name} must be a string, a number or true or false`)
        }
      }
      return {
        id: artifactId(o),
        baseVersion: version(o, 'baseVersion'),
        path: htmlPath(o, 'path'),
        values: values as Record<string, ParamValue>,
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
    'browser.handedBack': (params) => {
      const o = fields(params)
      const durationMs = o.durationMs
      if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0) {
        throw invalidParams('durationMs must be a whole number of milliseconds')
      }
      return { sessionId: sessionId(o), durationMs }
    },
    'control.answerAsk': (params) => {
      const o = fields(params)
      if (!isControlOutcome(o.outcome)) throw invalidParams('outcome must be done or skipped')
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        outcome: o.outcome,
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
    'devices.revokeAccess': (params) => {
      const o = fields(params)
      const deviceId = string(o, 'deviceId', 256)
      if (!/^(ios-sim|ios|android|avd):[\w.:\-@]+$/.test(deviceId)) {
        throw invalidParams('deviceId is not a device id')
      }
      return { sessionId: sessionId(o), deviceId }
    },
    'surfaces.answerAccess': (params) => {
      const o = fields(params)
      if (!isSurfaceAccessDecision(o.decision))
        throw invalidParams('decision must be allow or deny')
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision,
      }
    },
    'terminals.revokeAccess': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), terminalId: string(o, 'terminalId', ID_CHARS) }
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
    'sessions.answerProjectMcp': (params) => {
      const o = fields(params)
      if (o.decision !== 'use' && o.decision !== 'all' && o.decision !== 'skip') {
        throw invalidParams('decision must be use, all or skip')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision,
      }
    },
    'sessions.answerProjectHooks': (params) => {
      const o = fields(params)
      if (o.decision !== 'use' && o.decision !== 'all' && o.decision !== 'skip') {
        throw invalidParams('decision must be use, all or skip')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision,
      }
    },
    'sessions.answerReport': (params) => {
      const o = fields(params)
      const outcome = fields(o.outcome)
      let parsed: ProblemReportOutcome
      if (outcome.kind === 'sent') {
        parsed = { kind: 'sent', reportId: string(outcome, 'reportId', ID_CHARS) }
      } else if (outcome.kind === 'saved' || outcome.kind === 'skipped') {
        parsed = { kind: outcome.kind }
      } else {
        throw invalidParams('outcome.kind must be sent, saved or skipped')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        outcome: parsed,
      }
    },
    'sessions.answerMemory': (params) => {
      const o = fields(params)
      if (o.decision !== 'remember' && o.decision !== 'skip') {
        throw invalidParams('decision must be remember or skip')
      }
      return {
        sessionId: sessionId(o),
        entryId: string(o, 'entryId', ID_CHARS),
        decision: o.decision,
      }
    },
    'sessions.undoMemory': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), entryId: string(o, 'entryId', ID_CHARS) }
    },
    'memory.overview': none,
    'memory.list': (params) => ({ scope: memoryScope(fields(params).scope, platform) }),
    'memory.save': (params) => {
      const o = fields(params)
      if (o.id !== null && o.id !== undefined && typeof o.id !== 'string') {
        throw invalidParams('id must be a memory id or null')
      }
      return {
        scope: memoryScope(o.scope, platform),
        id: o.id === null || o.id === undefined ? null : memoryId(o),
        draft: memoryDraft(o.draft),
      }
    },
    'memory.remove': (params) => {
      const o = fields(params)
      return { scope: memoryScope(o.scope, platform), id: memoryId(o) }
    },
    'memory.moveToGlobal': (params) => {
      const o = fields(params)
      return { project: absolutePath(o, 'project', platform), id: memoryId(o) }
    },
    'memory.setEnabled': (params) => ({ enabled: flag(fields(params), 'enabled') }),
    'memory.importScan': none,
    'memory.import': (params) => {
      const o = fields(params)
      const { sources, global } = o
      if (!Array.isArray(sources) || sources.length > MEMORY_IMPORT_SOURCES) {
        throw invalidParams(`sources must be an array of at most ${MEMORY_IMPORT_SOURCES}`)
      }
      if (!Array.isArray(global) || global.length > MEMORY_IMPORT_KEYS) {
        throw invalidParams(`global must be an array of at most ${MEMORY_IMPORT_KEYS} keys`)
      }
      return {
        sources: sources.map((item: unknown) => {
          const source = fields(item)
          return {
            agentId: agentId(source),
            project: absolutePath(source, 'project', platform),
          }
        }),
        global: global.map((key: unknown) => string({ key }, 'key', ID_CHARS)),
      }
    },
    'computer.stop': (params) => ({ sessionId: sessionId(fields(params)) }),
    'computer.takeOver': (params) => ({ sessionId: sessionId(fields(params)) }),
    'computer.handBack': (params) => ({ sessionId: sessionId(fields(params)) }),
    'computer.show': (params) => ({ sessionId: sessionId(fields(params)) }),
    'computer.declineSetup': (params) => {
      const o = fields(params)
      return { sessionId: sessionId(o), entryId: string(o, 'entryId', ID_CHARS) }
    },
  }
}
