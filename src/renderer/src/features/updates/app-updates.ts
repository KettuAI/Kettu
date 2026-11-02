import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { i18n } from '@renderer/lib/i18n'

/** The app's update notice, shown only when there is something to do. */
export type AppUpdateNotice =
  | { kind: 'ready'; version: string }
  // moves: on a read-only volume, Update moves the app to Applications first.
  | { kind: 'available'; version: string; moves: boolean }
  | { kind: 'moving'; version: string }
  | { kind: 'link'; version: string; downloadUrl: string | null }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'updated'; version: string; from: string }

export function appUpdateNotice(
  status: UpdateStatus | null,
  updatedSeen: boolean,
): AppUpdateNotice | null {
  if (!status) return null
  const { state } = status
  if (state.kind === 'moving') return { kind: 'moving', version: state.version }
  if (state.kind === 'downloading' && state.manual && status.dismissed !== state.version)
    return { kind: 'downloading', version: state.version, percent: state.percent }
  if (state.kind === 'ready' && status.dismissed !== state.version)
    return { kind: 'ready', version: state.version }
  if (state.kind === 'available' && status.dismissed !== state.version) {
    return state.mode === 'install'
      ? { kind: 'available', version: state.version, moves: status.readOnly }
      : { kind: 'link', version: state.version, downloadUrl: state.downloadUrl }
  }
  if (status.updatedFrom && !updatedSeen)
    return { kind: 'updated', version: status.current, from: status.updatedFrom }
  return null
}

export type AppUpdateAction = 'restart' | 'update' | 'download' | 'whats-new'

/** What the card and the review list say of the app's update in each state. */
export interface AppUpdateText {
  /** The card's first line: "Kettu 0.3.0 is ready". */
  title: string
  /** The card's second line. */
  note: string
  /** The review list's line under the name and versions. */
  rowNote: string
  /** Null while it downloads or moves, which nothing but its own corner stops. */
  action: AppUpdateAction | null
  actionLabel: string
  /** The page an action opens in the browser. */
  href: string | null
}

/** The app's update in words, with its one action. */
export function appUpdateText(notice: AppUpdateNotice): AppUpdateText {
  const { version } = notice
  const text = (
    title: string,
    note: string,
    rowNote: string,
    action: AppUpdateAction | null,
    actionLabel = '',
    href: string | null = null,
  ): AppUpdateText => ({ title, note, rowNote, action, actionLabel, href })
  switch (notice.kind) {
    case 'ready':
      return text(
        i18n.t('updates:app.ready', { version }),
        i18n.t('updates:app.readyNote'),
        i18n.t('updates:app.readyRow'),
        'restart',
        i18n.t('updates:app.restart'),
      )
    case 'available': {
      const note = i18n.t(notice.moves ? 'updates:app.moveNote' : 'updates:app.updateNote')
      return text(
        i18n.t('updates:app.available', { version }),
        note,
        note,
        'update',
        i18n.t('updates:app.update'),
      )
    }
    case 'link': {
      const note = i18n.t('updates:app.downloadNote')
      return text(
        i18n.t('updates:app.available', { version }),
        note,
        note,
        'download',
        i18n.t('updates:app.download'),
        notice.downloadUrl ?? releaseUrl(version),
      )
    }
    case 'updated':
      return text(
        i18n.t('updates:app.updated', { version }),
        i18n.t('updates:app.updatedNote', { version: notice.from }),
        i18n.t('updates:app.updatedNote', { version: notice.from }),
        'whats-new',
        i18n.t('updates:whatsNew'),
        releaseUrl(version),
      )
    case 'downloading':
      return text(
        i18n.t('updates:app.installing'),
        i18n.t('updates:app.downloading', { version }),
        i18n.t('updates:app.downloadingRow', { percent: notice.percent }),
        null,
      )
    case 'moving': {
      const note = i18n.t('updates:app.moving')
      return text(i18n.t('updates:app.installing'), note, note, null)
    }
  }
}
