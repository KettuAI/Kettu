import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { createExec } from '../git/exec'
import { OFFICIAL_WORKFLOWS } from './official'
import { listWorkflows, readWorkflow, type WorkflowSourceDeps } from './sources'
import { parseWorkflow, workflowHash } from './workflow'

type Data = Record<string, unknown>

function agent(id: string, next: string | null, extra: Data = {}): Data {
  return {
    id,
    name: id,
    kind: 'agent',
    prompt: `Do ${id}.`,
    tier: 'standard',
    scope: { level: 'commands', web: false },
    session: 'new',
    contract: [{ name: 'notes', type: 'text', description: 'What was done.' }],
    evidence: [],
    gate: 'contract',
    next,
    ...extra,
  }
}

function base(): Data {
  return {
    format: 1,
    id: 'flow',
    name: 'Flow',
    description: 'A test flow.',
    kind: 'development',
    version: '1',
    worktree: true,
    start: 'build',
    stages: [
      agent('build', 'check'),
      agent('check', 'accept', { rework: { to: 'build' } }),
      {
        id: 'accept',
        name: 'Accept',
        kind: 'human',
        prompt: 'Accept?',
        sendBack: ['build'],
        next: 'ship',
      },
      { id: 'ship', name: 'Ship', kind: 'handover', action: 'pull-request', next: null },
    ],
  }
}

function stages(data: Data): Data[] {
  return data.stages as Data[]
}

function problemOf(data: Data): string {
  const result = parseWorkflow(stringify(data))
  if ('workflow' in result) throw new Error('expected a problem')
  return result.problem
}

describe('parseWorkflow', () => {
  it('reads every official workflow', () => {
    expect(OFFICIAL_WORKFLOWS.length).toBeGreaterThan(0)
    for (const { file, text } of OFFICIAL_WORKFLOWS) {
      const result = parseWorkflow(text)
      expect(result, file).not.toHaveProperty('problem')
    }
    const development = parseWorkflow(OFFICIAL_WORKFLOWS[0]!.text)
    if (!('workflow' in development)) throw new Error(development.problem)
    expect(development.workflow.id).toBe('development')
    expect(development.workflow.stages.at(-1)).toMatchObject({ kind: 'handover' })
  })

  it('fills in defaults, rework rounds from the limits', () => {
    const result = parseWorkflow(stringify(base()))
    if (!('workflow' in result)) throw new Error(result.problem)
    const { workflow } = result
    expect(workflow.limits).toEqual({ rounds: 3, stageMinutes: 60, budgetUsd: null })
    const check = workflow.stages[1]!
    expect(check.kind === 'agent' && check.rework).toEqual({ to: 'build', rounds: 3 })
  })

  it('names the field of an unknown stage reference', () => {
    const data = base()
    stages(data)[1]!.rework = { to: 'buid' }
    expect(problemOf(data)).toBe('stages[1].rework.to: no stage "buid"')

    const next = base()
    stages(next)[0]!.next = 'nowhere'
    expect(problemOf(next)).toBe('stages[0].next: no stage "nowhere"')

    const start = base()
    start.start = 'nope'
    expect(problemOf(start)).toBe('start: no stage "nope"')

    const back = base()
    stages(back)[2]!.sendBack = ['gone']
    expect(problemOf(back)).toBe('stages[2].sendBack[0]: no stage "gone"')

    const other = base()
    stages(other)[1]!.requires = { otherHarnessThan: 'missing' }
    expect(problemOf(other)).toBe('stages[1].requires.otherHarnessThan: no stage "missing"')
  })

  it('refuses duplicate ids, bad tiers and unknown keys', () => {
    const duplicate = base()
    stages(duplicate)[1]!.id = 'build'
    expect(problemOf(duplicate)).toMatch(/^stages\[1\]\.id: another stage is "build"/)

    const tier = base()
    stages(tier)[0]!.tier = 'huge'
    expect(problemOf(tier)).toMatch(/^stages\[0\]\.tier: must be one of/)

    const sized = base()
    stages(sized)[0]!.tier = { L: 'deep' }
    expect(problemOf(sized)).toMatch(/^stages\[0\]\.tier\.default: must be one of/)

    const typo = base()
    stages(typo)[1]!.rewrok = { to: 'build' }
    expect(problemOf(typo)).toBe('stages[1].rewrok: unknown key')

    const kebab = base()
    kebab.id = 'Not_Kebab'
    expect(problemOf(kebab)).toMatch(/^id: must be kebab-case/)
  })

  it('refuses a missing or malformed contract', () => {
    const missing = base()
    delete stages(missing)[0]!.contract
    expect(problemOf(missing)).toBe('stages[0].contract: must list at least one field')

    const twice = base()
    stages(twice)[0]!.contract = [
      { name: 'a', type: 'text', description: 'x' },
      { name: 'a', type: 'list', description: 'y' },
    ]
    expect(problemOf(twice)).toBe('stages[0].contract[1].name: another field is named "a"')

    const sizes = base()
    stages(sizes)[0]!.contract = [
      { name: 'a', type: 'size', description: 'x' },
      { name: 'b', type: 'size', description: 'y' },
    ]
    expect(problemOf(sizes)).toBe('stages[0].contract: at most one field of type size')

    const commands = base()
    stages(commands)[0]!.evidence = ['reported-commands-ran']
    expect(problemOf(commands)).toMatch(/needs a required list field named "commands"/)

    const readOnly = base()
    stages(readOnly)[0]!.scope = { level: 'read', web: false }
    stages(readOnly)[0]!.evidence = ['ran-command']
    expect(problemOf(readOnly)).toBe('stages[0].evidence: ran-command needs scope level commands')
  })

  it('refuses limits out of bounds and long text', () => {
    const rounds = base()
    rounds.limits = { rounds: 11 }
    expect(problemOf(rounds)).toBe('limits.rounds: must be from 1 to 10')

    const minutes = base()
    minutes.limits = { stageMinutes: 1 }
    expect(problemOf(minutes)).toBe('limits.stageMinutes: must be from 5 to 480')

    const budget = base()
    budget.limits = { budgetUsd: 0 }
    expect(problemOf(budget)).toMatch(/^limits\.budgetUsd:/)

    const prompt = base()
    stages(prompt)[0]!.prompt = 'x'.repeat(20_001)
    expect(problemOf(prompt)).toBe('stages[0].prompt: longer than 20000 characters')

    const many = base()
    stages(many).push(...Array.from({ length: 30 }, (_, i) => agent(`extra-${i}`, null)))
    expect(problemOf(many)).toBe('stages: more than 30 stages')

    const format = base()
    format.format = 2
    expect(problemOf(format)).toBe('format: must be 1')
  })

  it('refuses an unreachable stage and a loop of passes', () => {
    const unreachable = base()
    stages(unreachable).push(agent('orphan', null))
    expect(problemOf(unreachable)).toBe('stages[4]: "orphan" is never reached from the start')

    const loop = base()
    loop.stages = [agent('a', 'b'), agent('b', 'a')]
    loop.start = 'a'
    expect(problemOf(loop)).toBe('stages[0]: passing "a" never ends the task')
  })

  it('keeps the floor: a handover follows only an unconditional human stage', () => {
    const direct = base()
    stages(direct)[1]!.next = 'ship'
    stages(direct)[2]!.next = null
    expect(problemOf(direct)).toBe('stages[1].next: handover "ship" must follow a human stage')

    const skippable = base()
    stages(skippable)[2]!.when = { size: ['L'] }
    expect(problemOf(skippable)).toBe(
      'stages[2].when: the human stage before handover "ship" cannot be skipped',
    )

    const rework = base()
    stages(rework)[1]!.rework = { to: 'ship' }
    expect(problemOf(rework)).toBe('stages[1].rework.to: "ship" is not an agent stage')

    const sendBack = base()
    stages(sendBack)[2]!.sendBack = ['ship']
    expect(problemOf(sendBack)).toBe('stages[2].sendBack[0]: "ship" is not an agent stage')

    const start = base()
    start.start = 'ship'
    expect(problemOf(start)).toBe('start: a handover cannot be the first stage')
  })

  it('refuses YAML aliases, custom tags and duplicate keys', () => {
    const text = stringify(base())
    expect(parseWorkflow(`${text}x: &a [1]\ny: *a\n`)).toEqual({
      problem: 'YAML aliases are not allowed',
    })
    expect(parseWorkflow(text.replace('name: Flow', 'name: !!js/function Flow'))).toHaveProperty(
      'problem',
    )
    expect(parseWorkflow(`${text}name: Again\n`)).toHaveProperty('problem')
  })

  it('hashes the file stably', () => {
    const text = stringify(base())
    expect(workflowHash(text)).toBe(workflowHash(text))
    expect(workflowHash(text)).toMatch(/^[0-9a-f]{64}$/)
    expect(workflowHash(`${text} `)).not.toBe(workflowHash(text))
  })
})

describe('workflow sources', () => {
  const ENV = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const exec = createExec(() => ({ ...process.env, ...ENV })).exec
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8' })
  let dir: string
  let project: string

  const flow = (id: string, name: string): string => stringify({ ...base(), id, name })

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kettu-workflows-'))
    project = path.join(dir, 'project')
    await mkdir(path.join(project, '.kettu/workflows'), { recursive: true })
    git(project, 'init', '-q', '-b', 'main')
    await writeFile(
      path.join(project, '.kettu/workflows/development.yaml'),
      flow('development', 'Ours'),
    )
    await writeFile(path.join(project, '.kettu/workflows/broken.yml'), 'format: 1\n')
    git(project, 'add', '.')
    git(project, 'commit', '-q', '-m', 'workflows')
    // A branch and the working tree never count: only the default branch does.
    git(project, 'switch', '-q', '-c', 'feature')
    await writeFile(
      path.join(project, '.kettu/workflows/development.yaml'),
      flow('development', 'Edited'),
    )
    await writeFile(path.join(project, '.kettu/workflows/sneaky.yaml'), flow('sneaky', 'Sneaky'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const deps = (files: { file: string; text: string }[] = []): WorkflowSourceDeps => ({
    exec,
    libraryDir: '/library',
    readLibrary: async () => files,
  })

  it('lists the project first, overriding an official workflow with its id', async () => {
    const list = await listWorkflows(
      project,
      deps([{ file: 'mine.yaml', text: flow('mine', 'Mine') }]),
    )
    expect(list.map((item) => [item.source, item.id, item.name, item.problem !== null])).toEqual([
      ['project', 'broken', 'broken', true],
      ['project', 'development', 'Ours', false],
      ['library', 'mine', 'Mine', false],
      ['official', 'research', 'Research', false],
      ['official', 'review', 'Code review', false],
    ])
  })

  it('reads a project workflow from the default branch only', async () => {
    const { workflow, hash } = await readWorkflow(project, 'project', 'development', deps())
    expect(workflow.name).toBe('Ours')
    expect(hash).toBe(workflowHash(flow('development', 'Ours')))
    await expect(readWorkflow(project, 'project', 'sneaky', deps())).rejects.toThrow(/No project/)
    await expect(readWorkflow(project, 'project', 'broken', deps())).rejects.toThrow(/is invalid/)
  })

  it('reads official and library workflows', async () => {
    const official = await readWorkflow(null, 'official', 'development', deps())
    expect(official.workflow.name).toBe('Development')
    const library = await readWorkflow(
      null,
      'library',
      'mine',
      deps([{ file: 'm.yaml', text: flow('mine', 'Mine') }]),
    )
    expect(library.workflow.name).toBe('Mine')
  })

  it('finds no project workflows outside a git repository', async () => {
    const list = await listWorkflows(dir, deps())
    expect(list.every((item) => item.source === 'official')).toBe(true)
  })
})
