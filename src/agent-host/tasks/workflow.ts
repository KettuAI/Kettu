// Reading a workflow file: YAML parsed as plain data, then checked strictly into a Workflow. A
// workflow may come from anyone, so every reference, bound and the handover floor is enforced
// here, before a task can lock it.

import { createHash } from 'node:crypto'
import { isAlias, parseDocument, visit } from 'yaml'
import type { PermissionScope } from '@shared/routines'
import {
  TASK_TIERS,
  WORKFLOW_FORMAT,
  type AgentStage,
  type ContractField,
  type Evidence,
  type HandoverStage,
  type HumanStage,
  type StageCondition,
  type TaskSize,
  type TaskTier,
  type Workflow,
  type WorkflowSource,
  type WorkflowStage,
  type WorkflowSummary,
} from '@shared/tasks'

export const WORKFLOW_FILE_BYTES = 256 * 1024
export const MAX_STAGES = 30
export const MAX_CONTRACT_FIELDS = 20
export const PROMPT_CHARS = 20_000
export const NAME_CHARS = 80
export const DESCRIPTION_CHARS = 2_000
const ID_CHARS = 40
const VERSION_CHARS = 40
const FIELD_DESCRIPTION_CHARS = 1_000

export const DEFAULT_LIMITS: Workflow['limits'] = { rounds: 3, stageMinutes: 60, budgetUsd: null }
const ROUNDS = { min: 1, max: 10 }
const STAGE_MINUTES = { min: 5, max: 480 }

const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const FIELD_NAME = /^[a-z][a-z0-9_]*$/
const SIZES: readonly TaskSize[] = ['S', 'M', 'L']
const EVIDENCE: readonly Evidence[] = [
  'ran-command',
  'reported-commands-ran',
  'changed-files',
  'no-file-changes',
]
const FIELD_TYPES: readonly ContractField['type'][] = ['text', 'list', 'size', 'risk']
const SCOPE_LEVELS: readonly PermissionScope['level'][] = ['read', 'edit', 'commands']

class Problem extends Error {}

type Data = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new Problem(path === '' ? message : `${path}: ${message}`)
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return path === '' ? key : `${path}.${key}`
}

function object(value: unknown, path: string): Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be a mapping')
  }
  return value as Data
}

// Unknown keys are refused so a misspelt check is never silently dropped.
function keys(data: Data, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) fail(join(path, key), 'unknown key')
  }
}

function own(data: Data, key: string): unknown {
  return Object.hasOwn(data, key) ? data[key] : undefined
}

function text(data: Data, key: string, path: string, max: number, optional = false): string {
  const value = own(data, key)
  if (value === undefined && optional) return ''
  if (typeof value !== 'string') fail(join(path, key), 'must be text')
  const trimmed = value.trim()
  if (!optional && trimmed === '') fail(join(path, key), 'must not be empty')
  if (value.length > max) fail(join(path, key), `longer than ${max} characters`)
  return trimmed
}

function id(data: Data, key: string, path: string): string {
  const value = own(data, key)
  if (typeof value !== 'string' || value.length > ID_CHARS || !ID.test(value)) {
    fail(join(path, key), `must be kebab-case, up to ${ID_CHARS} characters`)
  }
  return value
}

function bool(data: Data, key: string, path: string, fallback?: boolean): boolean {
  const value = own(data, key)
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') fail(join(path, key), 'must be true or false')
  return value
}

function integer(value: unknown, path: string, bounds: { min: number; max: number }): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be a whole number')
  if (value < bounds.min || value > bounds.max) {
    fail(path, `must be from ${bounds.min} to ${bounds.max}`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    fail(path, `must be one of ${options.join(', ')}`)
  }
  return value as T
}

function list(data: Data, key: string, path: string): unknown[] {
  const value = own(data, key)
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(join(path, key), 'must be a list')
  return value
}

function readLimits(value: unknown): Workflow['limits'] {
  if (value === undefined) return { ...DEFAULT_LIMITS }
  const data = object(value, 'limits')
  keys(data, 'limits', ['rounds', 'stageMinutes', 'budgetUsd'])
  const rounds = own(data, 'rounds')
  const minutes = own(data, 'stageMinutes')
  const budget = own(data, 'budgetUsd')
  if (budget !== undefined && budget !== null) {
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
      fail('limits.budgetUsd', 'must be a number above 0, or null')
    }
  }
  return {
    rounds: rounds === undefined ? DEFAULT_LIMITS.rounds : integer(rounds, 'limits.rounds', ROUNDS),
    stageMinutes:
      minutes === undefined
        ? DEFAULT_LIMITS.stageMinutes
        : integer(minutes, 'limits.stageMinutes', STAGE_MINUTES),
    budgetUsd: (budget as number | null | undefined) ?? null,
  }
}

function readCondition(value: unknown, path: string): StageCondition | undefined {
  if (value === undefined) return undefined
  const data = object(value, path)
  keys(data, path, ['size', 'risk'])
  const condition: StageCondition = {}
  if (own(data, 'size') !== undefined) {
    const sizes = list(data, 'size', path).map((size, index) =>
      oneOf(size, join(join(path, 'size'), index), SIZES),
    )
    if (sizes.length === 0) fail(join(path, 'size'), 'must name at least one size')
    condition.size = [...new Set(sizes)]
  }
  if (own(data, 'risk') !== undefined) condition.risk = bool(data, 'risk', path)
  if (condition.size === undefined && condition.risk === undefined) {
    fail(path, 'must set size or risk')
  }
  return condition
}

function readTier(value: unknown, path: string): AgentStage['tier'] {
  if (typeof value === 'string') return oneOf(value, path, TASK_TIERS)
  const data = object(value, path)
  keys(data, path, ['S', 'M', 'L', 'default'])
  const tier: { S?: TaskTier; M?: TaskTier; L?: TaskTier; default: TaskTier } = {
    default: oneOf(own(data, 'default'), join(path, 'default'), TASK_TIERS),
  }
  for (const size of SIZES) {
    const sized = own(data, size)
    if (sized !== undefined) tier[size] = oneOf(sized, join(path, size), TASK_TIERS)
  }
  return tier
}

function readScope(value: unknown, path: string): PermissionScope {
  const data = object(value, path)
  keys(data, path, ['level', 'web'])
  return {
    level: oneOf(own(data, 'level'), join(path, 'level'), SCOPE_LEVELS),
    web: bool(data, 'web', path, false),
  }
}

function readContract(data: Data, path: string): ContractField[] {
  const raw = list(data, 'contract', path)
  const at = join(path, 'contract')
  if (raw.length === 0) fail(at, 'must list at least one field')
  if (raw.length > MAX_CONTRACT_FIELDS) fail(at, `more than ${MAX_CONTRACT_FIELDS} fields`)
  const seen = new Set<string>()
  const fields = raw.map((item, index): ContractField => {
    const fieldPath = join(at, index)
    const field = object(item, fieldPath)
    keys(field, fieldPath, ['name', 'type', 'required', 'description'])
    const name = own(field, 'name')
    if (typeof name !== 'string' || name.length > ID_CHARS || !FIELD_NAME.test(name)) {
      fail(join(fieldPath, 'name'), 'must be lowercase letters, digits and underscores')
    }
    if (seen.has(name)) fail(join(fieldPath, 'name'), `another field is named "${name}"`)
    seen.add(name)
    return {
      name,
      type: oneOf(own(field, 'type'), join(fieldPath, 'type'), FIELD_TYPES),
      required: bool(field, 'required', fieldPath, true),
      description: text(field, 'description', fieldPath, FIELD_DESCRIPTION_CHARS),
    }
  })
  for (const type of ['size', 'risk'] as const) {
    if (fields.filter((field) => field.type === type).length > 1) {
      fail(at, `at most one field of type ${type}`)
    }
  }
  return fields
}

function readEvidence(data: Data, path: string): Evidence[] {
  const at = join(path, 'evidence')
  const evidence = list(data, 'evidence', path).map((item, index) =>
    oneOf(item, join(at, index), EVIDENCE),
  )
  if (new Set(evidence).size !== evidence.length) fail(at, 'names the same check twice')
  if (evidence.includes('changed-files') && evidence.includes('no-file-changes')) {
    fail(at, 'cannot ask for changed files and no file changes at once')
  }
  return evidence
}

function readStage(value: unknown, index: number): WorkflowStage {
  const path = join('stages', index)
  const data = object(value, path)
  const next = own(data, 'next')
  if (!Object.hasOwn(data, 'next')) fail(join(path, 'next'), 'required; null ends the task')
  if (next !== null && typeof next !== 'string')
    fail(join(path, 'next'), 'must be a stage id or null')
  const base = {
    id: id(data, 'id', path),
    name: text(data, 'name', path, NAME_CHARS),
    next: next as string | null,
    when: readCondition(own(data, 'when'), join(path, 'when')),
  }
  if (base.when === undefined) delete base.when
  const kind = oneOf(own(data, 'kind'), join(path, 'kind'), ['agent', 'human', 'handover'] as const)
  const common = ['id', 'name', 'kind', 'next', 'when']

  if (kind === 'handover') {
    keys(data, path, [...common, 'action'])
    const action = oneOf(own(data, 'action'), join(path, 'action'), ['pull-request'] as const)
    return { ...base, kind, action } satisfies HandoverStage
  }

  if (kind === 'human') {
    keys(data, path, [...common, 'prompt', 'sendBack'])
    const sendBack = list(data, 'sendBack', path).map((item, i) => {
      if (typeof item !== 'string') fail(join(join(path, 'sendBack'), i), 'must be a stage id')
      return item
    })
    return {
      ...base,
      kind,
      prompt: text(data, 'prompt', path, PROMPT_CHARS),
      sendBack: [...new Set(sendBack)],
    } satisfies HumanStage
  }

  keys(data, path, [
    ...common,
    'prompt',
    'tier',
    'requires',
    'scope',
    'session',
    'contract',
    'evidence',
    'gate',
    'rework',
  ])
  const stage: AgentStage = {
    ...base,
    kind,
    prompt: text(data, 'prompt', path, PROMPT_CHARS),
    tier: readTier(own(data, 'tier'), join(path, 'tier')),
    scope: readScope(own(data, 'scope'), join(path, 'scope')),
    session: oneOf(own(data, 'session') ?? 'new', join(path, 'session'), [
      'resume',
      'new',
    ] as const),
    contract: readContract(data, path),
    evidence: readEvidence(data, path),
    gate: oneOf(own(data, 'gate') ?? 'contract', join(path, 'gate'), [
      'contract',
      'agent',
    ] as const),
  }
  const requires = own(data, 'requires')
  if (requires !== undefined) {
    const at = join(path, 'requires')
    const required = object(requires, at)
    keys(required, at, ['otherHarnessThan'])
    const other = own(required, 'otherHarnessThan')
    if (other !== undefined) {
      if (typeof other !== 'string') fail(join(at, 'otherHarnessThan'), 'must be a stage id')
      stage.requires = { otherHarnessThan: other }
    }
  }
  const rework = own(data, 'rework')
  if (rework !== undefined) {
    const at = join(path, 'rework')
    const edge = object(rework, at)
    keys(edge, at, ['to', 'rounds'])
    const to = own(edge, 'to')
    if (typeof to !== 'string') fail(join(at, 'to'), 'must be a stage id')
    const rounds = own(edge, 'rounds')
    // Zero until the limits are read; filled in below.
    stage.rework = {
      to,
      rounds: rounds === undefined ? 0 : integer(rounds, join(at, 'rounds'), ROUNDS),
    }
  }
  checkAgentStage(stage, path)
  return stage
}

function checkAgentStage(stage: AgentStage, path: string): void {
  const level = stage.scope.level
  const evidence = join(path, 'evidence')
  if (stage.evidence.includes('changed-files') && level === 'read') {
    fail(evidence, 'changed-files needs scope level edit or commands')
  }
  for (const check of ['ran-command', 'reported-commands-ran'] as const) {
    if (stage.evidence.includes(check) && level !== 'commands') {
      fail(evidence, `${check} needs scope level commands`)
    }
  }
  if (stage.evidence.includes('reported-commands-ran')) {
    const commands = stage.contract.find((field) => field.name === 'commands')
    if (commands?.type !== 'list' || !commands.required) {
      fail(evidence, 'reported-commands-ran needs a required list field named "commands"')
    }
  }
}

function checkGraph(workflow: Workflow): void {
  const byId = new Map<string, { stage: WorkflowStage; index: number }>()
  workflow.stages.forEach((stage, index) => {
    if (byId.has(stage.id))
      fail(join(join('stages', index), 'id'), `another stage is "${stage.id}"`)
    byId.set(stage.id, { stage, index })
  })
  const agentStage = (target: string, at: string): void => {
    const found = byId.get(target)
    if (!found) fail(at, `no stage "${target}"`)
    if (found.stage.kind !== 'agent') fail(at, `"${target}" is not an agent stage`)
  }

  if (!byId.has(workflow.start)) fail('start', `no stage "${workflow.start}"`)
  workflow.stages.forEach((stage, index) => {
    const path = join('stages', index)
    if (stage.next !== null) {
      if (!byId.has(stage.next)) fail(join(path, 'next'), `no stage "${stage.next}"`)
      if (stage.next === stage.id) fail(join(path, 'next'), 'a stage cannot follow itself')
    }
    if (stage.kind === 'agent') {
      if (stage.rework) {
        agentStage(stage.rework.to, join(join(path, 'rework'), 'to'))
        if (stage.rework.rounds === 0) stage.rework.rounds = workflow.limits.rounds
      }
      const other = stage.requires?.otherHarnessThan
      if (other !== undefined) {
        const at = join(join(path, 'requires'), 'otherHarnessThan')
        agentStage(other, at)
        if (other === stage.id) fail(at, 'must name another stage')
      }
    }
    if (stage.kind === 'human') {
      stage.sendBack.forEach((target, i) => agentStage(target, join(join(path, 'sendBack'), i)))
    }
  })

  // The floor: nothing leaves the worktree before a person approved it. A handover is entered
  // only by passing an unconditional human stage; rework and send-backs never target it.
  const handovers = workflow.stages.filter((stage) => stage.kind === 'handover')
  for (const handover of handovers) {
    if (workflow.start === handover.id) fail('start', 'a handover cannot be the first stage')
    for (const [, { stage, index: from }] of byId) {
      if (stage.next !== handover.id) continue
      if (stage.kind !== 'human') {
        fail(
          join(join('stages', from), 'next'),
          `handover "${handover.id}" must follow a human stage`,
        )
      }
      if (stage.when !== undefined) {
        fail(
          join(join('stages', from), 'when'),
          `the human stage before handover "${handover.id}" cannot be skipped`,
        )
      }
    }
  }

  // Every stage is reachable from the start, through passes, rework and send-backs.
  const reached = new Set<string>([workflow.start])
  const queue = [workflow.start]
  while (queue.length > 0) {
    const stage = byId.get(queue.shift()!)!.stage
    const targets = [stage.next]
    if (stage.kind === 'agent') targets.push(stage.rework?.to ?? null)
    if (stage.kind === 'human') targets.push(...stage.sendBack)
    for (const target of targets) {
      if (target !== null && !reached.has(target)) {
        reached.add(target)
        queue.push(target)
      }
    }
  }
  for (const [stageId, { index }] of byId) {
    if (!reached.has(stageId))
      fail(join('stages', index), `"${stageId}" is never reached from the start`)
  }

  // Passing every stage in turn must end the task; a loop of passes would never end.
  for (const [stageId, { index }] of byId) {
    const seen = new Set<string>()
    let current: string | null = stageId
    while (current !== null) {
      if (seen.has(current)) fail(join('stages', index), `passing "${stageId}" never ends the task`)
      seen.add(current)
      current = byId.get(current)!.stage.next
    }
  }
}

function readWorkflowData(value: unknown): Workflow {
  const data = object(value, '')
  keys(data, '', [
    'format',
    'id',
    'name',
    'description',
    'kind',
    'version',
    'worktree',
    'start',
    'stages',
    'limits',
  ])
  if (own(data, 'format') !== WORKFLOW_FORMAT) fail('format', `must be ${WORKFLOW_FORMAT}`)
  const version = own(data, 'version')
  if (typeof version !== 'string' && typeof version !== 'number') fail('version', 'must be text')
  const versionText = String(version).trim()
  if (versionText === '' || versionText.length > VERSION_CHARS) {
    fail('version', `must be 1 to ${VERSION_CHARS} characters`)
  }
  const start = own(data, 'start')
  if (typeof start !== 'string') fail('start', 'must be a stage id')
  const stages = own(data, 'stages')
  if (!Array.isArray(stages) || stages.length === 0) fail('stages', 'must list at least one stage')
  if (stages.length > MAX_STAGES) fail('stages', `more than ${MAX_STAGES} stages`)
  const workflow: Workflow = {
    format: WORKFLOW_FORMAT,
    id: id(data, 'id', ''),
    name: text(data, 'name', '', NAME_CHARS),
    description: text(data, 'description', '', DESCRIPTION_CHARS, true),
    kind: id(data, 'kind', ''),
    version: versionText,
    worktree: bool(data, 'worktree', ''),
    start,
    stages: stages.map(readStage),
    limits: readLimits(own(data, 'limits')),
  }
  checkGraph(workflow)
  return workflow
}

/** Parses and validates a workflow file. A problem names the field it found wrong. */
export function parseWorkflow(source: string): { workflow: Workflow } | { problem: string } {
  if (Buffer.byteLength(source, 'utf8') > WORKFLOW_FILE_BYTES) {
    return { problem: `the file is larger than ${WORKFLOW_FILE_BYTES / 1024} KB` }
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
  if (issue) return { problem: `not valid YAML: ${issue.message.split('\n')[0]}` }
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
  if (alias) return { problem: 'YAML aliases are not allowed' }
  try {
    return { workflow: readWorkflowData(doc.toJS({ maxAliasCount: 0 })) }
  } catch (error) {
    if (error instanceof Problem) return { problem: error.message }
    throw error
  }
}

/** SHA-256 of the file as read, in hex. */
export function workflowHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

export function summarize(
  workflow: Workflow,
  source: WorkflowSource,
  problem: string | null = null,
): WorkflowSummary {
  return {
    source,
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    kind: workflow.kind,
    version: workflow.version,
    stages: workflow.stages.map(({ id, name, kind }) => ({ id, name, kind })),
    problem,
  }
}

/** A file that did not read, listed under its file name so the person sees why. */
export function unreadable(source: WorkflowSource, name: string, problem: string): WorkflowSummary {
  return {
    source,
    id: name,
    name,
    description: '',
    kind: '',
    version: '',
    stages: [],
    problem,
  }
}
