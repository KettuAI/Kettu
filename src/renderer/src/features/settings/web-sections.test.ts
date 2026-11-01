import { describe, expect, it } from 'vitest'
import type { SectionDef } from './model'
import { webClusters } from './web-sections'

const section = (id: SectionDef['id'], rows: string[]): SectionDef =>
  ({
    id,
    title: id,
    description: '',
    icon: () => null,
    rows: rows.map((r) => ({ id: r })),
  }) as never

const ids = (clusters: SectionDef[][]) =>
  clusters.map((cluster) => cluster.map((s) => [s.id, s.rows.map((r) => r.id)]))

describe('webClusters', () => {
  it('leaves out only what a browser cannot do, in the groups the list shows', () => {
    const kept = webClusters([
      [
        section('general', [
          'language',
          'confirm-quit',
          'session-titles',
          'background',
          'open-at-login',
          'send-key',
        ]),
        section('appearance', ['theme', 'color-mode', 'zoom', 'text-size']),
        section('hosts', ['list']),
      ],
      // A group with nothing the web client keeps leaves no gap in the list.
      [section('browser', ['clear-data', 'allowed-sites'])],
      [section('agents', ['list']), section('terminal', ['shell', 'font-size'])],
      [section('sharing', ['cloudflare']), section('remote', ['remote', 'reset'])],
      [section('about', ['update', 'source', 'notices', 'issues'])],
    ])
    expect(ids(kept)).toEqual([
      [
        ['general', ['language', 'session-titles', 'send-key']],
        ['appearance', ['theme', 'color-mode', 'text-size']],
        ['hosts', ['list']],
      ],
      [
        ['agents', ['list']],
        ['terminal', ['shell', 'font-size']],
      ],
      [
        ['sharing', ['cloudflare']],
        ['remote', ['remote', 'reset']],
      ],
      [['about', ['update', 'source', 'issues']]],
    ])
  })

  it('keeps a section or row it has never heard of', () => {
    const kept = webClusters([[section('mcp', ['kettu', 'new-row']), section('usage', ['new'])]])
    expect(ids(kept)).toEqual([
      [
        ['mcp', ['kettu', 'new-row']],
        ['usage', ['new']],
      ],
    ])
  })
})
