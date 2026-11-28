// Pure DAG swimlane layout algorithm for the read-only Git branch graph.

export interface GraphLayoutInputCommit {
  oid: string
  parents: readonly string[]
}

export interface GraphLayoutOptions {
  /** Number of distinct semantic color slots available for lanes. Defaults to 8. */
  colorCount?: number
}

export interface GraphLaneLine {
  col: number
  color: number
}

export interface GraphEdge {
  fromCol: number
  toCol: number
  color: number
}

export interface BranchGraphRowLayout {
  oid: string
  row: number
  /** Swimlane column index of this commit node. */
  col: number
  /** Semantic color slot index (0 .. colorCount - 1). */
  color: number
  /** True when the commit has two or more parents. */
  isMerge: boolean
  /** True when the commit has no parents (initial/root commit). */
  isRoot: boolean
  /** Vertical rails passing straight through this row without touching its commit node. */
  passThrough: GraphLaneLine[]
  /** Incoming segments from the top edge of this row into its commit node. */
  inEdges: GraphEdge[]
  /** Outgoing segments from this commit node to the bottom edge of this row. */
  outEdges: GraphEdge[]
  /** Number of lane columns occupied or crossed on this row. */
  laneCount: number
}

export interface BranchGraphLayout {
  rows: BranchGraphRowLayout[]
  /** Maximum lane count across all rows (0 when `commits` is empty). */
  maxLanes: number
  /** Active lanes still pointing downward after the last loaded row (used when `hasMore` is true). */
  openLanes: GraphLaneLine[]
}

/** Semantic CSS custom properties defined in tokens.css for branch graph lanes. */
export const BRANCH_GRAPH_LANE_COLORS = [
  'var(--git-graph-lane-0)',
  'var(--git-graph-lane-1)',
  'var(--git-graph-lane-2)',
  'var(--git-graph-lane-3)',
  'var(--git-graph-lane-4)',
  'var(--git-graph-lane-5)',
  'var(--git-graph-lane-6)',
  'var(--git-graph-lane-7)',
] as const

export const BRANCH_GRAPH_LANE_COUNT = BRANCH_GRAPH_LANE_COLORS.length

/** Resolves a layout color slot index to its theme-aware semantic CSS variable. */
export function laneColorVar(colorIndex: number): string {
  const index =
    ((colorIndex % BRANCH_GRAPH_LANE_COUNT) + BRANCH_GRAPH_LANE_COUNT) % BRANCH_GRAPH_LANE_COUNT
  return BRANCH_GRAPH_LANE_COLORS[index]!
}

interface ActiveSlot {
  expectedOid: string
  color: number
}

function findFreeColumn(slots: readonly (ActiveSlot | null)[], excludeCol = -1): number {
  for (let col = 0; col < slots.length; col++) {
    if (col !== excludeCol && slots[col] === null) return col
  }
  return slots.length
}

function pickLaneColor(
  slots: readonly (ActiveSlot | null)[],
  col: number,
  colorCount: number,
  nextColor: { value: number },
): number {
  const count = Math.max(1, colorCount)
  const leftColor = col > 0 ? slots[col - 1]?.color : undefined
  const rightColor = col + 1 < slots.length ? slots[col + 1]?.color : undefined
  for (let attempt = 0; attempt < count; attempt++) {
    const candidate = (nextColor.value + attempt) % count
    if (candidate !== leftColor && candidate !== rightColor) {
      nextColor.value = (candidate + 1) % count
      return candidate
    }
  }
  const fallback = nextColor.value % count
  nextColor.value = (fallback + 1) % count
  return fallback
}

function trimTrailingNulls(slots: (ActiveSlot | null)[]): void {
  while (slots.length > 0 && slots[slots.length - 1] === null) {
    slots.pop()
  }
}

/**
 * Computes deterministic swimlane columns, color slots, pass-through rails, and fork/merge curves
 * for a topologically ordered list of commits (newest first).
 */
export function computeBranchGraphLayout(
  commits: readonly GraphLayoutInputCommit[],
  options: GraphLayoutOptions = {},
): BranchGraphLayout {
  if (commits.length === 0) {
    return { rows: [], maxLanes: 0, openLanes: [] }
  }

  const colorCount = Math.max(1, Math.trunc(options.colorCount ?? BRANCH_GRAPH_LANE_COUNT))
  const slots: (ActiveSlot | null)[] = []
  const nextColor = { value: 0 }
  const rows: BranchGraphRowLayout[] = []
  let maxLanes = 1

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row]!
    const matchingCols: number[] = []
    for (let col = 0; col < slots.length; col++) {
      if (slots[col]?.expectedOid === commit.oid) matchingCols.push(col)
    }

    const inEdges: GraphEdge[] = []
    let commitCol: number
    let commitColor: number

    if (matchingCols.length > 0) {
      commitCol = matchingCols[0]!
      commitColor = slots[commitCol]!.color
      inEdges.push({ fromCol: commitCol, toCol: commitCol, color: commitColor })
      // Additional lanes expecting this same commit converge into the leftmost matching lane.
      for (let i = 1; i < matchingCols.length; i++) {
        const extraCol = matchingCols[i]!
        const extraSlot = slots[extraCol]!
        inEdges.push({ fromCol: extraCol, toCol: commitCol, color: extraSlot.color })
        slots[extraCol] = null
      }
    } else {
      commitCol = findFreeColumn(slots)
      commitColor = pickLaneColor(slots, commitCol, colorCount, nextColor)
      slots[commitCol] = { expectedOid: commit.oid, color: commitColor }
    }

    // Active rails unrelated to this commit continue straight through the row.
    const passThrough: GraphLaneLine[] = []
    for (let col = 0; col < slots.length; col++) {
      const slot = slots[col]
      if (slot !== null && col !== commitCol) {
        passThrough.push({ col, color: slot.color })
      }
    }

    const uniqueParents: string[] = []
    for (const parent of commit.parents) {
      if (!uniqueParents.includes(parent)) uniqueParents.push(parent)
    }

    const outEdges: GraphEdge[] = []
    if (uniqueParents.length === 0) {
      // Root commit terminates its lane.
      slots[commitCol] = null
    } else {
      const firstParent = uniqueParents[0]!
      // Reuse an existing lane already expecting `firstParent` only if it lies to the left so the
      // primary trunk stays straight on the left rather than drifting rightward.
      let leftExistingCol = -1
      for (let col = 0; col < commitCol; col++) {
        if (slots[col]?.expectedOid === firstParent) {
          leftExistingCol = col
          break
        }
      }

      if (leftExistingCol >= 0) {
        slots[commitCol] = null
        outEdges.push({ fromCol: commitCol, toCol: leftExistingCol, color: commitColor })
      } else {
        slots[commitCol] = { expectedOid: firstParent, color: commitColor }
        outEdges.push({ fromCol: commitCol, toCol: commitCol, color: commitColor })
      }

      // Secondary parents (2-parent merges and octopus merges) fork out into their own lanes.
      for (let p = 1; p < uniqueParents.length; p++) {
        const parentOid = uniqueParents[p]!
        let existingCol = -1
        for (let col = 0; col < slots.length; col++) {
          if (col !== commitCol && slots[col]?.expectedOid === parentOid) {
            existingCol = col
            break
          }
        }
        if (existingCol >= 0) {
          outEdges.push({
            fromCol: commitCol,
            toCol: existingCol,
            color: slots[existingCol]!.color,
          })
        } else {
          const targetCol = findFreeColumn(slots, commitCol)
          const branchColor = pickLaneColor(slots, targetCol, colorCount, nextColor)
          slots[targetCol] = { expectedOid: parentOid, color: branchColor }
          outEdges.push({ fromCol: commitCol, toCol: targetCol, color: branchColor })
        }
      }
    }

    let maxCol = commitCol
    for (const rail of passThrough) {
      if (rail.col > maxCol) maxCol = rail.col
    }
    for (const edge of inEdges) {
      if (edge.fromCol > maxCol) maxCol = edge.fromCol
      if (edge.toCol > maxCol) maxCol = edge.toCol
    }
    for (const edge of outEdges) {
      if (edge.fromCol > maxCol) maxCol = edge.fromCol
      if (edge.toCol > maxCol) maxCol = edge.toCol
    }

    const laneCount = maxCol + 1
    if (laneCount > maxLanes) maxLanes = laneCount

    rows.push({
      oid: commit.oid,
      row,
      col: commitCol,
      color: commitColor,
      isMerge: commit.parents.length > 1,
      isRoot: commit.parents.length === 0,
      passThrough,
      inEdges,
      outEdges,
      laneCount,
    })

    trimTrailingNulls(slots)
  }

  const openLanes: GraphLaneLine[] = []
  for (let col = 0; col < slots.length; col++) {
    const slot = slots[col]
    if (slot !== null) openLanes.push({ col, color: slot.color })
  }

  return { rows, maxLanes, openLanes }
}
