import { afterEach, describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@shared/updates'
import { i18n } from '@renderer/lib/i18n'
import { appUpdateNotice, appUpdateText } from './app-updates'

afterEach(() => i18n.changeLanguage('en'))

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    state: { kind: 'idle', checkedAt: null },
    mode: 'install',
    readOnly: false,
    current: '0.2.0',
    updatedFrom: null,
    dismissed: null,
    ...overrides,
  }
}

describe('appUpdateNotice', () => {
  it('shows nothing while there is nothing to do', () => {
    expect(appUpdateNotice(null, false)).toBeNull()
    expect(appUpdateNotice(status(), false)).toBeNull()
    expect(appUpdateNotice(status({ state: { kind: 'checking', manual: true } }), false)).toBeNull()
  })

  it('keeps a dismissed version out of sight', () => {
    expect(
      appUpdateNotice(
        status({ state: { kind: 'ready', version: '0.3.0' }, dismissed: '0.3.0' }),
        false,
      ),
    ).toBeNull()
  })

  it('names the version the app was updated from, for that launch until dismissed', () => {
    const updated = status({ current: '0.3.0', updatedFrom: '0.2.0' })
    expect(appUpdateNotice(updated, false)).toEqual({
      kind: 'updated',
      version: '0.3.0',
      from: '0.2.0',
    })
    expect(appUpdateNotice(updated, true)).toBeNull()
  })

  it('says when Update moves the app first, and shows the move', () => {
    const available = {
      kind: 'available' as const,
      version: '0.3.0',
      mode: 'install' as const,
      downloadUrl: null,
    }
    expect(appUpdateNotice(status({ state: available }), false)).toEqual({
      kind: 'available',
      version: '0.3.0',
      moves: false,
    })
    expect(appUpdateNotice(status({ state: available, readOnly: true }), false)).toEqual({
      kind: 'available',
      version: '0.3.0',
      moves: true,
    })
    expect(
      appUpdateNotice(
        status({ state: { kind: 'moving', version: '0.3.0' }, readOnly: true }),
        false,
      ),
    ).toEqual({ kind: 'moving', version: '0.3.0' })
  })
})

describe('appUpdateText', () => {
  it('offers a restart for a ready update, which keeps the sessions', () => {
    expect(appUpdateText({ kind: 'ready', version: '0.3.0' })).toEqual({
      title: 'Kettu 0.3.0 is ready',
      note: 'Your sessions come back',
      rowNote: 'Needs a restart · sessions come back',
      action: 'restart',
      actionLabel: 'Restart',
      href: null,
    })
  })

  it('offers to download and install an update, moving the app first from a read-only volume', () => {
    expect(appUpdateText({ kind: 'available', version: '0.3.0', moves: false })).toMatchObject({
      title: 'Kettu 0.3.0 is out',
      note: 'Downloads, then restarts',
      action: 'update',
      actionLabel: 'Update',
    })
    expect(appUpdateText({ kind: 'available', version: '0.3.0', moves: true }).note).toBe(
      'Moves to Applications, then restarts',
    )
  })

  it('links to the download when the update is on the release page only', () => {
    expect(appUpdateText({ kind: 'link', version: '0.3.0', downloadUrl: null })).toMatchObject({
      action: 'download',
      href: 'https://github.com/KettuAI/Kettu/releases/tag/v0.3.0',
    })
    expect(
      appUpdateText({ kind: 'link', version: '0.3.0', downloadUrl: 'https://x.test/k.dmg' }).href,
    ).toBe('https://x.test/k.dmg')
  })

  it('shows a download and a move without an action, which the bar and corner handle', () => {
    expect(appUpdateText({ kind: 'downloading', version: '0.3.0', percent: 42 })).toMatchObject({
      title: 'Updating Kettu',
      note: 'Downloading 0.3.0',
      rowNote: 'Downloading · 42%',
      action: null,
    })
    expect(appUpdateText({ kind: 'moving', version: '0.3.0' }).action).toBeNull()
  })

  it('names the version an update came from and links to what is new', () => {
    expect(appUpdateText({ kind: 'updated', version: '0.3.0', from: '0.2.0' })).toMatchObject({
      title: 'Kettu 0.3.0',
      note: 'Updated from 0.2.0',
      action: 'whats-new',
      href: 'https://github.com/KettuAI/Kettu/releases/tag/v0.3.0',
    })
  })

  it('speaks Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(appUpdateText({ kind: 'ready', version: '0.3.0' }).title).toBe('Kettu 0.3.0 已就绪')
  })
})
