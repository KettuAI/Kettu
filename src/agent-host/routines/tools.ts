// The Routine tools of Kettu's MCP service: an agent lists the Routines of the host its session
// runs on, and creates, changes, deletes or runs one for the user. Listing never asks; the other
// four always wait for the user's answer in a card, in Full access too, since a Routine later runs
// on its own while nobody watches and spends the user's plan. They keep the rules of the Routines
// page: only Claude Code and Codex agents, a schedule that runs, and its defaults where none is
// named.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { AgentOptions, AgentStatus, RoutineList } from '@shared/agent-host'
import { harnessOf, type AgentId, type HarnessId } from '@shared/agents'
import { CONTROL_WAIT_MS } from '@shared/control'
import {
  DEFAULT_KEPT_RUN_SESSIONS,
  DEFAULT_SCOPE,
  DEFAULT_TIME_LIMIT,
  isTimeLimit,
  PROMPT_CHARS,
  ROUTINE_ID,
  ROUTINE_NAME_CHARS,
  ROUTINE_NAME_FROM_PROMPT,
  TIME_LIMITS,
  WORKING_RUNS,
  type PermissionScope,
  type Routine,
  type RoutineChanges,
  type RoutineDraft,
  type RoutineOption,
  type RoutineRun,
  type RoutineView,
  type Schedule,
} from '@shared/routines'
import { validateSchedule, type ScheduleProblem } from '@shared/schedule'
import type {
  ConfigOption,
  RoutineAction,
  RoutineCardFields,
  RoutineChangeEntry,
  RoutineChangeOutcome,
} from '@shared/thread'
import type { Caller } from '../artifacts/tools'
import { pickedValues, type StartPick } from '../started-options'
import { modelOption } from '../workflow/host-agents'
import { routineName } from './manager'

export const LIST_ROUTINES = 'list_routines'
export const CREATE_ROUTINE = 'create_routine'
export const UPDATE_ROUTINE = 'update_routine'
export const DELETE_ROUTINE = 'delete_routine'
export const RUN_ROUTINE = 'run_routine'
/** Allowed when the agent starts: Kettu's own card is the only ask. */
export const ROUTINE_TOOL_NAMES = [
  LIST_ROUTINES,
  CREATE_ROUTINE,
  UPDATE_ROUTINE,
  DELETE_ROUTINE,
  RUN_ROUTINE,
]
/** The tools that wait for the user's answer in a card before they act. */
export const ROUTINE_ASKING_TOOLS = [CREATE_ROUTINE, UPDATE_ROUTINE, DELETE_ROUTINE, RUN_ROUTINE]
/** How long a card waits before nothing happens. */
export const ROUTINE_WAIT_MS = 10 * 60_000
/** The harnesses Kettu can hold to a Routine's permissions, and so the only ones that run one. */
export const ROUTINE_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex']

const AGENT_CHARS = 120
const OPTION_CHARS = 200
const PATH_CHARS = 4096
const CRON_CHARS = 200
/** The option categories a Routine keeps, as the Routines page saves them. */
const KEPT_CATEGORIES: ReadonlySet<ConfigOption['category']> = new Set([
  'model',
  'model_config',
  'thought_level',
])

const SCHEDULE: Record<string, object> = {
  schedule: {
    type: 'object',
    description:
      "When it runs, in this computer's local time. One of: " +
      '{"kind":"once","at":"2026-11-27T09:00"}, which runs once and then turns off; ' +
      '{"kind":"weekly","days":[1,2,3,4,5],"time":"09:00"}, 0 being Sunday; ' +
      '{"kind":"every","minutes":120}, every 5 to 720 minutes counted from now; ' +
      '{"kind":"cron","expression":"0 9 * * 1"}, five fields, its runs at least 5 minutes apart.',
    properties: {
      kind: { type: 'string', enum: ['once', 'weekly', 'every', 'cron'] },
      at: { type: 'string', description: 'For once: the local date and time, YYYY-MM-DDTHH:mm.' },
      days: {
        type: 'array',
        items: { type: 'integer', minimum: 0, maximum: 6 },
        minItems: 1,
        maxItems: 7,
        description: 'For weekly: the days, 0 Sunday to 6 Saturday.',
      },
      time: { type: 'string', description: 'For weekly: the local time, HH:mm.' },
      minutes: { type: 'integer', minimum: 5, maximum: 720, description: 'For every.' },
      expression: { type: 'string', maxLength: CRON_CHARS, description: 'For cron.' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
}

/** The settings a Routine takes, for creating one and changing one. */
const SETTINGS: Record<string, object> = {
  name: {
    type: 'string',
    maxLength: ROUTINE_NAME_CHARS,
    description: `Its name; without it, the prompt's first line cut to ${ROUTINE_NAME_FROM_PROMPT} characters.`,
  },
  prompt: {
    type: 'string',
    minLength: 1,
    maxLength: PROMPT_CHARS,
    description: 'What the agent is told each time it runs, sent as written.',
  },
  ...SCHEDULE,
  agent: {
    type: 'string',
    maxLength: AGENT_CHARS,
    description:
      'The agent its runs start, an id list_agents gives; only Claude Code and Codex agents run ' +
      'Routines. Without it on create, your own agent.',
  },
  model: {
    type: 'string',
    maxLength: OPTION_CHARS,
    description:
      'The model, an id list_agents gives for the agent; without it, the one the user last chose for it.',
  },
  effort: {
    type: 'string',
    maxLength: OPTION_CHARS,
    description: 'The effort, one list_agents gives for that model.',
  },
  project: {
    type: ['string', 'null'],
    maxLength: PATH_CHARS,
    description:
      "The folder of one of Kettu's projects on this computer, where its runs work; null for " +
      "the Routine's own empty folder. Without it on create, your session's project.",
  },
  scope: {
    type: 'string',
    enum: ['read', 'edit', 'commands'],
    description:
      'What its runs may do without asking: read (read and search the project), edit (also ' +
      'change files inside it) or commands (also run commands). read by default; pick the ' +
      'narrowest that does the job.',
  },
  web: {
    type: 'boolean',
    description: 'Whether its runs may fetch pages and search the web; false by default.',
  },
  timeLimitMinutes: {
    type: 'integer',
    enum: [...TIME_LIMITS],
    description: `How long a run may work before it stops: ${TIME_LIMITS.join(', ')} minutes; ${DEFAULT_TIME_LIMIT} by default.`,
  },
}

const ROUTINE_ARG: Record<string, object> = {
  routine: {
    type: 'string',
    pattern: ROUTINE_ID.source,
    description: "The Routine's id from list_routines, such as r-0123456789ab.",
  },
}

const WAITS =
  'It waits for the user to answer a card in this session, in every mode, Full access too, and ' +
  'nothing happens until they approve; declined or unanswered for 10 minutes, nothing happens. ' +
  'This call returns within a minute: if it says the user has not answered yet, call it again ' +
  'with the same arguments, which shows no second card and returns what became of this one.'

export const ROUTINE_TOOLS: Tool[] = [
  {
    name: LIST_ROUTINES,
    title: "List Kettu's Routines",
    description:
      "Lists the Routines of the computer this session runs on, Kettu's prompts that run on a " +
      'schedule, each in a session of its own: their ids, names, schedules and next runs, ' +
      'whether each is on, its agent and model, project, permissions and time limit, and its ' +
      'latest run. Call it before creating one, so you change an existing Routine instead of ' +
      'making a second.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: CREATE_ROUTINE,
    title: 'Create a Routine',
    description:
      'Creates a Routine on this computer, only when the user asked for something to run ' +
      `regularly or later: a prompt Kettu sends on a schedule, each run a session of its own. ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: SETTINGS,
      required: ['prompt', 'schedule'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: UPDATE_ROUTINE,
    title: 'Change a Routine',
    description:
      'Changes the settings you name of a Routine, or turns it on or off with enabled, only ' +
      `when the user asked. A schedule replaces the whole schedule. ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...ROUTINE_ARG,
        ...SETTINGS,
        enabled: { type: 'boolean', description: 'Turns the Routine on or off.' },
      },
      required: ['routine'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: DELETE_ROUTINE,
    title: 'Delete a Routine',
    description:
      'Deletes a Routine and the sessions of its runs, only when the user asked. The card says ' +
      `how many run sessions go with it. ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: ROUTINE_ARG,
      required: ['routine'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: RUN_ROUTINE,
    title: 'Run a Routine now',
    description:
      'Starts a run of a Routine now, as Run now on its page does, only when the user asked; it ' +
      'fails while the Routine already has a run going. The run works in a session of its own ' +
      `within the Routine's permissions. ${WAITS}`,
    inputSchema: {
      type: 'object',
      properties: ROUTINE_ARG,
      required: ['routine'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

const NAMES = new Set(ROUTINE_TOOL_NAMES)

export function isRoutineToolName(name: string): boolean {
  return NAMES.has(name)
}

/** What a card asks, as the host adds it to the thread. */
export type RoutineAsk = Pick<
  RoutineChangeEntry,
  'action' | 'routineId' | 'routine' | 'before' | 'sessions'
>

/** The user's answer to a card, or how it ended without one. */
export type RoutineAnswer = { decision: 'confirm' } | { decision: 'decline' | 'expired' | 'ended' }

export interface RoutineToolsDeps {
  list(): Promise<RoutineList>
  create(draft: RoutineDraft): Promise<RoutineView>
  update(routineId: string, changes: RoutineChanges): Promise<RoutineView>
  delete(routineId: string): Promise<void>
  runNow(routineId: string): Promise<RoutineRun>
  /** The agents of this host. */
  agents(): readonly AgentStatus[]
  /** The agent's cached options, which list its models and efforts; null before a read. */
  agentOptions(agentId: AgentId): AgentOptions | null
  /** Reads the agent's options in a hidden session, as New session does for a new agent. */
  readOptions(agentId: AgentId): Promise<void>
  sessionAgent(sessionId: string): AgentId | null
  /** The project of Kettu's the session works in; null for one without, or a scratch folder. */
  sessionProject(sessionId: string): string | null
  /** The canonical path of one of Kettu's projects on this host; null when it is none. */
  project(path: string): Promise<string | null>
  /** Adds the card to the thread; null for a session Kettu holds no thread for. */
  ask(
    sessionId: string,
    ask: RoutineAsk,
  ): { entryId: string; answer: Promise<RoutineAnswer> } | null
  settle(sessionId: string, entryId: string, outcome: RoutineChangeOutcome): void
  now?(): number
}

/** A card a call opened, which the agent's next call with the same arguments picks up. */
interface CardJob {
  key: string
  action: RoutineAction
  name: string
  confirmed: boolean
  result: Promise<CallToolResult>
}

class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

/** What applying an approved card does, and the words of its result. */
interface Plan {
  ask: RoutineAsk
  apply(): Promise<{ routineId: string; text: string; data: Record<string, unknown> }>
}

const ACTION_WORDS: Record<
  RoutineAction,
  { tool: string; button: string; done: string; verb: string }
> = {
  create: { tool: CREATE_ROUTINE, button: 'Create', done: 'created', verb: 'create' },
  update: { tool: UPDATE_ROUTINE, button: 'Change', done: 'changed', verb: 'change' },
  delete: { tool: DELETE_ROUTINE, button: 'Delete', done: 'deleted', verb: 'delete' },
  run: { tool: RUN_ROUTINE, button: 'Run', done: 'run', verb: 'run' },
}

const LEVEL_WORDS: Record<PermissionScope['level'], string> = {
  read: 'read only',
  edit: 'edit the project',
  commands: 'edit and run commands',
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * A result whose words go in its structured content too, since an agent that reads the structured
 * content alone, as Claude Code does, would miss what to do next.
 */
function reply(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { message: text, ...data } }
}

function failed(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Refusal('The arguments must be an object.')
  }
  const o = input as Record<string, unknown>
  const unknown = Object.keys(o).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw new Refusal(`Unknown argument ${unknown}.`)
  return o
}

/** Keys in a fixed order, so two equal objects read the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(o[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** An instant in this computer's local time, as the schedules are written. */
export function localTime(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A schedule in English words, for agents. */
export function scheduleText(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'once':
      return `once, at ${schedule.at.replace('T', ' ')}`
    case 'every': {
      const every =
        schedule.minutes % 60 === 0
          ? `every ${schedule.minutes / 60} hour${schedule.minutes === 60 ? '' : 's'}`
          : `every ${schedule.minutes} minutes`
      return `${every}, counted from ${localTime(schedule.from)}`
    }
    case 'weekly': {
      const days = [...schedule.days].sort((a, b) => a - b)
      const when =
        days.length === 7
          ? 'every day'
          : days.join() === '1,2,3,4,5'
            ? 'weekdays'
            : days.map((day) => DAY_NAMES[day]).join(', ')
      return `${when} at ${schedule.time}`
    }
    case 'cron':
      return `cron "${schedule.expression.trim()}"`
  }
}

function problemText(problem: ScheduleProblem): string {
  switch (problem.reason) {
    case 'format':
      return `its ${problem.field} is not valid (${problem.detail})`
    case 'range':
      return `its ${problem.field} ${problem.detail} is outside ${problem.min} to ${problem.max}`
    case 'past':
      return 'that time has already passed'
    case 'never':
      return 'it never runs'
    case 'frequent':
      return 'its runs would come less than 5 minutes apart'
    case 'empty':
      return `it names no ${problem.field}`
  }
}

/** A schedule from the tool's arguments, checked as the Routines page checks one. */
function scheduleOf(value: unknown, now: number): Schedule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Refusal('schedule must be an object with a kind; see the tool for the four kinds.')
  }
  const o = value as Record<string, unknown>
  const only = (keys: string[]) => fields(o, ['kind', ...keys])
  let schedule: Schedule
  switch (o.kind) {
    case 'once': {
      const s = only(['at'])
      if (typeof s.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s.at)) {
        throw new Refusal('A once schedule needs at, the local date and time as YYYY-MM-DDTHH:mm.')
      }
      schedule = { kind: 'once', at: s.at }
      break
    }
    case 'weekly': {
      const s = only(['days', 'time'])
      if (
        !Array.isArray(s.days) ||
        s.days.length === 0 ||
        !s.days.every((day) => Number.isInteger(day))
      ) {
        throw new Refusal('A weekly schedule needs days, a list of 0 (Sunday) to 6 (Saturday).')
      }
      if (typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) {
        throw new Refusal('A weekly schedule needs time, the local time as HH:mm.')
      }
      schedule = { kind: 'weekly', days: s.days as number[], time: s.time }
      break
    }
    case 'every': {
      const s = only(['minutes'])
      if (typeof s.minutes !== 'number' || !Number.isInteger(s.minutes)) {
        throw new Refusal('An every schedule needs minutes, a whole number from 5 to 720.')
      }
      schedule = { kind: 'every', minutes: s.minutes, from: now }
      break
    }
    case 'cron': {
      const s = only(['expression'])
      if (
        typeof s.expression !== 'string' ||
        s.expression.trim() === '' ||
        s.expression.length > CRON_CHARS
      ) {
        throw new Refusal('A cron schedule needs expression, five fields.')
      }
      schedule = { kind: 'cron', expression: s.expression.trim() }
      break
    }
    default:
      throw new Refusal('schedule.kind must be once, weekly, every or cron.')
  }
  const problem = validateSchedule(schedule, now)
  if (problem)
    throw new Refusal(`Nothing was done: the schedule cannot run, since ${problemText(problem)}.`)
  return schedule
}

function optionalString(o: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = o[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) {
    throw new Refusal(`${key} must be a text of at most ${max} characters.`)
  }
  return value
}

function promptOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > PROMPT_CHARS) {
    throw new Refusal(`prompt must be a text of 1 to ${PROMPT_CHARS} characters.`)
  }
  return value
}

function levelOf(value: unknown): PermissionScope['level'] {
  if (value !== 'read' && value !== 'edit' && value !== 'commands') {
    throw new Refusal('scope must be read, edit or commands.')
  }
  return value
}

function webOf(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Refusal('web must be true or false.')
  return value
}

function timeLimitOf(value: unknown): Routine['timeLimitMinutes'] {
  if (!isTimeLimit(value)) {
    throw new Refusal(`timeLimitMinutes must be one of ${TIME_LIMITS.join(', ')}.`)
  }
  return value
}

function sameOptions(a: readonly RoutineOption[], b: readonly RoutineOption[]): boolean {
  const key = (options: readonly RoutineOption[]) =>
    stable([...options].sort((x, y) => x.id.localeCompare(y.id)))
  return key(a) === key(b)
}

function sameSchedule(a: Schedule, b: Schedule): boolean {
  return stable(a) === stable(b)
}

export class RoutineTools {
  /** The cards calls opened, by session. */
  private readonly jobs = new Map<string, CardJob[]>()

  constructor(private readonly deps: RoutineToolsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The session's turn ended: a later turn's call with the same arguments asks again. */
  turnEnded(sessionId: string): void {
    this.jobs.delete(sessionId)
  }

  /** Serves a call; a refusal becomes a tool error whose text says why. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    const deadline = Date.now() + CONTROL_WAIT_MS
    try {
      if (name === LIST_ROUTINES) {
        fields(input, [])
        return await this.list()
      }
      if (!ROUTINE_ASKING_TOOLS.includes(name)) throw new Error(`Unknown tool ${name}`)
      const key = `${name}:${stable(input ?? {})}`
      const waiting = this.jobs.get(caller.sessionId)?.find((job) => job.key === key)
      if (waiting) return await this.follow(caller.sessionId, waiting, deadline)
      const plan =
        name === CREATE_ROUTINE
          ? await this.planCreate(caller, input)
          : name === UPDATE_ROUTINE
            ? await this.planUpdate(input)
            : name === DELETE_ROUTINE
              ? await this.planDelete(input)
              : await this.planRun(input)
      if ('result' in plan) return plan.result
      return await this.open(caller.sessionId, key, plan)
    } catch (error) {
      if (error instanceof Refusal) return failed(error.message)
      throw error
    }
  }

  private async list(): Promise<CallToolResult> {
    const { routines, problem } = await this.deps.list()
    const note = problem
      ? ` Kettu could not read the Routines file (${problem.reason}), so the list may be incomplete.`
      : ''
    if (routines.length === 0) {
      return reply(`There are no Routines on this computer.${note}`, { routines: [] })
    }
    const lines = routines.map((routine) => this.describe(routine))
    return reply(
      `${routines.length} Routine${routines.length === 1 ? '' : 's'} on this computer, in its local time:${note}\n${lines.map((l) => l.line).join('\n')}`,
      { routines: lines.map((l) => l.data) },
    )
  }

  private describe(view: RoutineView): { line: string; data: Record<string, unknown> } {
    const card = this.cardOf(view)
    const schedule = view.trigger.schedule
    const state =
      view.state === 'paused'
        ? `paused at ${this.agentName(view.agentId)}'s plan limit`
        : view.state === 'done'
          ? 'off, its one run done'
          : view.state
    const next = view.nextRunAt === null ? '' : `, next run ${localTime(view.nextRunAt)}`
    const model = [card.model, card.effort].filter(Boolean).join(', ')
    const run = view.activeRun ?? view.lastRun
    const runText = run
      ? `${view.activeRun ? 'running now' : 'latest run'}: ${run.status}` +
        (run.startedAt !== null ? ` at ${localTime(run.startedAt)}` : '') +
        (run.error ? ` (${run.error.message})` : '')
      : 'no runs yet'
    const line =
      `- ${view.id} "${view.name}": ${state}${next}\n` +
      `  schedule: ${scheduleText(schedule)}\n` +
      `  agent ${view.agentId} (${this.agentName(view.agentId)}${model ? `, ${model}` : ''}); ` +
      `project ${view.projectPath ?? "the Routine's own folder"}; ` +
      `scope ${view.scope.level} (${LEVEL_WORDS[view.scope.level]}), ${view.scope.web ? 'web' : 'no web'}; ` +
      `time limit ${view.timeLimitMinutes} minutes\n` +
      `  ${runText}; ${view.runs} run${view.runs === 1 ? '' : 's'} on record, ${view.sessions} with a session`
    return {
      line,
      data: {
        id: view.id,
        name: view.name,
        state: view.state,
        enabled: view.enabled,
        schedule,
        scheduleText: scheduleText(schedule),
        nextRun: view.nextRunAt === null ? null : localTime(view.nextRunAt),
        agent: view.agentId,
        model: card.model,
        effort: card.effort,
        project: view.projectPath,
        scope: view.scope.level,
        web: view.scope.web,
        timeLimitMinutes: view.timeLimitMinutes,
        activeRun: view.activeRun ? runData(view.activeRun) : null,
        lastRun: view.lastRun ? runData(view.lastRun) : null,
        runs: view.runs,
        sessions: view.sessions,
      },
    }
  }

  private agentName(agentId: AgentId): string {
    return this.deps.agents().find((status) => status.id === agentId)?.name ?? agentId
  }

  /** The agent a Routine may run, or why it may not. */
  private routineAgent(agentId: string): AgentId {
    const status = this.deps
      .agents()
      .find((s) => s.id === agentId && s.registered !== false && !s.uninstalled)
    if (!status) {
      throw new Refusal(
        `Nothing was done: there is no agent ${agentId} on this computer. ${this.eligibleText()}`,
      )
    }
    if (!ROUTINE_HARNESSES.includes(harnessOf(status.id))) {
      throw new Refusal(
        `Nothing was done: ${status.name} cannot run Routines. Only Claude Code and Codex agents ` +
          `do, since Kettu can hold only theirs to a Routine's permissions. ${this.eligibleText()}`,
      )
    }
    if (status.disabled) {
      throw new Refusal(
        `Nothing was done: ${status.name} is turned off in Settings › Agents. ${this.eligibleText()}`,
      )
    }
    return status.id
  }

  private eligibleText(): string {
    const eligible = this.deps
      .agents()
      .filter(
        (s) =>
          s.registered !== false &&
          !s.uninstalled &&
          !s.disabled &&
          ROUTINE_HARNESSES.includes(harnessOf(s.id)),
      )
    return eligible.length === 0
      ? 'This computer has no Claude Code or Codex agent turned on.'
      : `Agents that run Routines here: ${eligible.map((s) => `${s.id} (${s.name})`).join(', ')}.`
  }

  /** The agent's options, read first when Kettu has none and a model or effort is asked for. */
  private async optionsOf(agentId: AgentId, pick: StartPick): Promise<AgentOptions | null> {
    const cached = this.deps.agentOptions(agentId)
    if (cached || (pick.model === undefined && pick.effort === undefined)) return cached
    const name = this.agentName(agentId)
    try {
      await this.deps.readOptions(agentId)
    } catch (error) {
      throw new Refusal(
        `Kettu could not read the models of ${name}: ${(error as Error).message.replace(/\.$/, '')}. ` +
          'Leave model and effort out, or try again.',
      )
    }
    const options = this.deps.agentOptions(agentId)
    if (!options) {
      throw new Refusal(
        `Kettu has not read the models of ${name} yet; it may need the user to sign in. ` +
          'Leave model and effort out.',
      )
    }
    return options
  }

  /** The option values a Routine keeps, from `carried` with the pick, as the page saves them. */
  private async routineOptions(
    agentId: AgentId,
    carried: Record<string, string | boolean>,
    pick: StartPick,
  ): Promise<RoutineOption[]> {
    const options = await this.optionsOf(agentId, pick)
    const out = pickedValues(options, carried, pick, { id: agentId, name: this.agentName(agentId) })
    if ('error' in out) throw new Refusal(`Nothing was done: ${out.error}`)
    const kept = new Set(
      [...(options?.config ?? []), ...Object.values(options?.levels ?? {})]
        .filter((option) => KEPT_CATEGORIES.has(option.category))
        .map((option) => option.id),
    )
    return Object.entries(out.values)
      .filter(([id]) => kept.has(id) || options === null)
      .map(([id, value]) => ({ id, value }))
  }

  /** The values the user last chose for the agent, of the kinds a Routine keeps. */
  private remembered(agentId: AgentId): Record<string, string | boolean> {
    const options = this.deps.agentOptions(agentId)
    if (!options) return {}
    const kept = new Set(
      options.config.filter((o) => KEPT_CATEGORIES.has(o.category)).map((o) => o.id),
    )
    return Object.fromEntries(Object.entries(options.remembered).filter(([id]) => kept.has(id)))
  }

  /** The model's and effort's names in the agent's menus, for a Routine's option values. */
  private optionNames(
    agentId: AgentId,
    options: readonly RoutineOption[],
  ): { model: string | null; effort: string | null } {
    const cached = this.deps.agentOptions(agentId)
    const values = new Map(options.map((o) => [o.id, o.value]))
    const named = (option: ConfigOption | undefined): string | null => {
      const value = option ? values.get(option.id) : undefined
      if (typeof value !== 'string') return null
      return option!.choices?.find((choice) => choice.value === value)?.name ?? value
    }
    const model = modelOption(cached)
    const modelValue = model ? values.get(model.id) : undefined
    const level = [
      ...(typeof modelValue === 'string' && cached?.levels[modelValue]
        ? [cached.levels[modelValue]]
        : []),
      ...(cached?.config.filter((o) => o.category === 'thought_level') ?? []),
    ].find((o) => values.has(o.id))
    return { model: named(model), effort: named(level) }
  }

  private cardOf(
    routine: Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'checkedThrough'>,
  ): RoutineCardFields {
    const names = this.optionNames(routine.agentId, routine.options)
    return {
      name: routine.name,
      prompt: routine.prompt,
      schedule: routine.trigger.schedule,
      projectPath: routine.projectPath,
      agentId: routine.agentId,
      model: names.model,
      effort: names.effort,
      scope: routine.scope,
      timeLimitMinutes: routine.timeLimitMinutes,
      enabled: routine.enabled,
    }
  }

  private async projectOf(value: unknown): Promise<string | null> {
    if (value === null) return null
    if (typeof value !== 'string' || value.length === 0 || value.length > PATH_CHARS) {
      throw new Refusal("project must be a project's folder, or null for the Routine's own folder.")
    }
    const found = await this.deps.project(value)
    if (found === null) {
      throw new Refusal(
        `Nothing was done: ${value} is not one of Kettu's projects on this computer. Name a ` +
          "project's folder as the sidebar lists it, or null for the Routine's own folder.",
      )
    }
    return found
  }

  private async routineView(input: Record<string, unknown>): Promise<RoutineView> {
    const id = input.routine
    if (typeof id !== 'string' || !ROUTINE_ID.test(id)) {
      throw new Refusal(
        "routine must be a Routine's id from list_routines, such as r-0123456789ab.",
      )
    }
    const { routines } = await this.deps.list()
    const view = routines.find((routine) => routine.id === id)
    if (!view) {
      throw new Refusal(
        `There is no Routine ${id} on this computer. Call list_routines for the ids.`,
      )
    }
    return view
  }

  private async planCreate(
    caller: Caller,
    input: unknown,
  ): Promise<Plan | { result: CallToolResult }> {
    const o = fields(input, Object.keys(SETTINGS))
    const now = this.now()
    const prompt = promptOf(o.prompt)
    if (o.schedule === undefined) throw new Refusal('schedule is missing: say when it runs.')
    const schedule = scheduleOf(o.schedule, now)
    const name = optionalString(o, 'name', ROUTINE_NAME_CHARS) ?? ''
    let agentId: AgentId
    if (o.agent !== undefined) {
      const given = optionalString(o, 'agent', AGENT_CHARS)!
      agentId = this.routineAgent(given)
    } else {
      const own = this.deps.sessionAgent(caller.sessionId)
      if (own === null || !ROUTINE_HARNESSES.includes(harnessOf(own))) {
        throw new Refusal(
          `agent is missing, and your own agent cannot run Routines. ${this.eligibleText()}`,
        )
      }
      agentId = this.routineAgent(own)
    }
    const pick: StartPick = {
      ...(o.model !== undefined ? { model: optionalString(o, 'model', OPTION_CHARS)! } : {}),
      ...(o.effort !== undefined ? { effort: optionalString(o, 'effort', OPTION_CHARS)! } : {}),
    }
    const options = await this.routineOptions(agentId, this.remembered(agentId), pick)
    const projectPath =
      'project' in o ? await this.projectOf(o.project) : this.deps.sessionProject(caller.sessionId)
    const scope: PermissionScope = {
      level: o.scope === undefined ? DEFAULT_SCOPE.level : levelOf(o.scope),
      web: o.web === undefined ? DEFAULT_SCOPE.web : webOf(o.web),
    }
    const draft: RoutineDraft = {
      name,
      prompt,
      agentId,
      projectPath,
      options,
      trigger: { kind: 'schedule', schedule },
      scope,
      timeLimitMinutes:
        o.timeLimitMinutes === undefined ? DEFAULT_TIME_LIMIT : timeLimitOf(o.timeLimitMinutes),
      keptRunSessions: DEFAULT_KEPT_RUN_SESSIONS,
    }
    const routine = this.cardOf({ ...draft, name: routineName(name, prompt), enabled: true })
    return {
      ask: { action: 'create', routineId: null, routine, before: null, sessions: null },
      apply: async () => {
        const view = await this.deps.create(draft)
        const next =
          view.nextRunAt === null ? '' : ` Its first run is at ${localTime(view.nextRunAt)}.`
        return {
          routineId: view.id,
          text: `The user pressed Create. Routine ${view.id} "${view.name}" is created and on: ${scheduleText(view.trigger.schedule)}.${next}`,
          data: {
            routine: view.id,
            name: view.name,
            nextRun: view.nextRunAt === null ? null : localTime(view.nextRunAt),
          },
        }
      },
    }
  }

  private async planUpdate(input: unknown): Promise<Plan | { result: CallToolResult }> {
    const o = fields(input, ['routine', ...Object.keys(SETTINGS), 'enabled'])
    const view = await this.routineView(o)
    const now = this.now()
    const changes: RoutineChanges = {}
    if (o.name !== undefined) {
      const name = optionalString(o, 'name', ROUTINE_NAME_CHARS)!
      if (name.trim() !== view.name) changes.name = name
    }
    if (o.prompt !== undefined) {
      const prompt = promptOf(o.prompt)
      if (prompt !== view.prompt) changes.prompt = prompt
    }
    if (o.schedule !== undefined) {
      const schedule = scheduleOf(o.schedule, now)
      // An every schedule keeps its start when only its length is named again.
      const same =
        schedule.kind === 'every' && view.trigger.schedule.kind === 'every'
          ? schedule.minutes === view.trigger.schedule.minutes
          : sameSchedule(schedule, view.trigger.schedule)
      if (!same) changes.trigger = { kind: 'schedule', schedule }
    }
    let agentId = view.agentId
    if (o.agent !== undefined) {
      agentId = this.routineAgent(optionalString(o, 'agent', AGENT_CHARS)!)
      if (agentId !== view.agentId) changes.agentId = agentId
    }
    const pick: StartPick = {
      ...(o.model !== undefined ? { model: optionalString(o, 'model', OPTION_CHARS)! } : {}),
      ...(o.effort !== undefined ? { effort: optionalString(o, 'effort', OPTION_CHARS)! } : {}),
    }
    if (changes.agentId !== undefined || pick.model !== undefined || pick.effort !== undefined) {
      const carried =
        changes.agentId !== undefined
          ? this.remembered(agentId)
          : Object.fromEntries(view.options.map((option) => [option.id, option.value]))
      const options = await this.routineOptions(agentId, carried, pick)
      if (!sameOptions(options, view.options)) changes.options = options
    }
    if ('project' in o) {
      const projectPath = await this.projectOf(o.project)
      if (projectPath !== view.projectPath) changes.projectPath = projectPath
    }
    if (o.scope !== undefined || o.web !== undefined) {
      const scope: PermissionScope = {
        level: o.scope === undefined ? view.scope.level : levelOf(o.scope),
        web: o.web === undefined ? view.scope.web : webOf(o.web),
      }
      if (scope.level !== view.scope.level || scope.web !== view.scope.web) changes.scope = scope
    }
    if (o.timeLimitMinutes !== undefined) {
      const limit = timeLimitOf(o.timeLimitMinutes)
      if (limit !== view.timeLimitMinutes) changes.timeLimitMinutes = limit
    }
    if (o.enabled !== undefined) {
      if (typeof o.enabled !== 'boolean') throw new Refusal('enabled must be true or false.')
      if (o.enabled !== view.enabled) changes.enabled = o.enabled
    }
    const schedule = changes.trigger?.schedule ?? view.trigger.schedule
    const enabled = changes.enabled ?? view.enabled
    // A one-time Routine whose time passed runs again only at a new time.
    if (enabled && (changes.enabled === true || changes.trigger) && schedule.kind === 'once') {
      const problem = validateSchedule(schedule, now)
      if (problem) {
        throw new Refusal(
          `Nothing was done: the schedule cannot run, since ${problemText(problem)}. Give a new schedule with it.`,
        )
      }
    }
    if (Object.keys(changes).length === 0) {
      return {
        result: reply(
          `Nothing to change: Routine ${view.id} "${view.name}" already has those settings.`,
          {
            changed: false,
          },
        ),
      }
    }
    const before = this.cardOf(view)
    const after = this.cardOf({
      ...view,
      ...changes,
      name:
        changes.name !== undefined
          ? routineName(changes.name, changes.prompt ?? view.prompt)
          : view.name,
      trigger: changes.trigger ?? view.trigger,
      enabled,
    })
    return {
      ask: { action: 'update', routineId: view.id, routine: after, before, sessions: null },
      apply: async () => {
        const next = await this.deps.update(view.id, changes)
        const changed = Object.keys(changes).map((key) => (key === 'trigger' ? 'schedule' : key))
        const when =
          next.nextRunAt === null
            ? next.enabled
              ? ''
              : ' It is off.'
            : ` Its next run is at ${localTime(next.nextRunAt)}.`
        return {
          routineId: next.id,
          text: `The user pressed Change. Routine ${next.id} "${next.name}" is changed: ${changed.join(', ')}.${when}`,
          data: { routine: next.id, changed },
        }
      },
    }
  }

  private async planDelete(input: unknown): Promise<Plan> {
    const o = fields(input, ['routine'])
    const view = await this.routineView(o)
    return {
      ask: {
        action: 'delete',
        routineId: view.id,
        routine: this.cardOf(view),
        before: null,
        sessions: view.sessions,
      },
      apply: async () => {
        await this.deps.delete(view.id)
        return {
          routineId: view.id,
          text:
            `The user pressed Delete. Routine ${view.id} "${view.name}" is deleted, with ` +
            `${view.sessions} run session${view.sessions === 1 ? '' : 's'}.`,
          data: { routine: view.id, deleted: true },
        }
      },
    }
  }

  private async planRun(input: unknown): Promise<Plan> {
    const o = fields(input, ['routine'])
    const view = await this.routineView(o)
    if (view.activeRun) {
      throw new Refusal(
        `Nothing was done: Routine ${view.id} "${view.name}" already has a run going ` +
          `(${view.activeRun.status}). Wait for it to end, then ask again.`,
      )
    }
    return {
      ask: {
        action: 'run',
        routineId: view.id,
        routine: this.cardOf(view),
        before: null,
        sessions: null,
      },
      apply: async () => {
        const run = await this.deps.runNow(view.id)
        const queued =
          run.status === 'queued'
            ? ` It waits for a free slot, since at most ${WORKING_RUNS} runs work at once.`
            : ''
        return {
          routineId: view.id,
          text:
            `The user pressed Run. Run ${run.id} of Routine ${view.id} "${view.name}" started: ` +
            `it works in a session of its own, and list_routines shows how it went.${queued}`,
          data: { routine: view.id, run: run.id, status: run.status },
        }
      },
    }
  }

  /** Opens the card and waits for its answer up to the call's deadline. */
  private async open(sessionId: string, key: string, plan: Plan): Promise<CallToolResult> {
    const card = this.deps.ask(sessionId, plan.ask)
    if (!card) throw new Refusal('This session is not open, so it shows no card. Nothing was done.')
    const job: CardJob = {
      key,
      action: plan.ask.action,
      name: plan.ask.routine.name,
      confirmed: false,
      result: null!,
    }
    job.result = card.answer.then((answer) => {
      job.confirmed = answer.decision === 'confirm'
      return this.answered(sessionId, card.entryId, plan, answer)
    })
    job.result.catch(() => {})
    this.jobs.set(sessionId, [...(this.jobs.get(sessionId) ?? []), job])
    return this.follow(sessionId, job, Date.now() + CONTROL_WAIT_MS)
  }

  /** Does what the user approved, or says why nothing happened. */
  private async answered(
    sessionId: string,
    entryId: string,
    plan: Plan,
    answer: RoutineAnswer,
  ): Promise<CallToolResult> {
    const words = ACTION_WORDS[plan.ask.action]
    if (answer.decision !== 'confirm') {
      const text =
        answer.decision === 'decline'
          ? `The user chose Don't. Nothing was ${words.done}; do not ask to ${words.verb} it again unless they ask.`
          : answer.decision === 'expired'
            ? `The user did not answer within 10 minutes, so nothing was ${words.done}.`
            : `The turn ended before the user answered, so nothing was ${words.done}.`
      return reply(text, { done: false })
    }
    try {
      const done = await plan.apply()
      this.deps.settle(sessionId, entryId, { kind: 'done', routineId: done.routineId })
      return reply(done.text, { done: true, ...done.data })
    } catch (error) {
      const message = (error as Error).message
      this.deps.settle(sessionId, entryId, { kind: 'failed', message })
      throw new Refusal(`The user pressed ${words.button}, but Kettu could not do it: ${message}`)
    }
  }

  /** The card's outcome once it has one, or by the deadline that the user has not answered yet. */
  private async follow(sessionId: string, job: CardJob, deadline: number): Promise<CallToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    })
    try {
      const result = await Promise.race([job.result, late])
      if (result === null) return stillWaiting(job)
      this.done(sessionId, job)
      return result
    } catch (error) {
      this.done(sessionId, job)
      if (error instanceof Refusal) return failed(error.message)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private done(sessionId: string, job: CardJob): void {
    const left = (this.jobs.get(sessionId) ?? []).filter((other) => other !== job)
    if (left.length > 0) this.jobs.set(sessionId, left)
    else this.jobs.delete(sessionId)
  }
}

function runData(run: RoutineRun): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt === null ? null : localTime(run.startedAt),
    endedAt: run.endedAt === null ? null : localTime(run.endedAt),
    error: run.error?.message ?? null,
  }
}

function stillWaiting(job: CardJob): CallToolResult {
  const words = ACTION_WORDS[job.action]
  const tool = words.tool
  const text = job.confirmed
    ? `The user pressed ${words.button} and Kettu is doing it. Call ${tool} again with the same arguments for the outcome.`
    : `The user has not answered the card to ${words.verb} the Routine "${job.name}" yet, and nothing was done. Call ${tool} again with the same arguments to keep waiting on the same card; it shows no second one.`
  return reply(text, { waiting: true, confirmed: job.confirmed })
}
