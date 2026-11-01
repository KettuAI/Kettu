import { describe, expect, it } from 'vitest'
import type { SectionDef } from './model'
import { webSections } from './web-sections'

const section = (id: SectionDef['id'], rows: string[]): SectionDef =>
  ({
    id,
    title: id,
    description: '',
    icon: () => null,
    rows: rows.map((r) => ({ id: r })),
  }) as never

describe('webSections', () => {
  it("keeps the device's own rows and leaves out the host's", () => {
    const kept = webSections([
      section('general', ['language', 'background', 'open-at-login', 'send-key']),
      section('remote', ['switch']),
      section('archived', ['a', 'b']),
    ])
    expect(kept.map((s) => [s.id, s.rows.map((r) => r.id)])).toEqual([
      ['general', ['language', 'send-key']],
      ['archived', ['a', 'b']],
    ])
  })
})
