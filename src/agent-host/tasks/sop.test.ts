import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { sopGraph } from '@shared/sop-graph'
import { MAX_NODE_OUTCOMES, MAX_SOP_NODES, SOP_FILE_CHARS } from '@shared/tasks'
import { OFFICIAL_SOPS } from './official'
import { hashOf, isSopId, outlineOf, parseSop, SOP_GUIDE, SopProblem } from './sop'

type Data = Record<string, unknown>

function node(id: string, outcomes: Data[], extra: Data = {}): Data {
  return {
    id,
    name: id,
    by: 'standard',
    'hand-in': 'note',
    prompt: `Do ${id}.`,
    outcomes,
    ...extra,
  }
}

const to = (id: string, target: string | string[], extra: Data = {}): Data => ({
  id,
  name: id,
  to: target,
  ...extra,
})
const end = (id: string, how: 'done' | 'dropped' = 'done'): Data => ({ id, name: id, end: how })

/** build, then check, which ends the task or sends the work back. */
function base(): Data {
  return {
    format: 1,
    id: 'flow',
    name: 'Flow',
    description: 'A test flow.',
    nodes: [
      node('build', [to('built', 'check')]),
      node('check', [end('pass'), to('fail', 'build')], { 'hand-in': 'verdict' }),
    ],
  }
}

function nodes(data: Data): Data[] {
  return data.nodes as Data[]
}

function outcomes(data: Data, at: number): Data[] {
  return nodes(data)[at]!.outcomes as Data[]
}

function problemOf(source: Data | string): string {
  try {
    parseSop(typeof source === 'string' ? source : stringify(source), 'en')
  } catch (error) {
    if (error instanceof SopProblem) return error.message
    throw error
  }
  throw new Error('expected a problem')
}

describe('parseSop', () => {
  it('reads a sequence, with the defaults', () => {
    const data = base()
    delete data.description
    nodes(data)[1] = node('check', [end('pass')])
    expect(parseSop(stringify(data), 'en')).toEqual({
      format: 1,
      id: 'flow',
      name: 'Flow',
      description: '',
      start: 'build',
      rounds: 3,
      nodes: [
        {
          id: 'build',
          name: 'build',
          prompt: 'Do build.',
          by: { kind: 'agent', tier: 'standard' },
          handIn: 'note',
          outcomes: [{ id: 'built', name: 'built', to: ['check'] }],
        },
        {
          id: 'check',
          name: 'check',
          prompt: 'Do check.',
          by: { kind: 'agent', tier: 'standard' },
          handIn: 'note',
          outcomes: [{ id: 'pass', name: 'pass', to: [], end: 'done' }],
        },
      ],
    })
  })

  it('reads a branch, whose outcomes lead to different nodes or end the task', () => {
    const sop = parseSop(
      stringify({
        ...base(),
        nodes: [
          node('review', [to('big', 'design'), to('small', 'build'), end('no', 'dropped')], {
            by: 'deep',
            'hand-in': 'verdict',
          }),
          node('design', [to('ready', 'build')], { 'hand-in': 'document' }),
          node('build', [end('built')], { by: 'fast' }),
        ],
      }),
      'en',
    )
    expect(sop.start).toBe('review')
    expect(sop.nodes.map((each) => [each.by, each.handIn])).toEqual([
      [{ kind: 'agent', tier: 'deep' }, 'verdict'],
      [{ kind: 'agent', tier: 'standard' }, 'document'],
      [{ kind: 'agent', tier: 'fast' }, 'note'],
    ])
    expect(sop.nodes[0]!.outcomes).toEqual([
      { id: 'big', name: 'big', to: ['design'] },
      { id: 'small', name: 'small', to: ['build'] },
      { id: 'no', name: 'no', to: [], end: 'dropped' },
    ])
  })

  it('reads an arrow back, with the rounds of the SOP and of the outcome', () => {
    const data = { ...base(), rounds: 5 }
    outcomes(data, 1).push(to('again', 'check', { rounds: 2 }))
    const sop = parseSop(stringify(data), 'en')
    expect(sop.rounds).toBe(5)
    expect(sop.nodes[1]!.outcomes).toEqual([
      { id: 'pass', name: 'pass', to: [], end: 'done' },
      { id: 'fail', name: 'fail', to: ['build'] },
      { id: 'again', name: 'again', to: ['check'], rounds: 2 },
    ])
    expect(sopGraph(outlineOf(sop)).edges.map((edge) => edge.back)).toEqual([false, true, true])
  })

  it('reads a split and its join', () => {
    const sop = parseSop(
      stringify({
        ...base(),
        nodes: [
          node('design', [to('ready', ['front', 'back'])]),
          node('front', [to('built', 'check')]),
          node('back', [to('built', 'check')]),
          node('check', [end('pass'), to('fail', ['front', 'back'])], { 'hand-in': 'verdict' }),
        ],
      }),
      'en',
    )
    expect(sop.nodes[0]!.outcomes[0]!.to).toEqual(['front', 'back'])
    expect(sopGraph(outlineOf(sop)).reach).toMatchObject({
      design: ['front', 'check', 'back'],
      front: ['check'],
      back: ['check'],
    })
  })

  it("gives a person's node a verdict, whatever its outcomes", () => {
    const data = base()
    nodes(data)[1] = {
      id: 'check',
      name: 'Accept',
      by: 'person',
      prompt: 'Accept it?',
      outcomes: [end('accept')],
    }
    expect(parseSop(stringify(data), 'en').nodes[1]).toEqual({
      id: 'check',
      name: 'Accept',
      prompt: 'Accept it?',
      by: { kind: 'person' },
      handIn: 'verdict',
      outcomes: [{ id: 'accept', name: 'accept', to: [], end: 'done' }],
    })
  })

  it('takes names by language: the one asked for, else English, else the first', () => {
    const data = base()
    data.name = { en: 'Flow', 'zh-CN': '流程' }
    data.description = { 'zh-CN': '说明', fr: 'Description' }
    nodes(data)[0]!.name = { fr: 'Construire', en: 'Build' }
    outcomes(data, 0)[0]!.name = { 'zh-CN': '完成' }
    const read = (language: string) => {
      const sop = parseSop(stringify(data), language)
      const first = sop.nodes[0]!
      return [sop.name, sop.description, first.name, first.outcomes[0]!.name]
    }
    expect(read('zh-CN')).toEqual(['流程', '说明', 'Build', '完成'])
    expect(read('en')).toEqual(['Flow', '说明', 'Build', '完成'])
    expect(read('fr')).toEqual(['Flow', 'Description', 'Construire', '完成'])
  })

  it('reads every SOP Kettu ships, in both languages', () => {
    expect(OFFICIAL_SOPS.map(({ file }) => file)).toEqual([
      'development.yaml',
      'bug-fix.yaml',
      'parallel-build.yaml',
    ])
    for (const { file, text } of OFFICIAL_SOPS) {
      const en = parseSop(text, 'en')
      const zh = parseSop(text, 'zh-CN')
      expect(`${en.id}.yaml`).toBe(file)
      expect(en.description).not.toBe('')
      // Every name is given in both languages.
      expect(zh.name).not.toBe(en.name)
      expect(zh.description).not.toBe(en.description)
      zh.nodes.forEach((each, at) => {
        expect(each.name, `${file} ${each.id}`).not.toBe(en.nodes[at]!.name)
        expect(each.prompt, `${file} ${each.id}`).toContain('language of the requirement')
        each.outcomes.forEach((outcome, o) => {
          expect(outcome.name, `${file} ${each.id}/${outcome.id}`).not.toBe(
            en.nodes[at]!.outcomes[o]!.name,
          )
        })
      })
    }
    const names = (file: number) =>
      parseSop(OFFICIAL_SOPS[file]!.text, 'zh-CN').nodes.map((each) => each.name)
    expect(names(0)).toEqual(['评审', '需求文档', '设计方案', '开发', '测试'])
    expect(names(1)).toEqual(['复现', '修复', '验证'])
    expect(names(2)).toEqual(['设计方案', '开发', '编写测试', '验证'])
    const parallel = parseSop(OFFICIAL_SOPS[2]!.text, 'en')
    expect(parallel.nodes[0]!.outcomes[0]!.to).toEqual(['build', 'write-tests'])
  })

  it.each<[string, (data: Data) => void, string]>([
    ['an unknown key', (data) => (data.start = 'build'), 'start: unknown key'],
    [
      'an unknown key of a node',
      (data) => (nodes(data)[0]!.tier = 'deep'),
      'nodes[0].tier: unknown key',
    ],
    [
      'an unknown key of an outcome',
      (data) => (outcomes(data, 0)[0]!.next = 'check'),
      'nodes[0].outcomes[0].next: unknown key',
    ],
    ['another format', (data) => (data.format = 2), 'format: must be 1'],
    ['an id that is not kebab-case', (data) => (data.id = 'My_Flow'), 'id: must be lowercase'],
    ['an id with a path in it', (data) => (data.id = '../flow'), 'id: must be lowercase'],
    ['an id no file may have', (data) => (data.id = 'con'), 'id: "con" cannot be a file name'],
    ['a missing name', (data) => delete data.name, 'name: must be text'],
    [
      'a name that is too long',
      (data) => (data.name = 'x'.repeat(81)),
      'name: longer than 80 characters',
    ],
    ['a name in no language', (data) => (data.name = {}), 'name: must name at least one language'],
    [
      'a name under something that is no language',
      (data) => (data.name = { English: 'Flow' }),
      'name.English: must be a language tag',
    ],
    [
      'an empty name in one language',
      (data) => (data.name = { en: 'Flow', 'zh-CN': ' ' }),
      'name.zh-CN: must not be empty',
    ],
    ['rounds out of range', (data) => (data.rounds = 11), 'rounds: must be from 1 to 10'],
    ['rounds that are no whole number', (data) => (data.rounds = 1.5), 'rounds: must be a whole'],
    ['no nodes', (data) => (data.nodes = []), 'nodes: must list at least one node'],
    [
      'too many nodes',
      (data) => {
        const many = Array.from({ length: MAX_SOP_NODES }, (_, at) =>
          node(`n${at}`, [to('next', `n${at + 1}`)]),
        )
        data.nodes = [...many, node(`n${MAX_SOP_NODES}`, [end('done')])]
      },
      `nodes: more than ${MAX_SOP_NODES} nodes`,
    ],
    [
      'two nodes with one id',
      (data) => nodes(data).push(node('build', [end('done')])),
      'nodes[2].id: another node is "build"',
    ],
    [
      'who does a node, when it is no tier and not the person',
      (data) => (nodes(data)[0]!.by = 'expert'),
      'nodes[0].by: must be one of deep, standard, fast, person',
    ],
    [
      "an agent's node without a hand-in",
      (data) => delete nodes(data)[0]!['hand-in'],
      'nodes[0].hand-in: must be one of document, verdict, note',
    ],
    [
      "a hand-in on a person's node",
      (data) => (nodes(data)[1]!.by = 'person'),
      "nodes[1].hand-in: must be left out of a person's node",
    ],
    [
      'an empty prompt',
      (data) => (nodes(data)[0]!.prompt = '  '),
      'nodes[0].prompt: must not be empty',
    ],
    [
      'a node without outcomes',
      (data) => (nodes(data)[0]!.outcomes = []),
      'nodes[0].outcomes: must list at least one outcome',
    ],
    [
      'too many outcomes',
      (data) => {
        const many = Array.from({ length: MAX_NODE_OUTCOMES + 1 }, (_, at) => end(`o${at}`))
        nodes(data)[1]!.outcomes = many
      },
      `nodes[1].outcomes: more than ${MAX_NODE_OUTCOMES} outcomes`,
    ],
    [
      'a verdict with one outcome',
      (data) => outcomes(data, 1).pop(),
      'nodes[1].outcomes: a verdict needs two or more outcomes',
    ],
    [
      'two outcomes of a node with one id',
      (data) => (outcomes(data, 1)[1]!.id = 'pass'),
      'nodes[1].outcomes[1].id: another outcome of this node is "pass"',
    ],
    [
      'an outcome with both an arrow and an end',
      (data) => (outcomes(data, 0)[0]!.end = 'done'),
      'nodes[0].outcomes[0]: must have exactly one of "to" and "end"',
    ],
    [
      'an outcome with neither',
      (data) => delete outcomes(data, 0)[0]!.to,
      'nodes[0].outcomes[0]: must have exactly one of "to" and "end"',
    ],
    [
      'an end that is neither done nor dropped',
      (data) => (outcomes(data, 1)[0]!.end = 'cancelled'),
      'nodes[1].outcomes[0].end: must be one of done, dropped',
    ],
    [
      'rounds on an outcome that ends the task',
      (data) => (outcomes(data, 1)[0]!.rounds = 2),
      'nodes[1].outcomes[0].rounds: only an outcome with "to" has rounds',
    ],
    [
      'rounds of an outcome out of range',
      (data) => (outcomes(data, 1)[1]!.rounds = 0),
      'nodes[1].outcomes[1].rounds: must be from 1 to 10',
    ],
    [
      'an arrow to no node',
      (data) => (outcomes(data, 0)[0]!.to = 'ship'),
      'nodes[0].outcomes[0].to: no node "ship"',
    ],
    [
      'an empty list of targets',
      (data) => (outcomes(data, 0)[0]!.to = []),
      'nodes[0].outcomes[0].to: must be a node id or a list of node ids',
    ],
    [
      'one target twice in an outcome',
      (data) => (outcomes(data, 0)[0]!.to = ['check', 'check']),
      'nodes[0].outcomes[0].to[1]: "check" is listed twice',
    ],
    [
      'a node no arrow leads to',
      (data) => nodes(data).push(node('ship', [end('done')])),
      'nodes[2]: "ship" is not reached from the first node by arrows forward',
    ],
    [
      'a node only an arrow back leads to',
      (data) => {
        data.nodes = [
          node('build', [to('built', 'check')]),
          node('fix', [to('fixed', 'check')]),
          node('check', [end('pass'), to('fail', 'fix')], { 'hand-in': 'verdict' }),
        ]
      },
      'nodes[1]: "fix" is not reached from the first node by arrows forward',
    ],
    [
      'no outcome that ends the task',
      (data) => (outcomes(data, 1)[0] = to('pass', 'check')),
      'nodes: no outcome ends the task',
    ],
    [
      'a node that never leads to an end',
      (data) => {
        outcomes(data, 0).push(to('stuck', 'loop'))
        nodes(data).push(node('loop', [to('again', 'loop')]))
      },
      'nodes[2]: "loop" never leads to an outcome that ends the task',
    ],
  ])('rejects %s', (_name, change, problem) => {
    const data = base()
    change(data)
    expect(problemOf(data)).toContain(problem)
  })

  it('rejects what is not a mapping of plain YAML', () => {
    expect(problemOf('- a\n- b\n')).toBe('must be a mapping')
    expect(problemOf('format: 1\nid: [')).toContain('not valid YAML')
    expect(problemOf('format: 1\nformat: 1\n')).toContain('not valid YAML')
    const aliased = stringify(base()).replace('name: Flow', 'name: &n Flow\ndescription: *n')
    expect(problemOf(aliased.replace('description: A test flow.\n', ''))).toBe(
      'YAML aliases are not allowed',
    )
  })

  it('rejects a file that is too long, without parsing it', () => {
    const long = `${stringify(base())}# ${'x'.repeat(SOP_FILE_CHARS)}\n`
    expect(problemOf(long)).toBe(`the file is longer than ${SOP_FILE_CHARS} characters`)
  })
})

describe('isSopId', () => {
  it('takes only what is safe as a file name', () => {
    expect(['flow', 'bug-fix', 'a1-b2'].every(isSopId)).toBe(true)
    for (const id of [
      '',
      '..',
      '../flow',
      'a/b',
      'a\\b',
      'a.b',
      'Flow',
      '-a',
      'a-',
      'a--b',
      '1a',
    ]) {
      expect(isSopId(id), id).toBe(false)
    }
    expect(isSopId('nul')).toBe(false)
    expect(isSopId('com1')).toBe(false)
    expect(isSopId('a'.repeat(41))).toBe(false)
    expect(isSopId(7)).toBe(false)
  })
})

describe('outlineOf, hashOf and the guide', () => {
  it('keeps the nodes and arrows and drops the prompts', () => {
    const sop = parseSop(stringify(base()), 'en')
    const outline = outlineOf(sop)
    expect(outline.start).toBe('build')
    expect(outline.nodes).toEqual(sop.nodes.map((each) => ({ ...each, prompt: undefined })))
    expect(JSON.stringify(outline)).not.toContain('Do build.')
  })

  it('hashes the text with SHA-256', () => {
    expect(hashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hashOf('abc\n')).not.toBe(hashOf('abc'))
  })

  it('describes the format with an example that reads', () => {
    expect(SOP_GUIDE.length).toBeLessThan(1800)
    const example = SOP_GUIDE.slice(SOP_GUIDE.indexOf('format: 1'), SOP_GUIDE.indexOf('\n\nRules:'))
    const sop = parseSop(example, 'en')
    expect(sop.id).toBe('bug-fix')
    expect(sop.nodes.map((each) => each.id)).toEqual(['fix', 'verify'])
  })
})
