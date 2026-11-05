import { describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { restoreConfig } from './stored-config'

const legacy: ConfigOption = {
  id: '__ultracode',
  name: 'Ultracode',
  category: 'other',
  type: 'boolean',
  value: false,
  idleOnly: true,
}

describe('stored configuration migration', () => {
  it('keeps an unset legacy switch inherited instead of explicitly disabling it', () => {
    expect(restoreConfig([legacy], {}).at(-1)).toMatchObject({
      id: '__ultracode',
      value: 'default',
      defaultValue: null,
      indicator: true,
    })
  })

  it.each([true, false])('preserves an explicit legacy value of %s', (ultracode) => {
    expect(restoreConfig([legacy], { ultracode }).at(-1)?.value).toBe(ultracode)
    expect(restoreConfig([], { ultracode }).at(-1)?.value).toBe(ultracode)
  })

  it('adds the same option to stored sessions that never had it', () => {
    expect(restoreConfig([], {}).at(-1)).toMatchObject({
      id: '__ultracode',
      value: 'default',
      defaultValue: null,
    })
  })

  it.each(['default', true, false] as const)(
    'keeps migrated choice %s instead of consulting the legacy field again',
    (value) => {
      const current = { ...legacy, value, defaultValue: true, indicator: true }
      expect(restoreConfig([current], { ultracode: !value })).toEqual([current])
      expect(restoreConfig(restoreConfig([current], {}), {})).toEqual([current])
    },
  )
})
