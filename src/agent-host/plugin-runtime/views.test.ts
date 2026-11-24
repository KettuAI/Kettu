import { afterEach, describe, expect, it } from 'vitest'
import type { PluginActionDecl, PluginViewDecl } from '@shared/plugin-views'
import { actionTrigger, viewTrigger } from '@shared/plugin-views'
import { pluginClient } from '../testing/plugin-host'
import { PluginViews } from './views'

const DECLS: PluginViewDecl[] = [
  { id: 'issues', kind: 'list', title: { en: 'Issues' }, pane: true },
  { id: 'issue', kind: 'detail', title: { en: 'Issue' } },
  { id: 'label', kind: 'form', title: { en: 'Label' } },
  { id: 'broken', kind: 'list', title: { en: 'Broken' } },
  { id: 'throws', kind: 'detail', title: { en: 'Throws' } },
  { id: 'loud', kind: 'detail', title: { en: 'Loud' } },
  { id: 'slow', kind: 'detail', title: { en: 'Slow' } },
  { id: 'spins', kind: 'detail', title: { en: 'Spins' } },
  { id: 'silent', kind: 'detail', title: { en: 'Silent' } },
]

const ACTIONS: PluginActionDecl[] = [
  { id: 'show-issues', title: { en: 'Show issues' } },
  { id: 'show-issue', title: { en: 'Show one issue' } },
  { id: 'create', title: { en: 'Create an issue' } },
  { id: 'quiet', title: { en: 'Do nothing' } },
  { id: 'refuse', title: { en: 'Refuse' } },
  { id: 'throw', title: { en: 'Throw' } },
  { id: 'wander', title: { en: 'Go nowhere' } },
  { id: 'stall', title: { en: 'Stall' } },
]

const SCRIPT = `
kettu.on('view.data', ({ view, params, locale }) => {
  console.log('OPEN ' + JSON.stringify({ view, params, locale }))
  if (view === 'issues') {
    return {
      scope: [locale],
      rows: [
        {
          id: '1',
          title: 'Sync drops',
          actions: [
            { id: 'open', label: 'Open', open: { view: 'issue', params: { id: '1' } } },
            { id: 'close', label: 'Close', destructive: true },
          ],
        },
      ],
    }
  }
  if (view === 'issue') return { title: 'Issue ' + params.id, body: '**hi**' }
  if (view === 'label') {
    return {
      fields: [{ type: 'text', key: 'name', label: 'Name' }],
      submit: { id: 'save', label: 'Save' },
    }
  }
  if (view === 'broken') return { rows: [{ id: 1, title: 'A' }] }
  if (view === 'throws') throw new Error('boom')
  if (view === 'loud') throw new TypeError('<b>bad</b> ' + 'x'.repeat(1000))
  if (view === 'slow') return new Promise(() => {})
  if (view === 'spins') for (;;) {}
})

kettu.on('view.action', ({ view, action, row, values, params }) => {
  console.log('ACTION ' + JSON.stringify({ view, action, row, values, params }))
  if (action === 'close') return { notice: 'Closed ' + row }
  if (action === 'save') return { notice: 'Saved ' + values.name, open: { view: 'issue', params: { id: '9' } } }
  if (action === 'refuse') return { error: 'The API key is not set' }
  if (action === 'wander') return { open: { view: 'nowhere' } }
  if (action === 'throw') throw new Error('nope')
})

kettu.on('action.run', ({ action, locale }) => {
  console.log('RUN ' + JSON.stringify({ action, locale }))
  if (action === 'show-issues') return { open: { view: 'issues', params: { team: 'ENG' } } }
  if (action === 'show-issue') return { open: { view: 'issue' } }
  if (action === 'create') return { notice: 'Created in ' + locale }
  if (action === 'refuse') return { error: 'The API key is not set' }
  if (action === 'wander') return { open: { view: 'nowhere' } }
  if (action === 'throw') throw new Error('nope')
  if (action === 'stall') return new Promise(() => {})
})
`

let stop: (() => void) | null = null
afterEach(() => stop?.())

function setup(decls: PluginViewDecl[] = DECLS) {
  const logs: string[] = []
  const { client, host } = pluginClient({ functions: {} })
  host.limits = { answerMs: 400, callMs: 300 }
  stop = () => {
    client.stop()
    host.stop()
  }
  host.scripts.set('/views.js', SCRIPT)
  client.register({
    id: 'views',
    scriptPath: '/views.js',
    activation: [
      ...DECLS.map((view) => viewTrigger(view.id)),
      ...ACTIONS.map((action) => actionTrigger(action.id)),
    ],
  })
  const views = new PluginViews({
    client,
    views: (id) => (id === 'views' ? decls : []),
    actions: (id) => (id === 'views' ? ACTIONS : []),
    locale: () => 'zh-CN',
    log: (level, message) => logs.push(`${level} ${message}`),
  })
  return { views, host, logs }
}

const told = (logs: string[], kind: string): unknown[] =>
  logs
    .filter((line) => line.includes(` info ${kind} `))
    .map((line) => JSON.parse(line.split(`${kind} `)[1]!))

describe('opening a view', () => {
  it('wakes the script only for the view, asks it with the parameters and the language, and checks the answer', async () => {
    const { views, host } = setup()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(host.logs).toEqual([])
    expect(await views.data('views', 'issues', {})).toEqual({
      ok: true,
      view: {
        kind: 'list',
        scope: ['zh-CN'],
        rows: [
          {
            id: '1',
            title: 'Sync drops',
            actions: [
              { id: 'open', label: 'Open', open: { view: 'issue', params: { id: '1' } } },
              { id: 'close', label: 'Close', destructive: true },
            ],
          },
        ],
      },
    })
    expect(await views.data('views', 'issue', { id: '1' })).toEqual({
      ok: true,
      view: { kind: 'detail', title: 'Issue 1', body: '**hi**' },
    })
    expect(told(host.logs, 'OPEN')).toEqual([
      { view: 'issues', params: {}, locale: 'zh-CN' },
      { view: 'issue', params: { id: '1' }, locale: 'zh-CN' },
    ])
  })

  it('draws a view the manifest declares as a form, with the defaults filled in', async () => {
    const { views } = setup()
    expect(await views.data('views', 'label', {})).toMatchObject({
      ok: true,
      view: { kind: 'form', fields: [{ type: 'text', key: 'name', value: '', maxLength: 500 }] },
    })
  })

  it('gives an error, never a throw, for a view that is not there', async () => {
    const { views } = setup()
    expect(await views.data('views', 'nowhere', {})).toEqual({
      ok: false,
      error: { code: 'not_found' },
    })
    expect(await views.data('someone-else', 'issues', {})).toEqual({
      ok: false,
      error: { code: 'not_found' },
    })
  })

  it('gives an error for an answer that is not a view, naming the field', async () => {
    const { views, logs } = setup()
    expect(await views.data('views', 'broken', {})).toEqual({
      ok: false,
      error: { code: 'invalid', detail: 'rows[0].id must be text of 1 to 128 characters' },
    })
    expect(logs.join('\n')).toContain('does not fit')
  })

  it('gives the script’s own message when it throws, and an error for one that has nothing to say', async () => {
    const { views, host } = setup()
    expect(await views.data('views', 'throws', {})).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'boom' },
    })
    expect(await views.data('views', 'silent', {})).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'No listener of view.data gave a view' },
    })
    expect(host.logs.join('\n')).toContain('A listener of "view.data" failed: Error: boom')
  })

  it('cuts a long message and keeps the name of an error that is not a plain Error', async () => {
    const { views } = setup()
    const out = await views.data('views', 'loud', {})
    expect(out).toMatchObject({ ok: false, error: { code: 'failed' } })
    const detail = (out as { error: { detail: string } }).error.detail
    expect(detail).toHaveLength(300)
    expect(detail.startsWith('TypeError: <b>bad</b> xxx')).toBe(true)
  })

  it('gives a timeout for a script that does not answer, and the script stays usable', async () => {
    const { views } = setup()
    expect(await views.data('views', 'slow', {})).toEqual({ ok: false, error: { code: 'timeout' } })
    expect(await views.data('views', 'issue', { id: '2' })).toMatchObject({ ok: true })
  })

  it('gives an error for a script that runs past its limit, which stops it', async () => {
    const { views } = setup()
    expect(await views.data('views', 'spins', {})).toEqual({
      ok: false,
      error: { code: 'crashed' },
    })
  })

  it('does not call a script stopped by another request a plugin host that is not running', async () => {
    const { views } = setup()
    const both = await Promise.all([
      views.data('views', 'spins', {}),
      views.data('views', 'spins', {}),
    ])
    expect(both.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual([
      'crashed',
      'crashed',
    ])
  })
})

describe('running an action', () => {
  it('tells the script the action, the row and the values, and says what it answered', async () => {
    const { views, host } = setup()
    expect(await views.act('views', 'issues', { id: '1' }, { action: 'close', row: '1' })).toEqual({
      ok: true,
      notice: 'Closed 1',
    })
    expect(
      await views.act('views', 'label', {}, { action: 'save', values: { name: 'ops' } }),
    ).toEqual({ ok: true, notice: 'Saved ops', open: { view: 'issue', params: { id: '9' } } })
    expect(told(host.logs, 'ACTION')).toEqual([
      { view: 'issues', action: 'close', row: '1', params: { id: '1' } },
      { view: 'label', action: 'save', values: { name: 'ops' }, params: {} },
    ])
  })

  it('is fine when the script answers nothing', async () => {
    const { views } = setup()
    expect(await views.act('views', 'issues', {}, { action: 'quiet' })).toEqual({ ok: true })
  })

  it('refuses the action in the script’s own words, or when it throws', async () => {
    const { views } = setup()
    expect(await views.act('views', 'issues', {}, { action: 'refuse' })).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'The API key is not set' },
    })
    expect(await views.act('views', 'issues', {}, { action: 'throw' })).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'nope' },
    })
  })

  it('refuses a view to go to that the plugin does not have', async () => {
    const { views } = setup()
    expect(await views.act('views', 'issues', {}, { action: 'wander' })).toEqual({
      ok: false,
      error: { code: 'invalid', detail: 'open.view is not a view of this plugin' },
    })
  })

  it('gives an error for a view that is not there', async () => {
    const { views } = setup()
    expect(await views.act('views', 'nowhere', {}, { action: 'close' })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    })
  })
})

describe('running an action Search lists', () => {
  it('wakes the script for the action and says what it answered, in the interface language', async () => {
    const { views, host } = setup()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(host.logs).toEqual([])
    expect(await views.run('views', 'create')).toEqual({ ok: true, notice: 'Created in zh-CN' })
    expect(await views.run('views', 'quiet')).toEqual({ ok: true })
    expect(told(host.logs, 'RUN')).toEqual([
      { action: 'create', locale: 'zh-CN' },
      { action: 'quiet', locale: 'zh-CN' },
    ])
  })

  it('may open a pane, with the parameters it names', async () => {
    const { views } = setup()
    expect(await views.run('views', 'show-issues')).toEqual({
      ok: true,
      open: { view: 'issues', params: { team: 'ENG' } },
    })
  })

  it('may not open a view that is no pane, nor one the plugin does not have', async () => {
    const { views } = setup()
    expect(await views.run('views', 'show-issue')).toEqual({
      ok: false,
      error: { code: 'invalid', detail: 'open.view is not a view of this plugin' },
    })
    expect(await views.run('views', 'wander')).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
  })

  it('refuses in the script’s own words, or when it throws or does not answer', async () => {
    const { views } = setup()
    expect(await views.run('views', 'refuse')).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'The API key is not set' },
    })
    expect(await views.run('views', 'throw')).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'nope' },
    })
    expect(await views.run('views', 'stall')).toEqual({ ok: false, error: { code: 'timeout' } })
  })

  it('runs only an action the plugin declares, and only while it is on', async () => {
    const { views, host } = setup()
    expect(await views.run('views', 'nowhere')).toEqual({ ok: false, error: { code: 'not_found' } })
    expect(await views.run('someone-else', 'create')).toEqual({
      ok: false,
      error: { code: 'not_found' },
    })
    expect(told(host.logs, 'RUN')).toEqual([])
  })
})
