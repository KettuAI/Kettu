import { describe, expect, it } from 'vitest'
import { parseRuntimeMessage } from './artifact-capabilities'

describe('the wire format', () => {
  it('reads the four kinds a page sends', () => {
    expect(parseRuntimeMessage({ v: 1, id: 'a1', kind: 'use', cap: 'db' })).toEqual({
      v: 1,
      id: 'a1',
      kind: 'use',
      cap: 'db',
    })
    expect(
      parseRuntimeMessage({ v: 1, id: 'a2', kind: 'call', cap: 'db', op: 'get', extra: 1 }),
    ).toEqual({ v: 1, id: 'a2', kind: 'call', cap: 'db', op: 'get', args: null })
    expect(
      parseRuntimeMessage({ v: 3, id: 'a3', kind: 'stream', cap: 'sample', op: 'ask', args: [1] }),
    ).toEqual({ v: 3, id: 'a3', kind: 'stream', cap: 'sample', op: 'ask', args: [1] })
    expect(parseRuntimeMessage({ v: 1, id: 'a3', kind: 'cancel' })).toEqual({
      v: 1,
      id: 'a3',
      kind: 'cancel',
    })
  })

  it.each([
    null,
    [],
    'use',
    { v: 0, id: 'a', kind: 'use', cap: 'db' },
    { v: 1.5, id: 'a', kind: 'use', cap: 'db' },
    { v: '1', id: 'a', kind: 'use', cap: 'db' },
    { v: 1, id: '', kind: 'use', cap: 'db' },
    { v: 1, id: 'a b', kind: 'use', cap: 'db' },
    { v: 1, id: 'x'.repeat(65), kind: 'use', cap: 'db' },
    { v: 1, id: 'a', kind: 'use', cap: 'DB' },
    { v: 1, id: 'a', kind: 'use', cap: '__proto__' },
    { v: 1, id: 'a', kind: 'call', cap: 'db' },
    { v: 1, id: 'a', kind: 'call', cap: 'db', op: 'get-all' },
    { v: 1, id: 'a', kind: 'select', cap: 'db' },
  ])('refuses %j', (value) => {
    expect(parseRuntimeMessage(value)).toBeNull()
  })
})
