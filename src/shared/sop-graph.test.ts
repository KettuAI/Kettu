import { describe, expect, it } from 'vitest'
import { sopGraph } from './sop-graph'
import type { SopOutline } from './tasks'

const node = (id: string, outcomes: [string, string[]][]): SopOutline['nodes'][number] => ({
  id,
  name: id,
  by: { kind: 'agent', tier: 'deep' },
  handIn: 'note',
  outcomes: outcomes.map(([outcome, to]) => ({
    id: outcome,
    name: outcome,
    to,
    ...(to.length > 0 ? {} : { end: 'done' as const }),
  })),
})

const outline: SopOutline = {
  start: 'review',
  nodes: [
    node('review', [
      ['big', ['requirements']],
      ['small', ['frontend', 'backend']],
      ['no', []],
    ]),
    node('requirements', [['done', ['design']]]),
    node('design', [
      ['done', ['frontend', 'backend']],
      ['problem', ['requirements']],
    ]),
    node('frontend', [['done', ['test']]]),
    node('backend', [
      ['done', ['test']],
      ['design-problem', ['design']],
    ]),
    node('test', [
      ['pass', []],
      ['fail', ['frontend', 'backend']],
      ['again', ['test']],
    ]),
  ],
}

describe('sopGraph', () => {
  const graph = sopGraph(outline)

  it('takes an arrow to an earlier node, or to the node itself, as one back', () => {
    const back = graph.edges.filter((edge) => edge.back).map((edge) => `${edge.from}>${edge.to}`)
    expect(back.sort()).toEqual([
      'backend>design',
      'design>requirements',
      'test>backend',
      'test>frontend',
      'test>test',
    ])
  })

  it('knows what each node still leads to along arrows forward', () => {
    expect([...graph.reach.review!].sort()).toEqual([
      'backend',
      'design',
      'frontend',
      'requirements',
      'test',
    ])
    expect(graph.reach.frontend).toEqual(['test'])
    expect(graph.reach.test).toEqual([])
  })

  it('places a node in the column of its longest way from the start', () => {
    expect(graph.place.review).toEqual({ column: 0, row: 0 })
    expect(graph.place.frontend).toEqual({ column: 3, row: 0 })
    expect(graph.place.backend).toEqual({ column: 3, row: 1 })
    expect(graph.place.test).toEqual({ column: 4, row: 0 })
  })

  it('ignores a target that names no node', () => {
    const broken = sopGraph({ start: 'a', nodes: [node('a', [['done', ['missing']]])] })
    expect(broken.edges).toEqual([])
    expect(broken.place.a).toEqual({ column: 0, row: 0 })
  })
})
