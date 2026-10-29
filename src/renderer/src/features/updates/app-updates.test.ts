import { afterEach, describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@shared/updates'
import { i18n } from '@renderer/lib/i18n'
import { appUpdateNotice, appUpdateRow } from './app-updates'

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

describe('appUpdateRow', () => {
  it('offers a restart for a ready update', () => {
    expect(appUpdateRow({ kind: 'ready', version: '0.3.0' })).toEqual({
      words: 'Update ready',
      versionFirst: false,
      label: 'Update ready 0.3.0',
      detail: 'Restart to finish; your sessions come back.',
      action: 'restart',
      actionLabel: 'Restart',
      href: null,
      dismissible: true,
    })
  })

  it('offers to download and install an update on offer', () => {
    expect(appUpdateRow({ kind: 'available', version: '0.3.0', moves: false })).toMatchObject({
      label: '0.3.0 is out',
      detail: 'Update downloads it, then restarts; your sessions come back.',
      action: 'update',
      actionLabel: 'Update',
      href: null,
      dismissible: true,
    })
  })

  it('says that Update moves the app first from a read-only volume, and shows the move', () => {
    expect(appUpdateRow({ kind: 'available', version: '0.3.0', moves: true })).toMatchObject({
      label: '0.3.0 is out',
      detail: 'Update moves Kettu to Applications, then restarts; your sessions come back.',
      action: 'update',
    })
    expect(appUpdateRow({ kind: 'moving', version: '0.3.0' })).toEqual({
      words: 'Moving to Applications…',
      versionFirst: false,
      label: 'Moving to Applications…',
      detail: null,
      action: null,
      actionLabel: '',
      href: null,
      dismissible: false,
    })
  })

  it('links to the download when the update is on the release page only', () => {
    expect(
      appUpdateRow({ kind: 'link', version: '0.3.0', downloadUrl: 'https://example.com/a.dmg' }),
    ).toMatchObject({
      label: '0.3.0 is out',
      detail: 'Download it from the release page.',
      action: 'download',
      actionLabel: 'Download',
      href: 'https://example.com/a.dmg',
      dismissible: true,
    })
    expect(appUpdateRow({ kind: 'link', version: '0.3.0', downloadUrl: null }).href).toBe(
      'https://github.com/KettuAI/Kettu/releases/tag/v0.3.0',
    )
  })

  it('shows a download by its progress, which is cancelled rather than dismissed', () => {
    expect(appUpdateRow({ kind: 'downloading', version: '0.3.0', percent: 40 })).toMatchObject({
      label: 'Downloading 0.3.0',
      detail: null,
      action: 'cancel',
      actionLabel: 'Cancel update',
      dismissible: false,
    })
  })

  it('names the version an update came from and links to what is new', () => {
    expect(appUpdateRow({ kind: 'updated', version: '0.3.0', from: '0.2.0' })).toMatchObject({
      label: 'Updated to 0.3.0',
      detail: 'Updated from 0.2.0.',
      action: 'whats-new',
      actionLabel: 'What’s new',
      href: 'https://github.com/KettuAI/Kettu/releases/tag/v0.3.0',
      dismissible: true,
    })
  })

  it('speaks Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(appUpdateRow({ kind: 'available', version: '0.3.0', moves: false })).toMatchObject({
      label: '0.3.0 已发布',
      detail: '「更新」会下载并重启，会话会自动恢复。',
    })
    expect(appUpdateRow({ kind: 'available', version: '0.3.0', moves: true }).detail).toBe(
      '「更新」会把 Kettu 移到“应用程序”文件夹并重启，会话会自动恢复。',
    )
    expect(appUpdateRow({ kind: 'moving', version: '0.3.0' }).label).toBe('正在移到“应用程序”…')
    expect(appUpdateRow({ kind: 'updated', version: '0.3.0', from: '0.2.0' }).detail).toBe(
      '从 0.2.0 更新而来。',
    )
  })
})
