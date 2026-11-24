import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_REF_LIMITS, linkTrigger, mentionTrigger } from '@shared/plugin-refs'
import type { PluginRefSource } from '@shared/plugin-refs'
import { pluginClient } from '../testing/plugin-host'
import { PluginRefs } from './refs'

const SOURCE: PluginRefSource = {
  pluginId: 'tracker',
  name: 'tracker',
  title: 'Tracker',
  icon: null,
  mentions: [{ id: 'issues', title: { en: 'Issues' } }],
  links: [{ id: 'issue', patterns: ['https://tracker.example.com/issues/{key}'] }],
}

const SCRIPT = `
kettu.on('mention.search', ({ source, query, locale }) => {
  console.log('SEARCH ' + JSON.stringify({ source, query, locale }))
  if (query === 'broken') return { items: [{ id: 1, title: 'A' }] }
  if (query === 'throws') throw new Error('boom')
  if (query === 'loud') throw new TypeError('<b>bad</b> ' + 'x'.repeat(1000))
  if (query === 'slow') return new Promise(() => {})
  if (query === 'silent') return
  if (query === 'many') {
    return { items: Array.from({ length: 30 }, (_, i) => ({ id: 'k' + i, title: 'Issue ' + i })) }
  }
  return {
    items: [
      { id: 'T-1', title: 'Sync drops', subtitle: 'T-1', end: 'open', word: 'T-1' },
      { id: 'T-2', title: 'Slow start', icon: 'bug' },
    ],
  }
})

kettu.on('mention.content', ({ source, item, locale }) => {
  console.log('CONTENT ' + JSON.stringify({ source, item, locale }))
  if (item === 'gone') return
  if (item === 'long') return { text: 'x'.repeat(20000) }
  if (item === 'blank') return { text: '   ' }
  return { title: 'Issue ' + item, text: 'Body of ' + item }
})

kettu.on('link.card', ({ link, url, match, locale }) => {
  console.log('CARD ' + JSON.stringify({ link, url, match, locale }))
  if (match.key === 'T-0') return { title: 42 }
  if (match.key === 'T-9') throw new Error('No such issue')
  return {
    label: match.key,
    title: 'Sync drops',
    badges: [
      { text: 'open', tone: 'success' },
      { text: 'a' }, { text: 'b' }, { text: 'c' },
    ],
    fields: [
      { label: 'Owner', value: 'Ada' }, { label: 'b', value: '1' }, { label: 'c', value: '2' },
      { label: 'd', value: '3' }, { label: 'e', value: '4' },
    ],
  }
})
`

let stop: (() => void) | null = null
afterEach(() => stop?.())

function setup(options: { deadlineMs?: number; source?: PluginRefSource | null } = {}) {
  const logs: string[] = []
  const { client, host } = pluginClient({ functions: {} })
  host.limits = { answerMs: 400, callMs: 300 }
  stop = () => {
    client.stop()
    host.stop()
  }
  host.scripts.set('/tracker.js', SCRIPT)
  client.register({
    id: 'tracker',
    scriptPath: '/tracker.js',
    activation: [mentionTrigger('issues'), linkTrigger('issue')],
  })
  const refs = new PluginRefs({
    client,
    source: (id) =>
      id === 'tracker' ? (options.source === undefined ? SOURCE : options.source) : null,
    locale: () => 'zh-CN',
    log: (level, message) => logs.push(`${level} ${message}`),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  })
  return { refs, host, logs }
}

const told = (logs: string[], kind: string): unknown[] =>
  logs
    .filter((line) => line.includes(` info ${kind} `))
    .map((line) => JSON.parse(line.split(`${kind} `)[1]!))

describe('searching a mention source', () => {
  it('wakes the script for the source and gives the items it found', async () => {
    const { refs, host } = setup()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(host.logs).toEqual([])
    expect(await refs.search('tracker', 'issues', 'sy')).toEqual({
      ok: true,
      items: [
        { id: 'T-1', title: 'Sync drops', subtitle: 'T-1', end: 'open', word: 'T-1' },
        { id: 'T-2', title: 'Slow start', icon: 'bug' },
      ],
    })
    expect(told(host.logs, 'SEARCH')).toEqual([{ source: 'issues', query: 'sy', locale: 'zh-CN' }])
  })

  it('cuts the query and the list to the limits and says the list was cut', async () => {
    const { refs, host } = setup()
    const long = 'q'.repeat(PLUGIN_REF_LIMITS.query + 50)
    await refs.search('tracker', 'issues', long)
    expect(told(host.logs, 'SEARCH')).toEqual([
      { source: 'issues', query: long.slice(0, PLUGIN_REF_LIMITS.query), locale: 'zh-CN' },
    ])
    const found = await refs.search('tracker', 'issues', 'many')
    expect(found).toMatchObject({ ok: true, truncated: true })
    expect(found.ok && found.items).toHaveLength(PLUGIN_REF_LIMITS.items)
  })

  it('gives an error for a source or a plugin that is not there', async () => {
    const { refs } = setup()
    expect(await refs.search('tracker', 'nowhere', '')).toEqual({
      ok: false,
      error: { code: 'not_found' },
    })
    expect(await refs.search('someone-else', 'issues', '')).toEqual({
      ok: false,
      error: { code: 'not_found' },
    })
  })

  it('gives an error for an answer that is not a list of items, naming the field', async () => {
    const { refs, logs } = setup()
    expect(await refs.search('tracker', 'issues', 'broken')).toEqual({
      ok: false,
      error: { code: 'invalid', detail: 'items[0].id must be text of 1 to 128 characters' },
    })
    expect(logs.join('\n')).toContain('answered mention.search badly')
  })

  it('gives the script’s own message when it throws, and says when it has nothing to say', async () => {
    const { refs } = setup()
    expect(await refs.search('tracker', 'issues', 'throws')).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'boom' },
    })
    expect(await refs.search('tracker', 'issues', 'silent')).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'No listener gave an answer' },
    })
    expect(await refs.search('tracker', 'issues', 'x')).toMatchObject({ ok: true })
  })

  it('cuts a long message and keeps the name of an error that is not a plain Error', async () => {
    const { refs } = setup()
    const out = await refs.search('tracker', 'issues', 'loud')
    expect(out).toMatchObject({ ok: false, error: { code: 'failed' } })
    const detail = (out as { error: { detail: string } }).error.detail
    expect(detail).toHaveLength(300)
    expect(detail.startsWith('TypeError: <b>bad</b> xxx')).toBe(true)
  })

  it('stops waiting at the deadline for a script that does not answer', async () => {
    const { refs } = setup({ deadlineMs: 80 })
    const started = Date.now()
    expect(await refs.search('tracker', 'issues', 'slow')).toEqual({
      ok: false,
      error: { code: 'timeout' },
    })
    expect(Date.now() - started).toBeLessThan(280)
  })
})

describe('reading what a mentioned item adds', () => {
  it('asks the script for the item and gives its text and title', async () => {
    const { refs, host } = setup()
    expect(await refs.content('tracker', 'issues', 'T-1')).toEqual({
      ok: true,
      content: { title: 'Issue T-1', text: 'Body of T-1' },
    })
    expect(told(host.logs, 'CONTENT')).toEqual([{ source: 'issues', item: 'T-1', locale: 'zh-CN' }])
  })

  it('cuts a long text and refuses a blank one or no answer', async () => {
    const { refs } = setup()
    const long = await refs.content('tracker', 'issues', 'long')
    expect(long.ok && long.content.text).toHaveLength(PLUGIN_REF_LIMITS.content)
    expect(await refs.content('tracker', 'issues', 'blank')).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    expect(await refs.content('tracker', 'issues', 'gone')).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    })
  })

  it('gives an error for a source the plugin no longer declares', async () => {
    const { refs } = setup({ source: { ...SOURCE, mentions: [] } })
    expect(await refs.content('tracker', 'issues', 'T-1')).toEqual({
      ok: false,
      error: { code: 'not_found' },
    })
  })
})

describe('asking for a link’s card', () => {
  it('tells the script what the pattern matched and gives the card within the limits', async () => {
    const { refs, host } = setup()
    const url = 'https://tracker.example.com/issues/T-1'
    const answer = await refs.card('tracker', 'issue', url)
    expect(answer).toEqual({
      ok: true,
      card: {
        label: 'T-1',
        title: 'Sync drops',
        badges: [{ text: 'open', tone: 'success' }, { text: 'a' }, { text: 'b' }],
        fields: [
          { label: 'Owner', value: 'Ada' },
          { label: 'b', value: '1' },
          { label: 'c', value: '2' },
          { label: 'd', value: '3' },
        ],
      },
    })
    expect(told(host.logs, 'CARD')).toEqual([
      { link: 'issue', url, match: { key: 'T-1' }, locale: 'zh-CN' },
    ])
  })

  it('does not ask the script about an address its pattern does not name', async () => {
    const { refs, host } = setup()
    for (const url of [
      'https://tracker.example.com/pulls/T-1',
      'https://evil.example.net/issues/T-1',
      'http://tracker.example.com/issues/T-1',
      'https://tracker.example.com/issues/T-1/extra',
    ]) {
      expect(await refs.card('tracker', 'issue', url)).toEqual({
        ok: false,
        error: { code: 'not_found' },
      })
    }
    expect(told(host.logs, 'CARD')).toEqual([])
  })

  it('gives the script’s own message when it throws', async () => {
    const { refs } = setup()
    expect(await refs.card('tracker', 'issue', 'https://tracker.example.com/issues/T-9')).toEqual({
      ok: false,
      error: { code: 'failed', detail: 'No such issue' },
    })
  })

  it('refuses a card whose shape does not fit', async () => {
    const { refs } = setup()
    expect(await refs.card('tracker', 'issue', 'https://tracker.example.com/issues/T-0')).toEqual({
      ok: false,
      error: { code: 'invalid', detail: 'title must be text' },
    })
  })
})
