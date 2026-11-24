import { describe, expect, it } from 'vitest'
import { PLUGIN_VIEW_LIMITS, type PluginViewKind } from '@shared/plugin-views'
import {
  parseActionResult,
  parseFormValues,
  parseParams,
  parseViewContent,
  ViewDataError,
} from './view-data'

const check = { views: new Set(['issues', 'issue']) }
const view = (kind: PluginViewKind, value: unknown) => parseViewContent(kind, value, check)
const refuses = (kind: PluginViewKind, value: unknown, path: string) =>
  expect(() => view(kind, value)).toThrowError(
    expect.objectContaining({ name: 'ViewDataError', message: expect.stringContaining(path) }),
  )

describe('a list', () => {
  it('keeps what the format has and drops the rest', () => {
    expect(
      view('list', {
        scope: ['kettu', 'Last 24 hours'],
        rows: [
          {
            id: 'a',
            title: 'TypeError',
            subtitle: 'remote/sync.ts',
            mono: true,
            icon: 'bug',
            badges: [
              { text: 'New', tone: 'danger' },
              { text: 'Old', tone: 'purple' },
            ],
            end: '312',
            secret: 'dropped',
            actions: [
              { id: 'open', label: 'Open', open: { view: 'issue', params: { id: 'a' } } },
              { id: 'close', label: 'Close', destructive: true, confirm: 'Close it?' },
            ],
          },
        ],
        actions: [{ id: 'fix', label: 'Fix', primary: true }],
        unknown: 1,
      }),
    ).toEqual({
      kind: 'list',
      scope: ['kettu', 'Last 24 hours'],
      rows: [
        {
          id: 'a',
          title: 'TypeError',
          subtitle: 'remote/sync.ts',
          mono: true,
          icon: 'bug',
          // A tone it does not know draws as neutral.
          badges: [{ text: 'New', tone: 'danger' }, { text: 'Old' }],
          end: '312',
          actions: [
            { id: 'open', label: 'Open', open: { view: 'issue', params: { id: 'a' } } },
            { id: 'close', label: 'Close', destructive: true, confirm: 'Close it?' },
          ],
        },
      ],
      actions: [{ id: 'fix', label: 'Fix', primary: true }],
    })
  })

  it('cuts a text at its limit and leaves out an icon it does not have', () => {
    const [row] = (
      view('list', {
        rows: [{ id: 'a', title: 'x'.repeat(500), icon: 'unicorn' }],
      }) as { rows: { title: string; icon?: string }[] }
    ).rows
    expect(row!.title).toHaveLength(PLUGIN_VIEW_LIMITS.title)
    expect(row).not.toHaveProperty('icon')
  })

  it('drops the rows past the limit and says so', () => {
    const rows = Array.from({ length: PLUGIN_VIEW_LIMITS.rows + 5 }, (_, i) => ({
      id: `r${i}`,
      title: 'Row',
    }))
    const shown = view('list', { rows }) as { rows: unknown[]; truncated?: boolean }
    expect(shown.rows).toHaveLength(PLUGIN_VIEW_LIMITS.rows)
    expect(shown.truncated).toBe(true)
    expect(view('list', { rows: [] })).not.toHaveProperty('truncated')
  })

  it.each([
    ['an answer that is not an object', 'rows', 'The answer'],
    ['no rows', {}, 'rows'],
    ['a row without a title', { rows: [{ id: 'a' }] }, 'rows[0].title'],
    ['a row whose id is a number', { rows: [{ id: 1, title: 'A' }] }, 'rows[0].id'],
    [
      'two rows with one id',
      {
        rows: [
          { id: 'a', title: 'A' },
          { id: 'a', title: 'B' },
        ],
      },
      'rows[1].id',
    ],
    ['badges that are not a list', { rows: [{ id: 'a', title: 'A', badges: 'new' }] }, 'badges'],
    [
      'more badges than fit',
      {
        rows: [
          {
            id: 'a',
            title: 'A',
            badges: Array.from({ length: PLUGIN_VIEW_LIMITS.badges + 1 }, () => ({ text: 'b' })),
          },
        ],
      },
      'rows[0].badges',
    ],
    [
      'more actions on a row than fit',
      {
        rows: [
          {
            id: 'a',
            title: 'A',
            actions: Array.from({ length: PLUGIN_VIEW_LIMITS.rowActions + 1 }, (_, i) => ({
              id: `x${i}`,
              label: 'X',
            })),
          },
        ],
      },
      'rows[0].actions',
    ],
    [
      'an action whose id is not an id',
      { rows: [], actions: [{ id: 'a b', label: 'A' }] },
      'actions[0].id',
    ],
    [
      'two actions with one id',
      {
        rows: [],
        actions: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
      },
      'actions[1].id',
    ],
    [
      'two primary actions',
      {
        rows: [],
        actions: [
          { id: 'a', label: 'A', primary: true },
          { id: 'b', label: 'B', primary: true },
        ],
      },
      'actions',
    ],
    [
      'an action that opens a view the plugin does not have',
      { rows: [], actions: [{ id: 'a', label: 'A', open: { view: 'other' } }] },
      'actions[0].open.view',
    ],
    [
      'a flag that is not a boolean',
      { rows: [], actions: [{ id: 'a', label: 'A', destructive: 'yes' }] },
      'actions[0].destructive',
    ],
  ])('refuses %s', (_, value, path) => refuses('list', value, path))
})

describe('a detail', () => {
  it('keeps fields and a Markdown body, cut at their limits', () => {
    const shown = view('detail', {
      title: 'Issue',
      icon: 'bug',
      fields: [{ label: 'State', value: 'open', mono: true }, { label: 'Owner' }],
      body: 'x'.repeat(PLUGIN_VIEW_LIMITS.body + 1),
    }) as { fields: unknown[]; body: string }
    expect(shown.fields).toEqual([
      { label: 'State', value: 'open', mono: true },
      { label: 'Owner', value: '' },
    ])
    expect(shown.body).toHaveLength(PLUGIN_VIEW_LIMITS.body)
  })

  it.each([
    ['a title that is not text', { title: 1 }, 'title'],
    ['fields that are not a list', { fields: {} }, 'fields'],
    ['a field without a label', { fields: [{ value: 'x' }] }, 'fields[0].label'],
    [
      'more fields than fit',
      { fields: Array.from({ length: PLUGIN_VIEW_LIMITS.fields + 1 }, () => ({ label: 'L' })) },
      'fields',
    ],
  ])('refuses %s', (_, value, path) => refuses('detail', value, path))
})

describe('a form', () => {
  const submit = { id: 'save', label: 'Save', primary: true }

  it('fills in the values a field has no value for', () => {
    expect(
      view('form', {
        fields: [
          { type: 'switch', key: 'on', label: 'On' },
          {
            type: 'choice',
            key: 'team',
            label: 'Team',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          },
          { type: 'text', key: 'note', label: 'Note', maxLength: 10, value: 'x'.repeat(20) },
        ],
        submit,
      }),
    ).toEqual({
      kind: 'form',
      fields: [
        { type: 'switch', key: 'on', label: 'On', value: false },
        {
          type: 'choice',
          key: 'team',
          label: 'Team',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
          value: 'a',
        },
        { type: 'text', key: 'note', label: 'Note', value: 'x'.repeat(10), maxLength: 10 },
      ],
      submit,
    })
  })

  it.each([
    ['no fields', { fields: [], submit }, 'fields'],
    ['no submit', { fields: [{ type: 'switch', key: 'a', label: 'A' }] }, 'submit'],
    [
      'a submit that opens a view',
      {
        fields: [{ type: 'switch', key: 'a', label: 'A' }],
        submit: { id: 's', label: 'S', open: { view: 'issue' } },
      },
      'submit',
    ],
    [
      'a field of a type it does not have',
      { fields: [{ type: 'slider', key: 'a', label: 'A' }], submit },
      'fields[0].type',
    ],
    [
      'two fields with one key',
      {
        fields: [
          { type: 'switch', key: 'a', label: 'A' },
          { type: 'switch', key: 'a', label: 'B' },
        ],
        submit,
      },
      'fields[1].key',
    ],
    [
      'a key that is not a name',
      { fields: [{ type: 'switch', key: 'A-b', label: 'A' }], submit },
      'fields[0].key',
    ],
    [
      'a choice without options',
      { fields: [{ type: 'choice', key: 'a', label: 'A', options: [] }], submit },
      'fields[0].options',
    ],
    [
      'a choice whose value is not an option',
      {
        fields: [
          {
            type: 'choice',
            key: 'a',
            label: 'A',
            options: [{ value: 'x', label: 'X' }],
            value: 'y',
          },
        ],
        submit,
      },
      'fields[0].value',
    ],
    [
      'a text length that is not a number',
      { fields: [{ type: 'text', key: 'a', label: 'A', maxLength: '5' }], submit },
      'fields[0].maxLength',
    ],
    [
      'a switch whose value is text',
      { fields: [{ type: 'switch', key: 'a', label: 'A', value: 'on' }], submit },
      'fields[0].value',
    ],
  ])('refuses %s', (_, value, path) => refuses('form', value, path))
})

describe('actions', () => {
  it('needs at least one action', () => {
    refuses('actions', { text: 'Hi' }, 'actions')
    refuses('actions', { actions: [] }, 'actions')
    expect(view('actions', { text: 'Hi', actions: [{ id: 'a', label: 'A' }] })).toEqual({
      kind: 'actions',
      text: 'Hi',
      actions: [{ id: 'a', label: 'A' }],
    })
  })
})

describe('what an action answers', () => {
  it('is fine when it answers nothing, and carries a notice or a view to open', () => {
    expect(parseActionResult(undefined, check)).toEqual({ ok: true })
    expect(parseActionResult(null, check)).toEqual({ ok: true })
    expect(parseActionResult({ notice: 'Done' }, check)).toEqual({ ok: true, notice: 'Done' })
    expect(parseActionResult({ open: { view: 'issue', params: { id: '3' } } }, check)).toEqual({
      ok: true,
      open: { view: 'issue', params: { id: '3' } },
    })
  })

  it('refuses the action when the script says so, in its own words', () => {
    expect(parseActionResult({ error: 'The API key is not set', notice: 'x' }, check)).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'The API key is not set' },
    })
  })

  it('refuses a view that is not the plugin’s and an answer that is not an object', () => {
    expect(() => parseActionResult({ open: { view: 'other' } }, check)).toThrowError(ViewDataError)
    expect(() => parseActionResult('done', check)).toThrowError(ViewDataError)
  })
})

describe('the parameters and values a window sends', () => {
  it('keeps text parameters under their limits', () => {
    expect(parseParams(undefined, 'params')).toEqual({})
    expect(parseParams({ id: 'x'.repeat(300) }, 'params').id).toHaveLength(
      PLUGIN_VIEW_LIMITS.paramValue,
    )
    expect(() => parseParams({ 'Bad Key': 'x' }, 'params')).toThrowError(ViewDataError)
    expect(() => parseParams({ id: 1 }, 'params')).toThrowError(ViewDataError)
    expect(() =>
      parseParams(
        Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'x'])),
        'params',
      ),
    ).toThrowError(ViewDataError)
  })

  it('keeps switches as booleans and the rest as short text', () => {
    expect(parseFormValues({ on: true, note: 'hi' }, 'values')).toEqual({ on: true, note: 'hi' })
    expect(() => parseFormValues({ on: 1 }, 'values')).toThrowError(ViewDataError)
    expect(() => parseFormValues({ note: 'x'.repeat(2_001) }, 'values')).toThrowError(ViewDataError)
    expect(() => parseFormValues({ 'a b': true }, 'values')).toThrowError(ViewDataError)
  })
})
