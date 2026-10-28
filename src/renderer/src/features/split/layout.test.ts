import { describe, expect, it } from 'vitest'
import {
  MAX_COLUMNS,
  MAX_PANES,
  MIN_COLUMN_WIDTH,
  MIN_PANE_HEIGHT,
  allPanes,
  canSplit,
  closePane,
  createLayout,
  createPane,
  dropPlace,
  dropView,
  focusPane,
  focusedPane,
  isSplit,
  newSessionView,
  openBeside,
  paneOrder,
  readLayout,
  saveLayout,
  showView,
  splitAt,
  visibleLayout,
  visibleSizes,
  type Box,
  type Layout,
  type PaneView,
} from './layout'

const session = (id: string, projectPath = '/repo'): PaneView => ({
  kind: 'session',
  sessionId: id,
  projectPath,
})
const newSession: PaneView = newSessionView()

const WIDE = { width: 1920, height: 1080 }

/** A column of one pane holding the sessions, in order. */
function single(...views: PaneView[]): Layout {
  const panes = views.map((view) => createPane(view))
  return { columns: [{ id: 'c1', panes, share: 1 }], focus: panes[0]!.id }
}

const boxes = (entries: Record<string, Box>) =>
  Object.entries(entries).map(([paneId, box]) => ({ paneId, ...box }))

const square = (paneId: string): Box & { paneId: string } => ({
  paneId,
  left: 0,
  top: 0,
  right: 900,
  bottom: 800,
})

describe('dropPlace', () => {
  it('names each part of a pane: a third across, a quarter down the middle third', () => {
    const layout = single(session('a'))
    const [box] = boxes({ [paneOrder(layout)[0]!]: square(paneOrder(layout)[0]!) })
    const place = (x: number, y: number) => dropPlace({ x, y }, [box!], layout, WIDE)
    expect(place(100, 400)?.side).toBe('left')
    expect(place(800, 400)?.side).toBe('right')
    // The top and bottom quarters count in the pane's middle third only.
    expect(place(450, 100)?.side).toBe('top')
    expect(place(450, 700)?.side).toBe('bottom')
    expect(place(450, 400)?.side).toBe('center')
    // A corner takes the side it is nearest across, not the middle third's quarter.
    expect(place(100, 100)?.side).toBe('left')
  })

  it('is null outside every pane', () => {
    const layout = single(session('a'))
    expect(dropPlace({ x: 2000, y: 100 }, [square(paneOrder(layout)[0]!)], layout, WIDE)).toBeNull()
  })

  it('counts a full or roomless side as the pane', () => {
    // Three columns take no new one.
    let wide = single(session('a'))
    wide = splitAt(wide, paneOrder(wide).at(-1)!, 'right', session('b'), WIDE)!
    wide = splitAt(wide, paneOrder(wide).at(-1)!, 'right', session('c'), WIDE)!
    expect(wide.columns).toHaveLength(MAX_COLUMNS)
    const [box] = boxes({ p1: square(paneOrder(wide)[0]!) })
    expect(dropPlace({ x: 100, y: 400 }, [box!], wide, WIDE)?.side).toBe('center')

    // Three panes in a column take no new one.
    let tall = single(session('a'))
    tall = splitAt(tall, paneOrder(tall)[0]!, 'bottom', session('b'), WIDE)!
    tall = splitAt(tall, paneOrder(tall)[0]!, 'bottom', session('c'), WIDE)!
    expect(tall.columns[0]!.panes).toHaveLength(MAX_PANES)
    const [tallBox] = boxes({ p1: square(paneOrder(tall)[0]!) })
    expect(dropPlace({ x: 450, y: 100 }, [tallBox!], tall, WIDE)?.side).toBe('center')

    // A narrow split takes no new column: the left third counts as the pane.
    const narrow = dropPlace({ x: 100, y: 400 }, [box!], single(session('a')), {
      width: 500,
      height: 900,
    })
    expect(narrow?.side).toBe('center')
  })
})

describe('splitting', () => {
  it('adds a column beside the pane with half its share, and there puts the focus', () => {
    const layout = single(session('a'))
    const pane = paneOrder(layout)[0]!
    const next = splitAt(layout, pane, 'right', session('b'), WIDE)!
    expect(next.columns).toHaveLength(2)
    expect(next.columns.map((c) => c.share)).toEqual([0.5, 0.5])
    expect(next.columns[1]!.panes[0]!.view).toEqual(session('b'))
    const added = next.columns[1]!.panes[0]!
    expect(focusedPane(next).id).toBe(added.id)
    // Above and below work the same way in a column.
    const below = splitAt(layout, pane, 'bottom', session('b'), WIDE)!
    expect(below.columns[0]!.panes).toHaveLength(2)
    expect(below.columns[0]!.panes.map((p) => p.share)).toEqual([0.5, 0.5])
  })

  it('takes no new column at three, and no new pane in a column of three', () => {
    let layout = single(session('a'))
    for (const id of ['b', 'c']) {
      layout = splitAt(layout, paneOrder(layout)[0]!, 'right', session(id), WIDE)!
    }
    expect(splitAt(layout, paneOrder(layout)[0]!, 'right', session('d'), WIDE)).toBeNull()
    let column = single(session('a'))
    for (const id of ['b', 'c']) {
      column = splitAt(column, paneOrder(column)[0]!, 'bottom', session(id), WIDE)!
    }
    expect(splitAt(column, paneOrder(column)[0]!, 'bottom', session('d'), WIDE)).toBeNull()
  })

  it('takes no new column or pane where the minimums leave no room', () => {
    const layout = single(session('a'))
    const pane = paneOrder(layout)[0]!
    // Two 360 px columns and their gap need 728 px.
    const tooNarrow = { width: 2 * MIN_COLUMN_WIDTH + 7, height: 1080 }
    expect(canSplit(layout, pane, 'right', tooNarrow)).toEqual({ ok: false, reason: 'room' })
    expect(
      canSplit(layout, pane, 'right', { ...tooNarrow, width: 2 * MIN_COLUMN_WIDTH + 8 }),
    ).toEqual({ ok: true, reason: null })
    const tooShort = { width: 1920, height: 2 * MIN_PANE_HEIGHT + 7 }
    expect(canSplit(layout, pane, 'bottom', tooShort)).toEqual({ ok: false, reason: 'room' })
  })
})

describe('moving a session in the split', () => {
  it('leaves its pane first, so the limits count without it', () => {
    let layout: Layout = {
      columns: [
        { id: 'c1', panes: [createPane(session('a'))], share: 0.5 },
        { id: 'c2', panes: [createPane(session('b'))], share: 0.5 },
      ],
      focus: '',
    }
    layout = focusPane(layout, layout.columns[0]!.panes[0]!.id)
    const target = layout.columns[1]!.panes[0]!
    // The moved pane's column had one pane; it closes, leaving one column of two.
    const next = dropView(layout, session('a'), { paneId: target.id, side: 'bottom' }, WIDE)!
    expect(next.columns).toHaveLength(1)
    expect(next.columns[0]!.panes.map((p) => p.view)).toEqual([session('b'), session('a')])
    expect(allPanes(next)).toHaveLength(2)
    // It shows in one pane at most.
    expect(
      allPanes(next).filter((p) => p.view.kind === 'session' && p.view.sessionId === 'a'),
    ).toHaveLength(1)
  })

  it('trades places with the pane it is dropped on', () => {
    const layout: Layout = {
      columns: [
        { id: 'c1', panes: [createPane(session('a'))], share: 0.5 },
        { id: 'c2', panes: [createPane(session('b'))], share: 0.5 },
      ],
      focus: '',
    }
    const [first, second] = layout.columns.map((c) => c.panes[0]!)
    const next = dropView(layout, session('b'), { paneId: first!.id, side: 'center' }, WIDE)!
    expect(next.columns[0]!.panes[0]!.view).toEqual(session('b'))
    expect(next.columns[1]!.panes[0]!.view).toEqual(session('a'))
    expect(focusedPane(next).id).toBe(first!.id)
    expect(second!.id).toBe(next.columns[1]!.panes[0]!.id)
  })

  it('changes nothing when a pane is dropped over itself', () => {
    const layout = single(session('a'))
    const pane = paneOrder(layout)[0]!
    expect(dropView(layout, session('a'), { paneId: pane, side: 'center' }, WIDE)).toBeNull()
    expect(dropView(layout, session('a'), { paneId: pane, side: 'right' }, WIDE)).toBeNull()
  })

  it('puts a session from outside the split in the pane it is dropped on', () => {
    const layout = single(session('a'))
    const pane = paneOrder(layout)[0]!
    const next = dropView(layout, session('z'), { paneId: pane, side: 'center' }, WIDE)!
    expect(next.columns[0]!.panes[0]!.view).toEqual(session('z'))
  })
})

describe('closing', () => {
  it('shares a closed pane’s room out and focuses the one before it', () => {
    let layout = single(session('a'))
    layout = splitAt(layout, paneOrder(layout).at(-1)!, 'right', session('b'), WIDE)!
    layout = splitAt(layout, paneOrder(layout).at(-1)!, 'right', session('c'), WIDE)!
    const [a, b, c] = paneOrder(layout)
    expect(layout.columns.map((column) => column.share)).toEqual([0.5, 0.25, 0.25])
    const next = closePane(focusPane(layout, b!), b!)
    expect(next.columns).toHaveLength(2)
    // The remaining two take the room in proportion to what they had.
    const shares = next.columns.map((column) => column.share)
    expect(shares[0]! + shares[1]!).toBeCloseTo(1)
    expect(shares[0]! / shares[1]!).toBeCloseTo(2)
    expect(next.focus).toBe(a)
    expect(c).toBeTruthy()
  })

  it('focuses the pane after it when it was the first', () => {
    let layout = single(session('a'))
    layout = splitAt(layout, paneOrder(layout)[0]!, 'bottom', session('b'), WIDE)!
    const [a, b] = paneOrder(layout)
    expect(closePane(layout, a!).focus).toBe(b)
  })

  it('closes the column a pane leaves empty', () => {
    let layout = single(session('a'))
    layout = splitAt(layout, paneOrder(layout)[0]!, 'right', session('b'), WIDE)!
    const closed = closePane(layout, paneOrder(layout)[1]!)
    expect(closed.columns).toHaveLength(1)
    expect(closed.columns[0]!.share).toBe(1)
    expect(isSplit(closed)).toBe(false)
  })

  it('leaves the only pane as it is', () => {
    const layout = single(session('a'))
    expect(closePane(layout, paneOrder(layout)[0]!)).toBe(layout)
  })
})

describe('folding to the room', () => {
  const threeColumns = (): Layout => {
    let layout = single(session('a'))
    // Each new column goes right of the last, so the order is a, b, c.
    layout = splitAt(layout, paneOrder(layout).at(-1)!, 'right', session('b'), WIDE)!
    layout = splitAt(layout, paneOrder(layout).at(-1)!, 'right', session('c'), WIDE)!
    return layout
  }

  it('shows the columns that fit, keeping the run shown while the focus stays in it', () => {
    const layout = focusPane(threeColumns(), '')
    const [a, b, c] = paneOrder(layout)
    const fromFirst = focusPane(layout, a!)
    const roomForOne = { width: MIN_COLUMN_WIDTH, height: 1080 }
    const roomForTwo = { width: 2 * MIN_COLUMN_WIDTH + 8, height: 1080 }
    const first = visibleLayout(fromFirst, roomForOne)
    expect(first.panes).toEqual([a])
    // The focus stays in the run shown, so it does not move.
    expect(
      visibleLayout(fromFirst, roomForTwo, {
        columns: first.columns.map((column) => column.id),
        panes: {},
      }).panes,
    ).toEqual([a, b])
    // With the focus on the last column, the run shifts as little as it can.
    const focused = focusPane(layout, c!)
    const shown = visibleLayout(focused, roomForTwo)
    expect(shown.panes).toEqual([b, c])
  })

  it('shifts the run as little as it can when the focus leaves it', () => {
    const layout = threeColumns()
    const [, b, c] = paneOrder(layout)
    const roomForTwo = { width: 2 * MIN_COLUMN_WIDTH + 8, height: 1080 }
    const before = { columns: [layout.columns[0]!.id, layout.columns[1]!.id], panes: {} }
    // The focus moves to the far column, which needs the run to move by one.
    const focused = focusPane(layout, c!)
    const shown = visibleLayout(focused, roomForTwo, before)
    expect(shown.panes).toEqual([b, c])
  })

  it('folds the panes a column cannot hold around the pane in focus', () => {
    let layout = single(session('a'))
    layout = splitAt(layout, paneOrder(layout)[0]!, 'bottom', session('b'), WIDE)!
    layout = splitAt(layout, paneOrder(layout)[1]!, 'bottom', session('c'), WIDE)!
    const [a, b, c] = paneOrder(layout)
    const onePane = { width: 1080, height: MIN_PANE_HEIGHT }
    // The focus is on the last pane, so the run ends with it.
    const focused = focusPane(layout, c!)
    expect(visibleLayout(focused, onePane).panes).toEqual([c])
    expect(visibleLayout(focusPane(layout, a!), onePane).panes).toEqual([a])
    expect(b).toBeTruthy()
  })

  it('gives folded columns their places and shares back with the room', () => {
    const layout = threeColumns()
    const folded = visibleLayout(layout, { width: MIN_COLUMN_WIDTH, height: 1080 })
    expect(folded.columns).toHaveLength(1)
    const sizes = visibleSizes(layout, folded)
    expect(sizes.columns[folded.columns[0]!.id]).toBeCloseTo(100)
    // With the room back, every column shows its own share of the split.
    const all = visibleLayout(layout, WIDE)
    expect(all.columns).toHaveLength(3)
    const full = visibleSizes(layout, all)
    expect(Object.values(full.columns).reduce((a, b) => a + b, 0)).toBeCloseTo(100)
  })
})

describe('the panes Mod+1 to Mod+9 pick', () => {
  it('counts column by column and top to bottom', () => {
    let layout: Layout = {
      columns: [
        { id: 'c1', panes: [createPane(session('a')), createPane(session('b'))], share: 0.5 },
        { id: 'c2', panes: [createPane(session('c'))], share: 0.5 },
      ],
      focus: '',
    }
    layout = focusPane(layout, layout.columns[0]!.panes[0]!.id)
    expect(paneOrder(layout).map((id) => allPanes(layout).find((p) => p.id === id)?.view)).toEqual([
      session('a'),
      session('b'),
      session('c'),
    ])
  })
})

describe('saving and reading back', () => {
  it('keeps the panes, their sizes and the pane in focus', () => {
    let layout = single(session('a'))
    layout = splitAt(layout, paneOrder(layout)[0]!, 'right', session('b'), WIDE)!
    const saved = saveLayout(layout)
    const back = readLayout(JSON.parse(JSON.stringify(saved)))!
    expect(back.columns).toHaveLength(2)
    expect(allPanes(back).map((pane) => pane.view)).toEqual([session('a'), session('b')])
    expect(back.focus).toBe(layout.focus)
  })

  it('saves a New session pane as New session with its defaults', () => {
    const layout = single({
      kind: 'new',
      agentId: 'codex',
      projectPath: '/repo',
      noProject: true,
      parentId: 'p1',
    })
    expect(saveLayout(layout).columns[0]!.panes[0]!.view).toEqual(newSession)
  })

  it('reads nothing from a save that is not a layout', () => {
    expect(readLayout(null)).toBeNull()
    expect(readLayout({})).toBeNull()
    expect(readLayout({ columns: [] })).toBeNull()
    expect(readLayout({ columns: [{ id: 'c', share: 1, panes: [] }] })).toBeNull()
  })

  it('opens one pane from a save made before the split view', () => {
    const layout = createLayout(session('a'))
    expect(showView(layout, session('a')).columns[0]!.panes[0]!.id).toBe(layout.focus)
  })
})

describe('showing views', () => {
  it('focuses the pane that already holds a session, else replaces the focused view', () => {
    let layout = single(session('a'))
    layout = splitAt(layout, paneOrder(layout)[0]!, 'right', session('b'), WIDE)!
    const [a] = paneOrder(layout)
    const next = showView(layout, session('a'))
    expect(next.focus).toBe(a)
    const replaced = showView(layout, session('z'))
    expect(allPanes(replaced)).toHaveLength(2)
    expect(focusedPane(replaced).view).toEqual(session('z'))
  })

  it('shows New session in one pane at most', () => {
    let layout = single(session('a'))
    layout = splitAt(layout, paneOrder(layout)[0]!, 'right', session('b'), WIDE)!
    layout = showView(layout, newSession)
    const noting = allPanes(layout).filter((pane) => pane.view.kind === 'new')
    expect(noting).toHaveLength(1)
    const again = showView(layout, { ...newSession, agentId: 'codex' } as PaneView)
    expect(allPanes(again).filter((pane) => pane.view.kind === 'new')).toHaveLength(1)
    expect(focusedPane(again).view).toEqual({ ...newSession, agentId: 'codex' })
  })

  it('puts a session beside or below the pane in focus', () => {
    const layout = single(session('a'))
    expect(openBeside(layout, session('b'), 'right', WIDE)!.columns).toHaveLength(2)
    expect(openBeside(layout, session('b'), 'bottom', WIDE)!.columns[0]!.panes).toHaveLength(2)
  })
})
