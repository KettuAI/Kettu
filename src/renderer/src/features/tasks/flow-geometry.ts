// Where an SOP's flowchart draws its nodes, end marks and arrows, from the graph's columns and
// rows. Arrows forward are curves from a node's right side to its target's left side, which may
// pass over a node when they skip a column; arrows back run under the chart on lanes of their own
// and come up into the target, clear of every node.

import type { SopGraph } from '@shared/sop-graph'
import type { SopOutline } from '@shared/tasks'

export const NODE_WIDTH = 184
export const NODE_HEIGHT = 88
export const END_WIDTH = 96
export const END_HEIGHT = 26
const COLUMN_GAP = 104
const ROW_GAP = 28
const END_GAP = 10
const PADDING = 16
const LANE_GAP = 24
const CORNER = 8
const MIN_PULL = 24
// How far beside a node an arrow back runs when a node under it is in the way.
const SIDE = 12

export interface FlowBox {
  id: string
  x: number
  y: number
}

/** Where a task ends: one mark for each outcome that ends it, a column after its node. */
export interface FlowEnd {
  from: string
  outcome: string
  end: 'done' | 'dropped'
  x: number
  y: number
}

export interface FlowArrow {
  from: string
  outcome: string
  /** The node it leads to, null for an arrow to an end mark. */
  to: string | null
  back: boolean
  path: string
  /** The arrowhead's point, and the way it points in degrees clockwise from rightwards. */
  tip: { x: number; y: number; angle: number }
  /** The middle of the arrow, where the outcome's name goes. */
  label: { x: number; y: number }
}

export interface FlowLayout {
  width: number
  height: number
  boxes: FlowBox[]
  ends: FlowEnd[]
  arrows: FlowArrow[]
}

function columnX(column: number): number {
  return PADDING + column * (NODE_WIDTH + COLUMN_GAP)
}

function forwardPath(x1: number, y1: number, x2: number, y2: number): string {
  const pull = Math.max(MIN_PULL, (x2 - x1) / 2)
  return `M${x1} ${y1} C${x1 + pull} ${y1} ${x2 - pull} ${y2} ${x2} ${y2}`
}

type Point = [number, number]

/** A line through the points, each a right-angle turn from the last, with rounded corners. */
function cornered(points: readonly Point[]): string {
  let path = `M${points[0]![0]} ${points[0]![1]}`
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i]!
    const next = points[i + 1]
    if (!next) {
      path += ` L${x} ${y}`
      break
    }
    const [px, py] = points[i - 1]!
    const cut = (from: Point, toward: Point): Point => {
      const length = Math.abs(toward[0] - from[0]) + Math.abs(toward[1] - from[1])
      const by = Math.min(CORNER, length / 2) / (length || 1)
      return [from[0] + (toward[0] - from[0]) * by, from[1] + (toward[1] - from[1]) * by]
    }
    const [ax, ay] = cut([x, y], [px, py])
    const [bx, by] = cut([x, y], next)
    path += ` L${ax} ${ay} Q${x} ${y} ${bx} ${by}`
  }
  return path
}

export function flowLayout(outline: SopOutline, graph: SopGraph): FlowLayout {
  const columns = new Map<number, string[]>()
  for (const node of outline.nodes) {
    const at = graph.place[node.id]
    if (!at) continue
    const column = columns.get(at.column) ?? []
    column[at.row] = node.id
    columns.set(at.column, column)
  }
  const height = (rows: number) => rows * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP
  const band = height(Math.max(1, ...[...columns.values()].map((column) => column.length)))
  const columnTop = (column: number) => (band - height(columns.get(column)?.length ?? 0)) / 2

  const boxes = new Map<string, FlowBox>()
  for (const [column, ids] of columns) {
    ids.forEach((id, row) => {
      boxes.set(id, {
        id,
        x: columnX(column),
        y: columnTop(column) + row * (NODE_HEIGHT + ROW_GAP),
      })
    })
  }

  // End marks stack above the nodes of the next column, or sit mid-height in an empty one, so
  // the space under the chart stays free for the arrows back.
  const ends: FlowEnd[] = []
  const stacked = new Map<number, number>()
  for (const node of outline.nodes) {
    const at = graph.place[node.id]
    if (!at) continue
    for (const outcome of node.outcomes) {
      if (!outcome.end || outcome.to.length > 0) continue
      const column = at.column + 1
      const nth = stacked.get(column) ?? 0
      stacked.set(column, nth + 1)
      const step = END_HEIGHT + END_GAP
      const y = columns.has(column)
        ? columnTop(column) - (nth + 1) * step
        : (band - END_HEIGHT) / 2 + nth * step
      ends.push({ from: node.id, outcome: outcome.id, end: outcome.end, x: columnX(column), y })
    }
  }

  const top = Math.min(0, ...ends.map((end) => end.y))
  const shift = PADDING - top
  for (const box of boxes.values()) box.y += shift
  for (const end of ends) end.y += shift
  const bottom = Math.max(
    shift + band,
    ...ends.map((end) => end.y + END_HEIGHT),
    ...[...boxes.values()].map((box) => box.y + NODE_HEIGHT),
  )

  const arrows: FlowArrow[] = []
  for (const end of ends) {
    const from = boxes.get(end.from)
    if (!from) continue
    const x1 = from.x + NODE_WIDTH
    const y1 = from.y + NODE_HEIGHT / 2
    const y2 = end.y + END_HEIGHT / 2
    arrows.push({
      from: end.from,
      outcome: end.outcome,
      to: null,
      back: false,
      path: forwardPath(x1, y1, end.x, y2),
      tip: { x: end.x, y: y2, angle: 0 },
      label: { x: (x1 + end.x) / 2, y: (y1 + y2) / 2 },
    })
  }

  // An arrow back leaves and arrives at a node's bottom, on its left and right halves so the
  // two never share a line. With a node under it in its column, it goes by the node's side.
  const below = (box: FlowBox) =>
    [...boxes.values()].some((other) => other.x === box.x && other.y > box.y)
  const backs: { from: string; to: string; outcome: string; out: Point[]; in: Point[] }[] = []
  for (const edge of graph.edges) {
    const from = boxes.get(edge.from)
    const to = boxes.get(edge.to)
    if (!from || !to) continue
    if (edge.back) {
      const low = (NODE_HEIGHT * 3) / 4
      const sx = from.x + NODE_WIDTH / 4
      const tx = to.x + (NODE_WIDTH * 3) / 4
      backs.push({
        from: edge.from,
        to: edge.to,
        outcome: edge.outcome,
        out: below(from)
          ? [
              [from.x + NODE_WIDTH, from.y + low],
              [from.x + NODE_WIDTH + SIDE, from.y + low],
            ]
          : [[sx, from.y + NODE_HEIGHT]],
        in: below(to)
          ? [
              [to.x - SIDE, to.y + low],
              [to.x, to.y + low],
            ]
          : [[tx, to.y + NODE_HEIGHT]],
      })
      continue
    }
    const x1 = from.x + NODE_WIDTH
    const y1 = from.y + NODE_HEIGHT / 2
    const y2 = to.y + NODE_HEIGHT / 2
    arrows.push({
      from: edge.from,
      outcome: edge.outcome,
      to: edge.to,
      back: false,
      path: forwardPath(x1, y1, to.x, y2),
      tip: { x: to.x, y: y2, angle: 0 },
      label: { x: (x1 + to.x) / 2, y: (y1 + y2) / 2 },
    })
  }

  // The shortest arrows back take the nearest lanes; two share a lane when they do not overlap.
  const lanes: [number, number][][] = []
  const span = (back: { out: Point[]; in: Point[] }): [number, number] => {
    const a = back.out.at(-1)![0]
    const b = back.in[0]![0]
    return [Math.min(a, b), Math.max(a, b)]
  }
  backs.sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]))
  for (const back of backs) {
    const [left, right] = span(back)
    let depth = lanes.findIndex((lane) => lane.every(([l, r]) => right < l || left > r))
    if (depth < 0) depth = lanes.push([]) - 1
    lanes[depth]!.push([left, right])
    const lane = bottom + (depth + 1) * LANE_GAP
    const tip = back.in.at(-1)!
    arrows.push({
      from: back.from,
      outcome: back.outcome,
      to: back.to,
      back: true,
      path: cornered([
        ...back.out,
        [back.out.at(-1)![0], lane],
        [back.in[0]![0], lane],
        ...back.in,
      ]),
      tip: { x: tip[0], y: tip[1], angle: back.in.length > 1 ? 0 : -90 },
      label: { x: (left + right) / 2, y: lane },
    })
  }

  const right = Math.max(
    ...[...boxes.values()].map((box) => box.x + NODE_WIDTH),
    ...ends.map((end) => end.x + END_WIDTH),
    0,
  )
  return {
    width: right + PADDING,
    height: bottom + lanes.length * LANE_GAP + PADDING,
    boxes: [...boxes.values()],
    ends,
    arrows,
  }
}
