// Where the flowchart draws a workflow: the steps in rows from the top, forward arrows going down and
// steps that run side by side in one row, arrows back on lanes beside the rows. Laid out from the
// Workflow's own order, since no graph layout library is part of the app. `sideways` turns a layout
// to run from the left instead.

import { isBackArrow, type Workflow, type TaskEnd } from '@shared/workflow'

/** Sizes the layout works in, across the rows (`nodeW`, `colGap`) and down them (the rest). */
export interface FlowMetrics {
  nodeW: number
  nodeH: number
  endSize: number
  colGap: number
  rowGap: number
  /** From the rows to the first lane, and between lanes. */
  laneStart: number
  laneGap: number
  /** Beyond the outermost lane, room for the labels that start at their lanes. */
  labelRoom: number
  /** Between arrows back that leave or enter one side of a step. */
  slot: number
  /** From a step's top or bottom to the first arrow back at its side. */
  inset: number
  /** From a step's side to an arrow back that leaves or enters it at its top or bottom. */
  bend: number
  pad: number
}

export type Point = [number, number]

export interface NodeBox {
  id: string
  x: number
  y: number
  row: number
  /** How far it runs down the rows: `nodeH`, or its row's longest step's when steps size apart. */
  length: number
}

export interface EndBox {
  end: TaskEnd
  x: number
  y: number
}

export interface FlowEdge {
  id: string
  from: string
  /** The outcomes it stands for; empty for a review sent back by the person. */
  outcomes: string[]
  /** A step's id, or `end:done` / `end:dropped`. */
  to: string
  back: boolean
  points: Point[]
  /** Where its label sits: centred, or starting there and running away from the rows. */
  label: Point
  align: 'center' | 'start' | 'end'
  /** Several arrows end at this point, which a dot marks. */
  join: boolean
}

export interface FlowLayout {
  width: number
  height: number
  nodes: NodeBox[]
  ends: EndBox[]
  edges: FlowEdge[]
}

const endKey = (end: TaskEnd) => `end:${end}`

/** The row of each step: one below the lowest step an arrow forward comes from. */
function rowsOf(workflow: Workflow): Map<string, number> {
  const rows = new Map<string, number>()
  // Forward arrows only go to later steps, so one pass in order settles every row.
  workflow.steps.forEach((step, i) => {
    const from = workflow.steps
      .slice(0, i)
      .filter((s) =>
        s.outcomes.some((o) => !isBackArrow(workflow, s.id, o) && o.to.includes(step.id)),
      )
    const previous = i === 0 ? -1 : (rows.get(workflow.steps[i - 1]!.id) ?? 0)
    rows.set(
      step.id,
      from.length > 0 ? Math.max(...from.map((s) => rows.get(s.id)! + 1)) : previous + 1,
    )
  })
  return rows
}

/**
 * Lays out the workflow; every coordinate is in the chart's own box, from its top left. With
 * `lengthOf`, each row runs as far down as its longest step needs instead of `nodeH`.
 */
export function layoutFlow(
  workflow: Workflow,
  m: FlowMetrics,
  lengthOf?: (stepId: string) => number,
): FlowLayout {
  const { nodeW: NODE_W, nodeH: NODE_H, endSize: END_SIZE, colGap: COL_GAP, rowGap: ROW_GAP } = m
  const {
    laneStart: LANE_START,
    laneGap: LANE_GAP,
    labelRoom: LABEL_ROOM,
    slot: SLOT,
    pad: PAD,
  } = m
  const rows = rowsOf(workflow)
  const rowCount = Math.max(...rows.values()) + 1
  const byRow: string[][] = Array.from({ length: rowCount }, () => [])
  for (const step of workflow.steps) byRow[rows.get(step.id)!]!.push(step.id)
  const ends: TaskEnd[] = (['dropped', 'done'] as const).filter((end) =>
    workflow.steps.some((s) => s.outcomes.some((o) => o.end === end)),
  )
  const widest = Math.max(...byRow.map((ids) => ids.length), ends.length)
  const rowsWidth = widest * NODE_W + (widest - 1) * COL_GAP

  // Arrows back, the shortest nearest the rows, each on its own lane at its side.
  const backs = workflow.steps.flatMap((s) =>
    s.outcomes
      .filter((o) => isBackArrow(workflow, s.id, o))
      .flatMap((o) => o.to.map((to) => ({ from: s.id, outcome: o.name, to }))),
  )
  for (const step of workflow.steps) {
    if (step.youReview) backs.push({ from: step.id, outcome: '', to: step.id })
  }
  const leftmost = (id: string) => {
    const row = byRow[rows.get(id)!]!
    return row.length > 1 && row[0] === id
  }
  const rightmost = (id: string) => {
    const row = byRow[rows.get(id)!]!
    return row[row.length - 1] === id
  }
  const sideOf = (back: { to: string }) => (leftmost(back.to) ? 'left' : 'right')
  const span = (back: { from: string; to: string }) => rows.get(back.from)! - rows.get(back.to)!
  const lanes = { left: [] as typeof backs, right: [] as typeof backs }
  for (const back of [...backs].sort((a, b) => span(a) - span(b))) lanes[sideOf(back)].push(back)
  const room = (count: number) => (count ? LANE_START + (count - 1) * LANE_GAP + LABEL_ROOM : 0)
  const leftRoom = room(lanes.left.length)
  // Arrows that skip rows forward go down a lane at the left.
  const skipRoom = (LANE_START * 5) / 6

  const originX = PAD + Math.max(leftRoom, skipRoom)
  const rowLength = byRow.map((ids) =>
    lengthOf ? Math.max(...ids.map((id) => lengthOf(id))) : NODE_H,
  )
  const rowTops = rowLength.reduce(
    (tops, length, i) => [...tops, tops[i]! + length + ROW_GAP],
    [PAD],
  )
  const rowY = (row: number) => rowTops[row]!
  const centred = (count: number, i: number, width: number) =>
    originX + (rowsWidth - (count * width + (count - 1) * COL_GAP)) / 2 + i * (width + COL_GAP)
  const nodes: NodeBox[] = byRow.flatMap((ids, row) =>
    ids.map((id, i) => ({
      id,
      row,
      x: centred(ids.length, i, NODE_W),
      y: rowY(row),
      length: rowLength[row]!,
    })),
  )
  const endTop = rowY(rowCount)
  const endBoxes: EndBox[] = ends.map((end, i) => ({
    end,
    x: centred(ends.length, i, NODE_W) + NODE_W / 2,
    y: endTop + END_SIZE / 2,
  }))
  const box = new Map(nodes.map((n) => [n.id, n]))
  const right = originX + rowsWidth
  const laneX = (side: 'left' | 'right', i: number) =>
    side === 'right' ? right + LANE_START + i * LANE_GAP : originX - LANE_START - i * LANE_GAP

  const edges: FlowEdge[] = []
  const incoming = new Map<string, number>()
  const arrivals = new Map<FlowEdge, Point>()
  // Forward arrows: the outcomes of a step that lead to the same steps share one arrow, and each
  // arrow leaves the step's bottom at its own point. With one way on, its label sits under the
  // step; with several, by where each arrives, so they keep apart. An arrow that skips rows or ends
  // in a join keeps its label under the step too, since where it arrives it shares its run with
  // other arrows, whose labels would sit on the same spot.
  for (const step of workflow.steps) {
    const from = box.get(step.id)!
    const ways: { key: string; names: string[]; targets: string[]; end: TaskEnd | null }[] = []
    for (const outcome of step.outcomes.filter((o) => !isBackArrow(workflow, step.id, o))) {
      const targets = outcome.end ? [endKey(outcome.end)] : outcome.to
      const key = targets.join('|')
      const way = ways.find((w) => w.key === key)
      if (way) way.names.push(outcome.name)
      else ways.push({ key, names: [outcome.name], targets, end: outcome.end })
    }
    // Arrows that skip rows go down the left side, so they leave from the left and cross no other.
    const skipping = (way: (typeof ways)[number]) =>
      way.targets.some((to) => (box.get(to)?.row ?? rowCount) > from.row + 1)
    ways.sort((a, b) => Number(skipping(b)) - Number(skipping(a)))
    ways.forEach((way, j) => {
      const exitX = from.x + (NODE_W * (j + 1)) / (ways.length + 1)
      const bottom = from.y + from.length
      const bus = bottom + ROW_GAP / 2 + (j - (ways.length - 1) / 2) * 8
      for (const to of way.targets) {
        const endBox = way.end ? endBoxes.find((e) => e.end === way.end) : undefined
        const target = box.get(to)
        const tx = endBox ? endBox.x : target!.x + NODE_W / 2
        const ty = endBox ? endBox.y - END_SIZE / 2 : target!.y
        const targetRow = endBox ? rowCount : target!.row
        const skips = targetRow > from.row + 1
        let points: Point[]
        if (skips) {
          // Down the side, clear of the rows it passes.
          const lane = originX - LANE_START / 2 - j * 6
          const before = ty - ROW_GAP / 2
          points = [
            [exitX, bottom],
            [exitX, bus],
            [lane, bus],
            [lane, before],
            [tx, before],
            [tx, ty],
          ]
        } else {
          points = [
            [exitX, bottom],
            [exitX, bus],
            [tx, bus],
            [tx, ty],
          ]
        }
        incoming.set(to, (incoming.get(to) ?? 0) + 1)
        const edge: FlowEdge = {
          id: `${step.id}/${way.key}/${to}`,
          from: step.id,
          outcomes: way.names,
          to,
          back: false,
          points,
          label: [exitX, bottom + 14],
          align: 'center',
          join: false,
        }
        if (ways.length > 1 && !skips) arrivals.set(edge, [tx, ty - 14])
        edges.push(edge)
      }
    })
  }
  for (const edge of edges) {
    edge.join = (incoming.get(edge.to) ?? 0) > 1
    const arrival = arrivals.get(edge)
    if (arrival && !edge.join) edge.label = arrival
  }

  // Arrows back: out of the step's side, along its lane, into the target's side, each leaving and
  // entering at a height of its own; the label starts at the lane, by where it enters.
  for (const side of ['left', 'right'] as const) {
    const exits = new Map<string, number>()
    const entries = new Map<string, number>()
    lanes[side].forEach((back, i) => {
      const from = box.get(back.from)!
      const to = box.get(back.to)!
      const x = laneX(side, i)
      const dir = side === 'right' ? 1 : -1
      const open =
        side === 'right'
          ? rightmost
          : (id: string) => leftmost(id) || byRow[rows.get(id)!]!.length === 1
      const sideX = (n: NodeBox) => (side === 'right' ? n.x + NODE_W : n.x)
      const exit = exits.get(back.from) ?? 0
      const entry = entries.get(back.to) ?? 0
      exits.set(back.from, exit + 1)
      entries.set(back.to, entry + 1)
      const outY = from.y + from.length - m.inset - exit * SLOT
      const inY = to.y + m.inset + entry * SLOT
      const out: Point[] = open(back.from)
        ? [
            [sideX(from), outY],
            [x, outY],
          ]
        : [
            [sideX(from) - dir * (m.bend + exit * 12), from.y + from.length],
            [sideX(from) - dir * (m.bend + exit * 12), from.y + from.length + 12 + exit * 6],
            [x, from.y + from.length + 12 + exit * 6],
          ]
      const into: Point[] = open(back.to)
        ? [
            [x, inY],
            [sideX(to), inY],
          ]
        : [
            [x, to.y - 12 - entry * 6],
            [sideX(to) - dir * (m.bend + entry * 12), to.y - 12 - entry * 6],
            [sideX(to) - dir * (m.bend + entry * 12), to.y],
          ]
      edges.push({
        id: `${back.from}/${back.outcome}/${back.to}/back`,
        from: back.from,
        outcomes: back.outcome ? [back.outcome] : [],
        to: back.to,
        back: true,
        points: [...out, ...into],
        label: [x + dir * 6, into[0]![1] + 10],
        align: side === 'right' ? 'start' : 'end',
        join: false,
      })
    })
  }

  const rightRoom = room(lanes.right.length)
  return {
    width: right + rightRoom + PAD,
    height: (ends.length ? endTop + END_SIZE + 22 : rowY(rowCount) - ROW_GAP) + PAD,
    nodes,
    ends: endBoxes,
    edges,
  }
}

/** Straight runs with rounded bends, as the tree lines of a thread's work are drawn. */
export function pathOf(points: Point[], radius = 8): string {
  let d = `M${points[0]![0]} ${points[0]![1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]!
    const [x, y] = points[i]!
    const [nx, ny] = points[i + 1]!
    const k = Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2)
    d += `L${x - Math.sign(x - px) * k} ${y - Math.sign(y - py) * k}Q${x} ${y} ${x + Math.sign(nx - x) * k} ${y + Math.sign(ny - y) * k}`
  }
  const [lx, ly] = points[points.length - 1]!
  return `${d}L${lx} ${ly}`
}

/** The arrowhead at a path's end, pointing the way its last run goes. */
export function headOf(points: Point[]): string {
  const [x, y] = points[points.length - 1]!
  const [px, py] = points[points.length - 2]!
  const dx = Math.sign(x - px)
  const dy = Math.sign(y - py)
  return dx
    ? `M${x - 5 * dx} ${y - 3.5}L${x} ${y}L${x - 5 * dx} ${y + 3.5}`
    : `M${x - 3.5} ${y - 5 * dy}L${x} ${y}L${x + 3.5} ${y - 5 * dy}`
}

/** A layout turned to run from the left: rows become columns and the lanes run above and below. */
export function sideways(layout: FlowLayout): FlowLayout {
  const turn = ([x, y]: Point): Point => [y, x]
  return {
    width: layout.height,
    height: layout.width,
    nodes: layout.nodes.map((n) => ({ ...n, x: n.y, y: n.x })),
    ends: layout.ends.map((e) => ({ ...e, x: e.y, y: e.x })),
    edges: layout.edges.map((e) => ({ ...e, points: e.points.map(turn), label: turn(e.label) })),
  }
}

/** Where a lane's label sits: the middle of the arrow's longest run, along its lane. */
export function laneMiddle(points: Point[]): Point {
  let best: [Point, Point] = [points[0]!, points[1]!]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length > Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1])) best = [a, b]
  }
  return [(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2]
}

/** An arrow into a join stops short of its dot, which sits where the arrows meet. */
export function intoJoin(points: Point[]): { points: Point[]; dot: Point } {
  const last = points.at(-1)!
  const before = points.at(-2)!
  const dx = Math.sign(last[0] - before[0])
  const dy = Math.sign(last[1] - before[1])
  return {
    points: [...points.slice(0, -1), [last[0] - dx * 7, last[1] - dy * 7]],
    dot: [last[0] - dx * 4, last[1] - dy * 4],
  }
}
