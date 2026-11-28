import { describe, expect, it } from 'vitest'
import {
  BRANCH_GRAPH_LANE_COLORS,
  BRANCH_GRAPH_LANE_COUNT,
  computeBranchGraphLayout,
  laneColorVar,
  type BranchGraphLayout,
  type GraphLayoutInputCommit,
} from './branch-graph-layout'

/**
 * Verifies that every vertical/curved connection exiting the bottom of row `i` aligns exactly
 * with the rails/edges entering the top of row `i + 1`.
 */
function expectContinuousBoundaries(layout: BranchGraphLayout): void {
  for (let i = 0; i < layout.rows.length - 1; i++) {
    const current = layout.rows[i]!
    const next = layout.rows[i + 1]!
    const bottomCols = new Set<number>([
      ...current.passThrough.map((rail) => rail.col),
      ...current.outEdges.map((edge) => edge.toCol),
    ])
    const topCols = new Set<number>([
      ...next.passThrough.map((rail) => rail.col),
      ...next.inEdges.map((edge) => edge.fromCol),
    ])
    expect([...bottomCols].sort((a, b) => a - b)).toEqual([...topCols].sort((a, b) => a - b))
  }
}

describe('computeBranchGraphLayout', () => {
  it('returns an empty layout for empty commit history', () => {
    const layout = computeBranchGraphLayout([])
    expect(layout).toEqual({ rows: [], maxLanes: 0, openLanes: [] })
  })

  it('lays out linear history on a single lane ending at the root commit', () => {
    const commits: GraphLayoutInputCommit[] = [
      { oid: 'c3', parents: ['c2'] },
      { oid: 'c2', parents: ['c1'] },
      { oid: 'c1', parents: [] },
    ]
    const layout = computeBranchGraphLayout(commits)
    expect(layout.maxLanes).toBe(1)
    expect(layout.openLanes).toEqual([])
    expect(layout.rows.map((r) => [r.oid, r.col, r.color, r.isMerge, r.isRoot])).toEqual([
      ['c3', 0, 0, false, false],
      ['c2', 0, 0, false, false],
      ['c1', 0, 0, false, true],
    ])
    expect(layout.rows[0]!.inEdges).toEqual([])
    expect(layout.rows[0]!.outEdges).toEqual([{ fromCol: 0, toCol: 0, color: 0 }])
    expect(layout.rows[2]!.outEdges).toEqual([])
    expectContinuousBoundaries(layout)
  })

  it('draws a clean branch fork and merges side lane back into trunk', () => {
    const commits: GraphLayoutInputCommit[] = [
      { oid: 'main-2', parents: ['base'] },
      { oid: 'feat-1', parents: ['base'] },
      { oid: 'base', parents: [] },
    ]
    const layout = computeBranchGraphLayout(commits)
    expect(layout.maxLanes).toBe(2)
    expect(layout.rows[0]!.col).toBe(0)
    expect(layout.rows[1]!.col).toBe(1)
    expect(layout.rows[1]!.color).not.toBe(layout.rows[0]!.color)
    // feat-1 curves directly into column 0 since `base` is already expected on column 0.
    expect(layout.rows[1]!.outEdges).toEqual([
      { fromCol: 1, toCol: 0, color: layout.rows[1]!.color },
    ])
    expect(layout.rows[2]!.col).toBe(0)
    expect(layout.openLanes).toEqual([])
    expectContinuousBoundaries(layout)
  })

  it('keeps the main trunk straight across a two-parent merge and converges on the base commit', () => {
    const commits: GraphLayoutInputCommit[] = [
      { oid: 'merge', parents: ['main-1', 'feat-1'] },
      { oid: 'feat-1', parents: ['base'] },
      { oid: 'main-1', parents: ['base'] },
      { oid: 'base', parents: [] },
    ]
    const layout = computeBranchGraphLayout(commits)
    expect(layout.maxLanes).toBe(2)
    expect(layout.rows[0]!.isMerge).toBe(true)
    expect(layout.rows[0]!.col).toBe(0)
    expect(layout.rows[0]!.outEdges.map((e) => [e.fromCol, e.toCol])).toEqual([
      [0, 0],
      [0, 1],
    ])
    // Branch commit stays on lane 1 while main trunk passes through lane 0.
    expect(layout.rows[1]!.col).toBe(1)
    expect(layout.rows[1]!.passThrough.map((r) => r.col)).toEqual([0])
    // Main commit stays on lane 0 while branch lane continues on lane 1 until base.
    expect(layout.rows[2]!.col).toBe(0)
    expect(layout.rows[2]!.passThrough.map((r) => r.col)).toEqual([1])
    // Base commit sits on lane 0 and receives both lane 0 and lane 1.
    expect(layout.rows[3]!.col).toBe(0)
    expect(layout.rows[3]!.inEdges.map((e) => [e.fromCol, e.toCol])).toEqual([
      [0, 0],
      [1, 0],
    ])
    expect(layout.openLanes).toEqual([])
    expectContinuousBoundaries(layout)
  })

  it('handles octopus merges with three parents on distinct lanes', () => {
    const commits: GraphLayoutInputCommit[] = [
      { oid: 'octo', parents: ['p1', 'p2', 'p3'] },
      { oid: 'p3', parents: ['root'] },
      { oid: 'p2', parents: ['root'] },
      { oid: 'p1', parents: ['root'] },
      { oid: 'root', parents: [] },
    ]
    const layout = computeBranchGraphLayout(commits)
    expect(layout.maxLanes).toBe(3)
    expect(layout.rows[0]!.isMerge).toBe(true)
    expect(layout.rows[0]!.outEdges.map((e) => [e.fromCol, e.toCol])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ])
    expect(layout.rows[4]!.col).toBe(0)
    expect(layout.openLanes).toEqual([])
    expectContinuousBoundaries(layout)
  })

  it('supports multiple independent root commits (orphan branches)', () => {
    const commits: GraphLayoutInputCommit[] = [
      { oid: 'main-1', parents: ['main-root'] },
      { oid: 'orphan-1', parents: ['orphan-root'] },
      { oid: 'main-root', parents: [] },
      { oid: 'orphan-root', parents: [] },
    ]
    const layout = computeBranchGraphLayout(commits)
    expect(layout.maxLanes).toBe(2)
    expect(layout.rows[2]!.isRoot).toBe(true)
    expect(layout.rows[2]!.outEdges).toEqual([])
    expect(layout.rows[3]!.isRoot).toBe(true)
    expect(layout.rows[3]!.outEdges).toEqual([])
    expect(layout.openLanes).toEqual([])
    expectContinuousBoundaries(layout)
  })

  it('reports open downward continuation lanes when history is truncated by pagination', () => {
    const commits: GraphLayoutInputCommit[] = [
      { oid: 'merge', parents: ['main-old', 'feat-old'] },
      { oid: 'feat-old', parents: ['older-ancestor'] },
    ]
    const layout = computeBranchGraphLayout(commits)
    expect(layout.openLanes.map((lane) => lane.col)).toEqual([0, 1])
    expectContinuousBoundaries(layout)
  })

  it('maps color slots cyclically to theme semantic variables', () => {
    expect(laneColorVar(0)).toBe(BRANCH_GRAPH_LANE_COLORS[0])
    expect(laneColorVar(BRANCH_GRAPH_LANE_COUNT)).toBe(BRANCH_GRAPH_LANE_COLORS[0])
    expect(laneColorVar(-1)).toBe(BRANCH_GRAPH_LANE_COLORS[BRANCH_GRAPH_LANE_COUNT - 1])
  })
})
