import { describe, expect, it } from 'vitest'
import { forgetViewers, receiveViewers, useViewersStore, viewerNames } from './viewers'

const phone = { kind: 'device' as const, id: 'a'.repeat(32), name: 'Phone' }

describe('who else has a session in front', () => {
  it('keeps the latest list for each session, and none once it is empty or gone', () => {
    receiveViewers('s1', [{ kind: 'host' }, phone])
    receiveViewers('s2', [phone])
    expect(useViewersStore.getState().bySession).toEqual({
      s1: [{ kind: 'host' }, phone],
      s2: [phone],
    })
    receiveViewers('s1', [])
    forgetViewers('s2')
    expect(useViewersStore.getState().bySession).toEqual({})
  })

  it("names the host's windows after the host", () => {
    expect(viewerNames([{ kind: 'host' }, phone], 'dev-box')).toEqual(['dev-box', 'Phone'])
  })
})
