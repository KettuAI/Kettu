// Reading an SOP file: YAML parsed as plain data, then checked strictly into an Sop. An SOP may
// come from anyone, an agent included, so every reference and bound is enforced here, before a
// task can lock it.

import { createHash } from 'node:crypto'
import { isAlias, parseDocument, visit } from 'yaml'
import { sopGraph } from '@shared/sop-graph'
import {
  DEFAULT_ROUNDS,
  MAX_NODE_OUTCOMES,
  MAX_SOP_NODES,
  SOP_FILE_CHARS,
  SOP_FORMAT,
  TASK_TIERS,
  type HandIn,
  type Sop,
  type SopNode,
  type SopOutcome,
  type SopOutline,
} from '@shared/tasks'

export const SOP_ID_CHARS = 40
export const SOP_NAME_CHARS = 80
export const SOP_DESCRIPTION_CHARS = 2_000
export const SOP_PROMPT_CHARS = 20_000
const ROUNDS = { min: 1, max: 10 }

const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
// An SOP's id is its file name, and Windows keeps these names for devices whatever the extension.
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const HAND_INS: readonly HandIn[] = ['document', 'verdict', 'note']
const BY = [...TASK_TIERS, 'person'] as const
const ENDS = ['done', 'dropped'] as const

/** Why an SOP file does not read, naming the field it found wrong. */
export class SopProblem extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SopProblem'
  }
}

/** Whether the text may be an SOP's id, and so the name of its library file. */
export function isSopId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= SOP_ID_CHARS &&
    ID.test(value) &&
    !DEVICE_NAME.test(value)
  )
}

type Data = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new SopProblem(path === '' ? message : `${path}: ${message}`)
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return path === '' ? key : `${path}.${key}`
}

function isMapping(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, path: string): Data {
  if (!isMapping(value)) fail(path, 'must be a mapping')
  return value
}

// Unknown keys are refused so a misspelt key is never silently dropped.
function keys(data: Data, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) fail(join(path, key), 'unknown key')
  }
}

function own(data: Data, key: string): unknown {
  return Object.hasOwn(data, key) ? data[key] : undefined
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') fail(path, 'must be text')
  const trimmed = value.trim()
  if (trimmed === '') fail(path, 'must not be empty')
  if (value.length > max) fail(path, `longer than ${max} characters`)
  return trimmed
}

/** Text, or a map of it by language: the host's language, else English, else the first. */
function named(value: unknown, path: string, max: number, language: string): string {
  if (!isMapping(value)) return text(value, path, max)
  const texts = new Map<string, string>()
  for (const [tag, entry] of Object.entries(value)) {
    if (!LANGUAGE.test(tag)) fail(join(path, tag), 'must be a language tag such as en or zh-CN')
    texts.set(tag, text(entry, join(path, tag), max))
  }
  const [first] = texts.values()
  if (first === undefined) fail(path, 'must name at least one language')
  return texts.get(language) ?? texts.get('en') ?? first
}

function id(data: Data, path: string): string {
  const value = own(data, 'id')
  const at = join(path, 'id')
  if (typeof value !== 'string' || value.length > SOP_ID_CHARS || !ID.test(value)) {
    fail(at, `must be lowercase letters, digits and dashes, up to ${SOP_ID_CHARS} characters`)
  }
  if (DEVICE_NAME.test(value)) fail(at, `"${value}" cannot be a file name on every system`)
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

function readTargets(value: unknown, path: string): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'must be a node id or a list of node ids')
  }
  const targets: string[] = []
  value.forEach((item, index) => {
    if (typeof item !== 'string') fail(join(path, index), 'must be a node id')
    if (targets.includes(item)) fail(join(path, index), `"${item}" is listed twice`)
    targets.push(item)
  })
  return targets
}

function readOutcome(value: unknown, path: string, language: string): SopOutcome {
  const data = object(value, path)
  keys(data, path, ['id', 'name', 'to', 'end', 'rounds'])
  const outcome: SopOutcome = {
    id: id(data, path),
    name: named(own(data, 'name'), join(path, 'name'), SOP_NAME_CHARS, language),
    to: [],
  }
  const to = own(data, 'to')
  const end = own(data, 'end')
  const rounds = own(data, 'rounds')
  if ((to === undefined) === (end === undefined)) {
    fail(path, 'must have exactly one of "to" and "end"')
  }
  if (to !== undefined) {
    outcome.to = readTargets(to, join(path, 'to'))
    if (rounds !== undefined) outcome.rounds = integer(rounds, join(path, 'rounds'), ROUNDS)
  } else {
    outcome.end = oneOf(end, join(path, 'end'), ENDS)
    if (rounds !== undefined) fail(join(path, 'rounds'), 'only an outcome with "to" has rounds')
  }
  return outcome
}

function readNode(value: unknown, path: string, language: string): SopNode {
  const data = object(value, path)
  keys(data, path, ['id', 'name', 'by', 'hand-in', 'prompt', 'outcomes'])
  const nodeId = id(data, path)
  const name = named(own(data, 'name'), join(path, 'name'), SOP_NAME_CHARS, language)
  const by = oneOf(own(data, 'by'), join(path, 'by'), BY)
  const handIn = own(data, 'hand-in')
  if (by === 'person' && handIn !== undefined) {
    fail(join(path, 'hand-in'), "must be left out of a person's node, which gives a verdict")
  }
  const prompt = text(own(data, 'prompt'), join(path, 'prompt'), SOP_PROMPT_CHARS)

  const at = join(path, 'outcomes')
  const raw = own(data, 'outcomes')
  if (!Array.isArray(raw) || raw.length === 0) fail(at, 'must list at least one outcome')
  if (raw.length > MAX_NODE_OUTCOMES) fail(at, `more than ${MAX_NODE_OUTCOMES} outcomes`)
  const outcomes: SopOutcome[] = []
  raw.forEach((item, index) => {
    const outcome = readOutcome(item, join(at, index), language)
    if (outcomes.some((other) => other.id === outcome.id)) {
      fail(join(join(at, index), 'id'), `another outcome of this node is "${outcome.id}"`)
    }
    outcomes.push(outcome)
  })

  if (by === 'person') {
    return { id: nodeId, name, prompt, by: { kind: 'person' }, handIn: 'verdict', outcomes }
  }
  const node: SopNode = {
    id: nodeId,
    name,
    prompt,
    by: { kind: 'agent', tier: by },
    handIn: oneOf(handIn, join(path, 'hand-in'), HAND_INS),
    outcomes,
  }
  if (node.handIn === 'verdict' && outcomes.length < 2) {
    fail(at, 'a verdict needs two or more outcomes')
  }
  return node
}

function checkGraph(sop: Sop): void {
  const index = new Map<string, number>()
  sop.nodes.forEach((node, at) => {
    if (index.has(node.id)) fail(join(join('nodes', at), 'id'), `another node is "${node.id}"`)
    index.set(node.id, at)
  })
  sop.nodes.forEach((node, at) => {
    node.outcomes.forEach((outcome, o) => {
      const path = join(join(join(join('nodes', at), 'outcomes'), o), 'to')
      for (const target of outcome.to) {
        if (!index.has(target)) fail(path, `no node "${target}"`)
      }
    })
  })

  const graph = sopGraph(outlineOf(sop))
  const reached = new Set([sop.start, ...(graph.reach[sop.start] ?? [])])
  sop.nodes.forEach((node, at) => {
    if (!reached.has(node.id)) {
      fail(
        join('nodes', at),
        `"${node.id}" is not reached from the first node by arrows forward; write the nodes in the order of the flow`,
      )
    }
  })

  // Every node leads to an end by some arrows, so no line of work is caught in a loop.
  const ending = new Set(
    sop.nodes
      .filter((node) => node.outcomes.some((outcome) => outcome.end !== undefined))
      .map((node) => node.id),
  )
  if (ending.size === 0) fail('nodes', 'no outcome ends the task; give one an "end"')
  for (let grew = true; grew;) {
    grew = false
    for (const edge of graph.edges) {
      if (ending.has(edge.to) && !ending.has(edge.from)) {
        ending.add(edge.from)
        grew = true
      }
    }
  }
  sop.nodes.forEach((node, at) => {
    if (!ending.has(node.id)) {
      fail(join('nodes', at), `"${node.id}" never leads to an outcome that ends the task`)
    }
  })
}

function readSop(value: unknown, language: string): Sop {
  const data = object(value, '')
  keys(data, '', ['format', 'id', 'name', 'description', 'rounds', 'nodes'])
  if (own(data, 'format') !== SOP_FORMAT) fail('format', `must be ${SOP_FORMAT}`)
  const description = own(data, 'description')
  const rounds = own(data, 'rounds')
  const nodes = own(data, 'nodes')
  if (!Array.isArray(nodes) || nodes.length === 0) fail('nodes', 'must list at least one node')
  if (nodes.length > MAX_SOP_NODES) fail('nodes', `more than ${MAX_SOP_NODES} nodes`)
  const read = nodes.map((node, index) => readNode(node, join('nodes', index), language))
  const sop: Sop = {
    format: SOP_FORMAT,
    id: id(data, ''),
    name: named(own(data, 'name'), 'name', SOP_NAME_CHARS, language),
    description:
      description === undefined
        ? ''
        : named(description, 'description', SOP_DESCRIPTION_CHARS, language),
    start: read[0]!.id,
    nodes: read,
    rounds: rounds === undefined ? DEFAULT_ROUNDS : integer(rounds, 'rounds', ROUNDS),
  }
  checkGraph(sop)
  return sop
}

/**
 * Parses and validates an SOP file, with its names in `language` where it gives them by language.
 * Throws an SopProblem that names the field it found wrong.
 */
export function parseSop(text: string, language: string): Sop {
  if (text.length > SOP_FILE_CHARS) {
    throw new SopProblem(`the file is longer than ${SOP_FILE_CHARS} characters`)
  }
  const doc = parseDocument(text, {
    schema: 'core',
    customTags: [],
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    logLevel: 'silent',
  })
  const issue = doc.errors[0] ?? doc.warnings[0]
  if (issue) throw new SopProblem(`not valid YAML: ${issue.message.split('\n')[0]}`)
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
  if (alias) throw new SopProblem('YAML aliases are not allowed')
  return readSop(doc.toJS({ maxAliasCount: 0 }), language)
}

/** The SOP's nodes and arrows without its prompts. */
export function outlineOf(sop: Sop): SopOutline {
  return {
    start: sop.start,
    nodes: sop.nodes.map(({ id, name, by, handIn, outcomes, prompt }) => ({
      id,
      name,
      by,
      handIn,
      outcomes,
      ...(by.kind === 'person' ? { question: prompt } : {}),
    })),
  }
}

/** SHA-256 of the file as read, in hex. */
export function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The file format, for an agent that writes an SOP. */
export const SOP_GUIDE = `An SOP is a flowchart a task must follow: nodes, each done by its own agent or by the person, and outcomes whose arrows say where the work goes next. In YAML:

format: 1
id: bug-fix          # lowercase letters, digits and dashes
name: Bug fix        # text, or by language: { en: Bug fix, zh-CN: 修复缺陷 }
description: Fix a bug and check that it is gone.
rounds: 3            # optional, 1 to 10
nodes:               # in the order of the flow; the first is the start
  - id: fix
    name: Fix
    by: standard     # the agent: deep | standard | fast; or person
    hand-in: note    # document | verdict | note; left out for a person
    prompt: Find the cause of the bug and fix it. Say what the cause was.
    outcomes:
      - { id: fixed, name: Fixed, to: verify }
  - id: verify
    name: Verify
    by: deep
    hand-in: verdict
    prompt: Check that the bug is gone and nothing else broke.
    outcomes:
      - { id: pass, name: Fixed, end: done }
      - { id: fail, name: Not fixed, to: fix }

Rules:
- An outcome has exactly one of "to" (a node id, or a list of ids that start at once, each in its own branch) and "end" (done, or dropped: not to be done).
- An arrow to a later node goes forward. One to the same or an earlier node sends the work back, "rounds" times at most; such an outcome may set its own "rounds".
- Branches join at a node they all lead to: it starts once every branch has arrived.
- Every node is reached from the first by arrows forward and leads to an end.
- hand-in: a document is Markdown the node writes, such as a design; a verdict is a judgement with its reason and needs two or more outcomes; a note says what was done.
- A prompt says what to do and what to hand in. Names and the description may be maps by language. No other keys.`
