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
  it("keeps the device's own rows and leaves out the host's, in the groups the list shows", () => {
    const kept = webClusters([
      [
        section('general', ['language', 'background', 'open-at-login', 'send-key']),
        section('hosts', ['list']),
      ],
      [section('agents', ['list']), section('terminal', ['font-size', 'shell'])],
      [section('archived', ['a', 'b']), section('sharing', ['account'])],
      // A group with nothing the web client keeps leaves no gap in the list.
      [section('remote', ['switch'])],
    ])
    expect(ids(kept)).toEqual([
      [['general', ['language', 'send-key']]],
      [['terminal', ['font-size']]],
      [['archived', ['a', 'b']]],
    ])
  })
})
