import { describe, expect, it } from 'vitest'
import { RUNTIME_VERSION } from '../artifact-capabilities'
import { DOC_HEADINGS, parseDocReport } from './document-sheet'
import { parseSelectMessage } from './page-messages'

const message = (doc: unknown, extra: Record<string, unknown> = {}) => ({
  v: RUNTIME_VERSION,
  id: 'k1',
  kind: 'select',
  channel: 'channel-0001',
  selection: null,
  doc,
  ...extra,
})

const layout = {
  t: 'layout',
  version: 3,
  height: 2400,
  headings: [{ at: 0, level: 2, slug: 'summary', text: 'Summary', y: 56 }],
  places: [{ at: 120, y: 300, height: 48 }],
}

const box = { x: 40, y: 300, width: 680, height: 48 }

describe("a document viewer's report", () => {
  it('passes its layout, a pick, a selection and a save as they are', () => {
    expect(parseDocReport(layout)).toEqual(layout)
    const pick = { t: 'pick', at: 120, tag: 'p', text: 'Between Nov 3', box }
    expect(parseDocReport(pick)).toEqual(pick)
    const select = { t: 'select', at: 120, tag: 'p', text: 'Between', quote: 'Nov 3', box }
    expect(parseDocReport(select)).toEqual(select)
    expect(parseDocReport({ t: 'select', at: null })).toEqual({ t: 'select', at: null })
    const save = { t: 'save', state: 'saved', version: 4, undo: true }
    expect(parseDocReport(save)).toEqual(save)
  })

  it('carries a block that did not save as typed, and drops one that is not a block', () => {
    const save = { t: 'save', state: 'failed', version: null, undo: false }
    const kept = { at: 12, was: 'Old\n*words*', now: 'New\n*words*' }
    expect(parseDocReport({ ...save, kept })).toEqual({ ...save, kept })
    expect(parseDocReport({ ...save, kept: { ...kept, run: 'x' } })).toEqual({ ...save, kept })
    expect(parseDocReport({ ...save, kept: null })).toEqual({ ...save, kept: null })
    expect(parseDocReport({ ...save, kept: { ...kept, at: -1 } })).toEqual({ ...save, kept: null })
    expect(parseDocReport({ ...save, kept: { ...kept, now: 4 } })).toEqual({ ...save, kept: null })
    expect(parseDocReport({ ...save, kept: { ...kept, now: 'x'.repeat(8001) } })).toEqual({
      ...save,
      kept: null,
    })
  })

  it('makes what the page wrote one line of plain text, capped', () => {
    const select = parseDocReport({
      t: 'select',
      at: 0,
      tag: 'p',
      text: 'a\n\tb',
      quote: `${'x'.repeat(400)}\u0000`,
      box,
    })
    expect(select).toMatchObject({ text: 'a b' })
    expect(select?.t === 'select' && select.at !== null && select.quote.length).toBe(300)
  })

  it('refuses a report of any other shape', () => {
    expect(parseDocReport({ ...layout, version: 0 })).toBeNull()
    expect(parseDocReport({ ...layout, height: -1 })).toBeNull()
    expect(parseDocReport({ ...layout, headings: [{ ...layout.headings[0], slug: 'a b' }] })).toBe(
      null,
    )
    expect(parseDocReport({ ...layout, headings: [{ ...layout.headings[0], level: 7 }] })).toBe(
      null,
    )
    expect(
      parseDocReport({
        ...layout,
        headings: Array.from({ length: DOC_HEADINGS + 1 }, () => layout.headings[0]),
      }),
    ).toBeNull()
    expect(parseDocReport({ t: 'pick', at: -1, tag: 'p', text: '', box })).toBeNull()
    expect(parseDocReport({ t: 'pick', at: 0, tag: '<p>', text: '', box })).toBeNull()
    expect(parseDocReport({ t: 'pick', at: 0, tag: 'p', text: '', box: { x: 0 } })).toBeNull()
    expect(parseDocReport({ t: 'select', at: 0, tag: 'p', text: '', quote: ' ', box })).toBeNull()
    expect(parseDocReport({ t: 'save', state: 'done', version: 4, undo: false })).toBeNull()
    expect(parseDocReport({ t: 'save', state: 'saved', version: 1.5, undo: false })).toBeNull()
    expect(parseDocReport({ t: 'run', code: 'x' })).toBeNull()
    expect(parseDocReport('layout')).toBeNull()
  })

  it('comes in a select message alone, never with a pick, a located element or a key', () => {
    expect(parseSelectMessage(message(layout))?.doc).toEqual(layout)
    expect(parseSelectMessage(message({ t: 'nope' }))).toBeNull()
    expect(parseSelectMessage(message(layout, { key: 'Escape' }))).toBeNull()
    expect(parseSelectMessage(message(layout, { located: { src: 0, box: null } }))).toBeNull()
  })
})
