import { describe, expect, it } from 'vitest'
import { RUNTIME_VERSION } from '../artifact-capabilities'
import { DECK_TRACKED, parseDeckReport } from './deck-sheet'
import { parseSelectMessage } from './page-messages'

const message = (deck: unknown, extra: Record<string, unknown> = {}) => ({
  v: RUNTIME_VERSION,
  id: 'k1',
  kind: 'select',
  channel: 'channel-0001',
  selection: null,
  deck,
  ...extra,
})

const box = { x: 88, y: 232, width: 500, height: 60 }
const layout = { t: 'layout', version: 6, slide: 3, places: [{ key: 't1', box }] }

describe("a slides viewer's report", () => {
  it('passes its layout, a pick and a save as they are', () => {
    expect(parseDeckReport(layout)).toEqual(layout)
    const pick = { t: 'pick', slide: 3, tag: 'li', text: 'Requests lead.', box }
    expect(parseDeckReport(pick)).toEqual(pick)
    const save = { t: 'save', state: 'saved', version: 7, undo: true }
    expect(parseDeckReport(save)).toEqual(save)
    expect(parseDeckReport({ ...save, state: 'editing', version: null })).toEqual({
      ...save,
      state: 'editing',
      version: null,
    })
  })

  it('makes what the page wrote one line of plain text, capped', () => {
    const pick = parseDeckReport({
      t: 'pick',
      slide: 1,
      tag: 'h2',
      text: `a\n\tb${'x'.repeat(400)}\u0000`,
      box,
    })
    expect(pick?.t === 'pick' && pick.text.startsWith('a b')).toBe(true)
    expect(pick?.t === 'pick' && pick.text.length).toBe(120)
  })

  it('refuses a report of any other shape', () => {
    expect(parseDeckReport({ ...layout, version: 0 })).toBeNull()
    expect(parseDeckReport({ ...layout, slide: 0 })).toBeNull()
    expect(parseDeckReport({ ...layout, slide: 1.5 })).toBeNull()
    expect(parseDeckReport({ ...layout, places: [{ key: 'a b', box }] })).toBeNull()
    expect(parseDeckReport({ ...layout, places: [{ key: 't1', box: { x: 1 } }] })).toBeNull()
    expect(
      parseDeckReport({
        ...layout,
        places: Array.from({ length: DECK_TRACKED + 1 }, () => layout.places[0]),
      }),
    ).toBeNull()
    expect(parseDeckReport({ t: 'pick', slide: 1, tag: '<li>', text: '', box })).toBeNull()
    expect(parseDeckReport({ t: 'pick', slide: 1, tag: 'li', text: 3, box })).toBeNull()
    expect(
      parseDeckReport({ t: 'pick', slide: 1, tag: 'li', text: '', box: { ...box, width: -1 } }),
    ).toBeNull()
    expect(parseDeckReport({ t: 'save', state: 'done', version: 4, undo: false })).toBeNull()
    expect(parseDeckReport({ t: 'save', state: 'saved', version: 0, undo: false })).toBeNull()
    expect(parseDeckReport({ t: 'html', html: '<b>' })).toBeNull()
    expect(parseDeckReport(null)).toBeNull()
  })

  it('carries the texts that did not save, leaving out what is not a text of a deck', () => {
    const save = { t: 'save', state: 'failed', version: null, undo: false }
    const title = { path: ['slides', 2, 'title'], text: 'Requests\nlead' }
    expect(parseDeckReport({ ...save, kept: [title] })).toEqual({ ...save, kept: [title] })
    expect(parseDeckReport({ ...save, kept: [] })).toEqual({ ...save, kept: [] })
    expect(
      parseDeckReport({
        ...save,
        kept: [
          title,
          { path: ['slides', '__proto__'], text: 'a' },
          { path: ['slides', 'a b'], text: 'a' },
          { path: [], text: 'a' },
          { path: ['slides', -1], text: 'a' },
          { path: ['slides', 0, 'notes'], text: 'x'.repeat(5001) },
          { path: ['slides', 0, 'title'], text: 4 },
          'title',
        ],
      }),
    ).toEqual({ ...save, kept: [title] })
    expect(parseDeckReport({ ...save, kept: 'all' })).toEqual({ ...save, kept: [] })
  })

  it('comes in a select message alone, never with a pick, a key or a document report', () => {
    expect(parseSelectMessage(message(layout))?.deck).toEqual(layout)
    expect(parseSelectMessage(message({ t: 'nope' }))).toBeNull()
    expect(parseSelectMessage(message(layout, { key: 'Escape' }))).toBeNull()
    expect(parseSelectMessage(message(layout, { located: { src: 0, box: null } }))).toBeNull()
    expect(
      parseSelectMessage(
        message(layout, { doc: { t: 'save', state: 'saved', version: 2, undo: false } }),
      ),
    ).toBeNull()
    expect(parseSelectMessage(message(layout, { pin: 2 }))).toBeNull()
    expect(parseSelectMessage(message(layout, { typed: { text: 'Hi', done: true } }))).toBeNull()
  })
})
