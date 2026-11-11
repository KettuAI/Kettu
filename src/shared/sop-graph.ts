// An SOP as a graph: which arrows lead back, what each node can still lead to, and where to
// draw each node. The engine and the drawing share it, so both agree on what "back" means.

import type { SopOutline } from './tasks'

export interface SopEdge {
  from: string
  outcome: string
  to: string
  /** It leads to the node itself or to one written before it. */
  back: boolean
}

export interface SopGraph {
  edges: SopEdge[]
  /** The nodes each node leads to along arrows forward, itself excluded. */
  reach: Record<string, readonly string[]>
  /** Where to draw each node: its column from the start, and its row in that column. */
  place: Record<string, { column: number; row: number }>
}

/**
 * The order the nodes are written in is the way forward: an arrow to a later node goes forward,
 * and one to the node itself or an earlier node goes back. So the arrows forward form no cycle,
 * whatever the SOP draws. Targets that name no node are ignored.
 */
export function sopGraph(outline: SopOutline): SopGraph {
  const index = new Map(outline.nodes.map((node, at) => [node.id, at]))
  const edges: SopEdge[] = []
  const forward = new Map<string, string[]>()
  for (const [at, node] of outline.nodes.entries()) {
    const out: string[] = []
    forward.set(node.id, out)
    for (const outcome of node.outcomes) {
      for (const to of outcome.to) {
        const target = index.get(to)
        if (target === undefined) continue
        const back = target <= at
        edges.push({ from: node.id, outcome: outcome.id, to, back })
        if (!back && !out.includes(to)) out.push(to)
      }
    }
  }

  const reach: Record<string, string[]> = {}
  for (const node of [...outline.nodes].reverse()) {
    const seen = new Set<string>()
    for (const to of forward.get(node.id) ?? []) {
      seen.add(to)
      for (const further of reach[to] ?? []) seen.add(further)
    }
    reach[node.id] = [...seen]
  }

  // The column is the longest way forward to the node.
  const column = new Map<string, number>()
  const rows = new Map<number, number>()
  const place: Record<string, { column: number; row: number }> = {}
  for (const node of outline.nodes) {
    const at = column.get(node.id) ?? 0
    for (const to of forward.get(node.id) ?? []) {
      column.set(to, Math.max(column.get(to) ?? 0, at + 1))
    }
    const row = rows.get(at) ?? 0
    rows.set(at, row + 1)
    place[node.id] = { column: at, row }
  }
  return { edges, reach, place }
}
