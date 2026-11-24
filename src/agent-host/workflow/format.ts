// Reading a workflow file: YAML parsed as plain data, then checked into a Workflow. A workflow may come from
// anyone, so every reference and bound is checked here, and each problem names where it is.

import { createHash } from 'node:crypto'
import { isAlias, parseDocument, visit } from 'yaml'
import {
  DEFAULT_SEND_BACK_LIMIT,
  MAX_OUTCOMES,
  MAX_SEND_BACK_LIMIT,
  MAX_WORKFLOW_STEPS,
  MAX_TOOLS,
  WORKFLOW_DESCRIPTION_CHARS,
  WORKFLOW_FILE_BYTES,
  WORKFLOW_FORMAT,
  WORKFLOW_NAME_CHARS,
  STEP_HINT_CHARS,
  STEP_PROMPT_CHARS,
  marketToolRef,
  stepIndex,
  type HandIn,
  type Workflow,
  type WorkflowLocale,
  type WorkflowOutcome,
  type WorkflowProblem,
  type WorkflowStep,
  type StepBy,
  type TaskEnd,
} from '@shared/workflow'
import { translate, translateEnglish, type HostKey, type HostMessage } from '../i18n'

// The words to translate for a problem, kept apart so its `message` stays English and plain data.
const words = new WeakMap<WorkflowProblem, HostMessage>()

export function fileProblem(
  at: string,
  key: HostKey,
  params?: HostMessage['params'],
): WorkflowProblem {
  const text: HostMessage = params ? { key, params } : { key }
  const problem = { at, message: translateEnglish(text) }
  words.set(problem, text)
  return problem
}

/** A problem's message in the user's language. */
export function problemText(problem: WorkflowProblem): string {
  const text = words.get(problem)
  return text ? translate(text) : problem.message
}

const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const ID_CHARS = 40
const OUTCOME_CHARS = 60
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
const MAX_LOCALES = 20
const HAND_INS: readonly HandIn[] = ['document', 'outcome', 'note']
const BYS: readonly StepBy[] = ['agent', 'you']
const ENDS: readonly TaskEnd[] = ['done', 'dropped']

type Data = Record<string, unknown>

/** Gathers problems while the reader goes on, so one file lists all of them at once. */
class Problems {
  readonly list: WorkflowProblem[] = []
  add(at: string, key: HostKey, params?: HostMessage['params']): void {
    if (this.list.length < 50) this.list.push(fileProblem(at, key, params))
  }
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return path === '' ? key : `${path}.${key}`
}

function isData(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(data: Data, key: string): unknown {
  return Object.hasOwn(data, key) ? data[key] : undefined
}

// Unknown keys are refused, so a misspelt field is never silently dropped.
function knownKeys(data: Data, path: string, allowed: readonly string[], p: Problems): void {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) p.add(join(path, key), 'workflowFile.unknownField')
  }
}

function text(
  data: Data,
  key: string,
  path: string,
  max: number,
  p: Problems,
  optional = false,
): string | null {
  const value = own(data, key)
  if (value === undefined || value === null) {
    if (!optional) p.add(join(path, key), 'workflowFile.required')
    return null
  }
  if (typeof value !== 'string') {
    p.add(join(path, key), 'workflowFile.mustBeText')
    return null
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    if (!optional) p.add(join(path, key), 'workflowFile.notEmpty')
    return null
  }
  if (trimmed.length > max) {
    p.add(join(path, key), 'workflowFile.tooLong', { max })
    return null
  }
  return trimmed
}

function whenText(data: Data, path: string, p: Problems): string | null {
  const when = text(data, 'when', path, WORKFLOW_DESCRIPTION_CHARS, p, true)
  if (when !== null && /[\r\n\u2028\u2029]/u.test(when)) {
    p.add(join(path, 'when'), 'workflowFile.oneLine')
    return null
  }
  return when
}

/** A single string or a list of them, as `to` and `review_of` take either. */
function names(value: unknown, path: string, p: Problems): string[] {
  if (value === undefined || value === null) return []
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list)) {
    p.add(path, 'workflowFile.stepIdOrList')
    return []
  }
  const out: string[] = []
  list.forEach((item, index) => {
    if (typeof item !== 'string' || !ID.test(item)) {
      p.add(join(path, index), 'workflowFile.stepId')
      return
    }
    if (out.includes(item)) p.add(join(path, index), 'workflowFile.namesTwice', { id: item })
    else out.push(item)
  })
  return out
}

function limit(value: unknown, path: string, p: Problems): number | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SEND_BACK_LIMIT
  ) {
    p.add(path, 'workflowFile.wholeNumber', { max: MAX_SEND_BACK_LIMIT })
    return null
  }
  return value
}

function readOutcome(value: unknown, path: string, p: Problems): WorkflowOutcome | null {
  if (!isData(value)) {
    p.add(path, 'workflowFile.outcomeMapping')
    return null
  }
  knownKeys(value, path, ['name', 'to', 'end', 'limit'], p)
  const name = text(value, 'name', path, OUTCOME_CHARS, p)
  const to = names(own(value, 'to'), join(path, 'to'), p)
  const endValue = own(value, 'end')
  let end: TaskEnd | null = null
  if (endValue !== undefined && endValue !== null) {
    if (ENDS.includes(endValue as TaskEnd)) end = endValue as TaskEnd
    else p.add(join(path, 'end'), 'workflowFile.doneOrDropped')
  }
  if (to.length === 0 && end === null && (endValue === undefined || endValue === null)) {
    p.add(path, 'workflowFile.needsToOrEnd')
  }
  if (to.length > 0 && end !== null) p.add(path, 'workflowFile.bothToEnd')
  const ownLimit = limit(own(value, 'limit'), join(path, 'limit'), p)
  if (name === null) return null
  return { name, to, end, limit: ownLimit }
}

function readTools(value: unknown, path: string, p: Problems): WorkflowStep['tools'] {
  const tools: WorkflowStep['tools'] = { mcp: [], skills: [] }
  if (value === undefined || value === null) return tools
  if (!isData(value)) {
    p.add(path, 'workflowFile.toolsMapping')
    return tools
  }
  knownKeys(value, path, ['mcp', 'skills'], p)
  for (const kind of ['mcp', 'skills'] as const) {
    const raw = own(value, kind)
    if (raw === undefined || raw === null) continue
    const at = join(path, kind)
    if (!Array.isArray(raw)) {
      p.add(at, 'workflowFile.nameList')
      continue
    }
    if (raw.length > MAX_TOOLS) p.add(at, 'workflowFile.tooManyNames', { max: MAX_TOOLS })
    raw.slice(0, MAX_TOOLS).forEach((item, index) => {
      if (typeof item !== 'string' || !TOOL_NAME.test(item)) {
        p.add(join(at, index), 'workflowFile.name')
        return
      }
      if (!tools[kind].includes(item)) tools[kind].push(item)
    })
  }
  return tools
}

/** A step's role: the reference of a role, a name or a plugin's name and the role's, or null. */
function readRole(value: unknown, path: string, p: Problems): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !TOOL_NAME.test(value)) {
    p.add(path, 'workflowFile.name')
    return null
  }
  return value
}

function readStep(value: unknown, index: number, p: Problems): WorkflowStep | null {
  const path = join('steps', index)
  if (!isData(value)) {
    p.add(path, 'workflowFile.mapping')
    return null
  }
  knownKeys(
    value,
    path,
    [
      'id',
      'name',
      'prompt',
      'by',
      'hand_in',
      'outcomes',
      'you_review',
      'hint',
      'review_of',
      'tools',
      'role',
    ],
    p,
  )
  const idValue = own(value, 'id')
  let id: string | null = null
  if (typeof idValue !== 'string' || idValue.length > ID_CHARS || !ID.test(idValue)) {
    p.add(join(path, 'id'), 'workflowFile.idFormat', { max: ID_CHARS })
  } else id = idValue
  const name = text(value, 'name', path, WORKFLOW_NAME_CHARS, p)
  const prompt = text(value, 'prompt', path, STEP_PROMPT_CHARS, p)
  const byValue = own(value, 'by') ?? 'agent'
  let by: StepBy = 'agent'
  if (BYS.includes(byValue as StepBy)) by = byValue as StepBy
  else p.add(join(path, 'by'), 'workflowFile.agentOrYou')
  const handValue = own(value, 'hand_in') ?? (by === 'you' ? 'outcome' : 'note')
  let handIn: HandIn = 'note'
  if (HAND_INS.includes(handValue as HandIn)) handIn = handValue as HandIn
  else p.add(join(path, 'hand_in'), 'workflowFile.handInKind')
  const reviewValue = own(value, 'you_review')
  if (reviewValue !== undefined && typeof reviewValue !== 'boolean') {
    p.add(join(path, 'you_review'), 'workflowFile.trueOrFalse')
  }
  const youReview = reviewValue === true
  const hint = text(value, 'hint', path, STEP_HINT_CHARS, p, true)
  const reviewOf = names(own(value, 'review_of'), join(path, 'review_of'), p)
  const tools = readTools(own(value, 'tools'), join(path, 'tools'), p)
  const role = readRole(own(value, 'role'), join(path, 'role'), p)

  const outcomesValue = own(value, 'outcomes')
  const outcomes: WorkflowOutcome[] = []
  if (!Array.isArray(outcomesValue) || outcomesValue.length === 0) {
    p.add(join(path, 'outcomes'), 'workflowFile.oneOutcome')
  } else {
    if (outcomesValue.length > MAX_OUTCOMES) {
      p.add(join(path, 'outcomes'), 'workflowFile.tooManyOutcomes', { max: MAX_OUTCOMES })
    }
    outcomesValue.slice(0, MAX_OUTCOMES).forEach((item, i) => {
      const outcome = readOutcome(item, join(join(path, 'outcomes'), i), p)
      if (!outcome) return
      if (outcomes.some((other) => other.name.toLowerCase() === outcome.name.toLowerCase())) {
        p.add(join(join(path, 'outcomes'), i), 'workflowFile.outcomeTwice', { name: outcome.name })
        return
      }
      outcomes.push(outcome)
    })
  }

  if (by === 'you') {
    if (handIn !== 'outcome') p.add(join(path, 'hand_in'), 'workflowFile.personHandsOutcome')
    if (youReview) p.add(join(path, 'you_review'), 'workflowFile.personNotReviewed')
    if (hint !== null) p.add(join(path, 'hint'), 'workflowFile.personNoAgent')
    if (reviewOf.length > 0) p.add(join(path, 'review_of'), 'workflowFile.personNoReview')
    if (tools.mcp.length + tools.skills.length > 0) {
      p.add(join(path, 'tools'), 'workflowFile.personNoTools')
    }
    if (role !== null) p.add(join(path, 'role'), 'workflowFile.personNoRole')
  }
  if (handIn === 'outcome' && outcomes.length < 2) {
    p.add(join(path, 'outcomes'), 'workflowFile.twoOutcomes')
  }
  if (id === null || name === null || prompt === null) return null
  return {
    id,
    name,
    prompt,
    by,
    handIn,
    outcomes,
    youReview,
    hint,
    reviewOf,
    tools,
    ...(role === null ? {} : { role }),
  }
}

/** A locale's outcome names: step ids to each outcome's name in the file and its translation. */
function readOutcomeNames(
  value: unknown,
  path: string,
  p: Problems,
): Record<string, Record<string, string>> | null {
  if (value === undefined || value === null) return null
  if (!isData(value)) {
    p.add(path, 'workflowFile.outcomesMapping')
    return null
  }
  const byStep: Record<string, Record<string, string>> = {}
  for (const [stepId, raw] of Object.entries(value)) {
    const at = join(path, stepId)
    if (!isData(raw)) {
      p.add(at, 'workflowFile.outcomeNames')
      continue
    }
    const named: Record<string, string> = {}
    for (const key of Object.keys(raw)) {
      const name = text(raw, key, at, OUTCOME_CHARS, p)
      if (name !== null) named[key] = name
    }
    byStep[stepId] = named
  }
  return byStep
}

function readLocales(value: unknown, p: Problems): Record<string, WorkflowLocale> {
  const locales: Record<string, WorkflowLocale> = {}
  if (value === undefined || value === null) return locales
  if (!isData(value)) {
    p.add('locales', 'workflowFile.localesMapping')
    return locales
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_LOCALES)
    p.add('locales', 'workflowFile.tooManyLocales', { max: MAX_LOCALES })
  for (const [code, raw] of entries.slice(0, MAX_LOCALES)) {
    const path = join('locales', code)
    if (!LOCALE.test(code)) {
      p.add(path, 'workflowFile.languageCode')
      continue
    }
    if (!isData(raw)) {
      p.add(path, 'workflowFile.localeMapping')
      continue
    }
    knownKeys(raw, path, ['name', 'description', 'when', 'steps', 'outcomes'], p)
    const locale: WorkflowLocale = {}
    const name = text(raw, 'name', path, WORKFLOW_NAME_CHARS, p, true)
    if (name !== null) locale.name = name
    const description = text(raw, 'description', path, WORKFLOW_DESCRIPTION_CHARS, p, true)
    if (description !== null) locale.description = description
    const when = whenText(raw, path, p)
    if (when !== null) locale.when = when
    const steps = own(raw, 'steps')
    if (steps !== undefined && steps !== null) {
      if (!isData(steps)) p.add(join(path, 'steps'), 'workflowFile.stepNames')
      else {
        const named: Record<string, string> = {}
        for (const key of Object.keys(steps)) {
          const stepName = text(steps, key, join(path, 'steps'), WORKFLOW_NAME_CHARS, p)
          if (stepName !== null) named[key] = stepName
        }
        locale.steps = named
      }
    }
    const outcomes = readOutcomeNames(own(raw, 'outcomes'), join(path, 'outcomes'), p)
    if (outcomes !== null) locale.outcomes = outcomes
    locales[code] = locale
  }
  return locales
}

/** Every step id `from` can reach through any arrow, itself included. */
function reachable(workflow: Workflow, from: string): Set<string> {
  const byId = new Map(workflow.steps.map((step) => [step.id, step]))
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    const step = byId.get(queue.shift()!)
    for (const outcome of step?.outcomes ?? []) {
      for (const to of outcome.to) {
        if (!seen.has(to) && byId.has(to)) {
          seen.add(to)
          queue.push(to)
        }
      }
    }
  }
  return seen
}

function checkGraph(workflow: Workflow, p: Problems): void {
  const ids = new Set<string>()
  workflow.steps.forEach((step, index) => {
    if (ids.has(step.id))
      p.add(join(join('steps', index), 'id'), 'workflowFile.stepTwice', { id: step.id })
    ids.add(step.id)
  })
  workflow.steps.forEach((step, index) => {
    const path = join('steps', index)
    step.outcomes.forEach((outcome, i) => {
      const at = join(join(path, 'outcomes'), i)
      for (const to of outcome.to) {
        if (!ids.has(to)) p.add(join(at, 'to'), 'workflowFile.noStep', { id: to })
      }
      const back = outcome.to.some((to) => ids.has(to) && stepIndex(workflow, to) <= index)
      if (outcome.limit !== null && !back) {
        p.add(join(at, 'limit'), 'workflowFile.limitBack')
      }
      if (back && outcome.to.length > 1) {
        p.add(join(at, 'to'), 'workflowFile.backOne')
      }
    })
    for (const target of step.reviewOf) {
      if (!ids.has(target)) p.add(join(path, 'review_of'), 'workflowFile.noStep', { id: target })
      else if (target === step.id) p.add(join(path, 'review_of'), 'workflowFile.reviewSelf')
      else if (workflow.steps.find((s) => s.id === target)?.by === 'you') {
        p.add(join(path, 'review_of'), 'workflowFile.reviewPerson', { id: target })
      }
    }
  })
  if (p.list.length > 0) return
  const start = workflow.steps[0]!.id
  const fromStart = reachable(workflow, start)
  workflow.steps.forEach((step, index) => {
    if (!fromStart.has(step.id)) {
      p.add(join('steps', index), 'workflowFile.unreachable', { id: step.id })
    }
  })
  // A step from which no arrow ever leads to an end would hold its task forever.
  const ends = new Set(
    workflow.steps.filter((step) => step.outcomes.some((o) => o.end !== null)).map((s) => s.id),
  )
  if (ends.size === 0) {
    p.add('steps', 'workflowFile.noEnd')
    return
  }
  workflow.steps.forEach((step, index) => {
    if (![...reachable(workflow, step.id)].some((id) => ends.has(id))) {
      p.add(join('steps', index), 'workflowFile.noPathToEnd', { id: step.id })
    }
  })
}

function readWorkflow(value: unknown, p: Problems): Workflow | null {
  if (!isData(value)) {
    p.add('', 'workflowFile.fileMapping')
    return null
  }
  knownKeys(
    value,
    '',
    ['format', 'name', 'description', 'when', 'locales', 'send_back_limit', 'steps'],
    p,
  )
  if (own(value, 'format') !== WORKFLOW_FORMAT)
    p.add('format', 'workflowFile.formatValue', { format: WORKFLOW_FORMAT })
  const name = text(value, 'name', '', WORKFLOW_NAME_CHARS, p)
  const description = text(value, 'description', '', WORKFLOW_DESCRIPTION_CHARS, p, true) ?? ''
  const when = whenText(value, '', p)
  const locales = readLocales(own(value, 'locales'), p)
  const sendBackLimit =
    limit(own(value, 'send_back_limit'), 'send_back_limit', p) ?? DEFAULT_SEND_BACK_LIMIT
  const stepsValue = own(value, 'steps')
  if (!Array.isArray(stepsValue) || stepsValue.length === 0) {
    p.add('steps', 'workflowFile.oneStep')
    return null
  }
  if (stepsValue.length > MAX_WORKFLOW_STEPS)
    p.add('steps', 'workflowFile.tooManySteps', { max: MAX_WORKFLOW_STEPS })
  const steps = stepsValue.slice(0, MAX_WORKFLOW_STEPS).map((step, i) => readStep(step, i, p))
  if (name === null || steps.some((step) => step === null)) return null
  const workflow: Workflow = {
    format: WORKFLOW_FORMAT,
    name,
    description,
    ...(when === null ? {} : { when }),
    locales,
    sendBackLimit,
    steps: steps as WorkflowStep[],
  }
  for (const [code, locale] of Object.entries(locales)) {
    for (const stepId of Object.keys(locale.steps ?? {})) {
      if (!workflow.steps.some((step) => step.id === stepId)) {
        p.add(join(join(join('locales', code), 'steps'), stepId), 'workflowFile.noStep', {
          id: stepId,
        })
      }
    }
    for (const [stepId, named] of Object.entries(locale.outcomes ?? {})) {
      const at = join(join(join('locales', code), 'outcomes'), stepId)
      const step = workflow.steps.find((s) => s.id === stepId)
      if (!step) {
        p.add(at, 'workflowFile.noStep', { id: stepId })
        continue
      }
      for (const name of Object.keys(named)) {
        if (!step.outcomes.some((outcome) => outcome.name === name)) {
          p.add(join(at, name), 'workflowFile.noOutcome', { id: stepId, name })
        }
      }
    }
  }
  checkGraph(workflow, p)
  return workflow
}

export type WorkflowRead =
  { workflow: Workflow; problems: [] } | { workflow: null; problems: WorkflowProblem[] }

/** Parses and checks a workflow file; a file with any problem gives no workflow. */
export function parseWorkflow(source: string): WorkflowRead {
  if (Buffer.byteLength(source, 'utf8') > WORKFLOW_FILE_BYTES) {
    return {
      workflow: null,
      problems: [fileProblem('', 'workflowFile.fileTooLarge', { kb: WORKFLOW_FILE_BYTES / 1024 })],
    }
  }
  const doc = parseDocument(source, {
    schema: 'core',
    customTags: [],
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    logLevel: 'silent',
  })
  const issue = doc.errors[0] ?? doc.warnings[0]
  if (issue) {
    return {
      workflow: null,
      problems: [fileProblem('', 'workflowFile.notYaml', { reason: issue.message.split('\n')[0] })],
    }
  }
  let alias = false
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node)) {
        alias = true
        return visit.BREAK
      }
      return undefined
    },
  })
  if (alias) return { workflow: null, problems: [fileProblem('', 'workflowFile.noAliases')] }
  const p = new Problems()
  const workflow = readWorkflow(doc.toJS({ maxAliasCount: 0 }), p)
  if (workflow === null || p.list.length > 0) {
    return {
      workflow: null,
      problems: p.list.length > 0 ? p.list : [fileProblem('', 'workflowFile.notAWorkflow')],
    }
  }
  return { workflow, problems: [] }
}

/**
 * The tools the workflow names that are neither kept on this host, by name or id, nor a
 * Marketplace entry that Start installs, as problems.
 */
export function toolProblems(
  workflow: Workflow,
  known: { mcp: ReadonlySet<string>; skills: ReadonlySet<string> },
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = []
  workflow.steps.forEach((step, index) => {
    for (const kind of ['mcp', 'skills'] as const) {
      step.tools[kind].forEach((name, i) => {
        if (!known[kind].has(name) && !marketToolRef(kind === 'mcp' ? 'mcp' : 'skill', name)) {
          problems.push(
            fileProblem(
              join(join(join('steps', index), 'tools'), kind) + `[${i}]`,
              kind === 'mcp' ? 'workflowFile.noMcp' : 'workflowFile.noSkill',
              { name },
            ),
          )
        }
      })
    }
  })
  return problems
}

/** SHA-256 of the file as read, in hex: what an approval names. */
export function workflowHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}
