import { describe, expect, it } from 'vitest'
import { footerLabel } from './footer-label'

describe('footerLabel', () => {
  it('reads Not checked yet until a check found nothing, as About does', () => {
    expect(footerLabel({ kind: 'idle', checkedAt: null })).toEqual({
      key: 'about.updates.notChecked',
      pill: false,
    })
    expect(footerLabel({ kind: 'idle', checkedAt: 5000 })).toEqual({
      key: 'footer.upToDate',
      pill: false,
    })
  })

  it('reads the other states as before', () => {
    expect(footerLabel({ kind: 'ready', version: '0.4.0' })).toEqual({
      key: 'footer.ready',
      values: { version: '0.4.0' },
      pill: true,
    })
    expect(
      footerLabel({ kind: 'available', version: '0.4.0', mode: 'link', downloadUrl: null }),
    ).toEqual({ key: 'footer.available', values: { version: '0.4.0' }, pill: true })
    expect(
      footerLabel({ kind: 'downloading', version: '0.4.0', percent: 41.6, manual: false }),
    ).toEqual({ key: 'footer.downloading', values: { percent: 42 }, pill: false })
    expect(footerLabel({ kind: 'checking', manual: false })).toBeNull()
    expect(footerLabel({ kind: 'error', message: 'offline', manual: true })).toBeNull()
    expect(footerLabel({ kind: 'off', reason: 'development' })).toBeNull()
  })
})
