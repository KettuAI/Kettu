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

export type AppUpdateAction = 'restart' | 'update' | 'download' | 'cancel' | 'whats-new'

export interface AppUpdateRow {
  /** The first line's words beside the version. */
  words: string
  /** The version comes first, as in "0.3.0 is out". */
  versionFirst: boolean
  /** The first line as one string, for names and lists. */
  label: string
  /** The card's tooltip; null while downloading, when the progress bar is the second line. */
  detail: string | null
  /** A short second line on the card, saying what clicking it does. */
  note: string | null
  /** Null while the app moves, which nothing can stop. */
  action: AppUpdateAction | null
  actionLabel: string
  /** The page an action opens in the browser. */
  href: string | null
  /** A download in progress is cancelled, not dismissed. */
  dismissible: boolean
}

/** The update row's lines and action in each state. */
export function appUpdateRow(notice: AppUpdateNotice): AppUpdateRow {
  const row = (
    words: string,
    versionFirst: boolean,
    detail: string | null,
    action: AppUpdateAction,
    actionLabel: string,
    href: string | null = null,
    note: string | null = null,
  ): AppUpdateRow => ({
    words,
    versionFirst,
    label: versionFirst ? `${notice.version} ${words}` : `${words} ${notice.version}`,
    detail,
    note,
    action,
    actionLabel,
    href,
    dismissible: action !== 'cancel',
  })
  switch (notice.kind) {
    case 'ready':
      return row(
        i18n.t('updates:notice.ready'),
        false,
        i18n.t('updates:notice.readyDetail'),
        'restart',
        i18n.t('updates:notice.restart'),
        null,
        i18n.t('updates:notice.readyNote'),
      )
    case 'available':
      return row(
        i18n.t('updates:notice.available'),
        true,
        notice.moves ? i18n.t('updates:notice.moveDetail') : i18n.t('updates:notice.updateDetail'),
        'update',
        i18n.t('updates:notice.update'),
        null,
        i18n.t(notice.moves ? 'updates:notice.moveNote' : 'updates:notice.updateNote'),
      )
    case 'moving': {
      // The app moves, not the version, so the words stand alone.
      const words = i18n.t('updates:notice.moving')
      return {
        words,
        versionFirst: false,
        label: words,
        detail: null,
        note: null,
        action: null,
        actionLabel: '',
        href: null,
        dismissible: false,
      }
    }
    case 'link':
      return row(
        i18n.t('updates:notice.available'),
        true,
        i18n.t('updates:notice.downloadDetail'),
        'download',
        i18n.t('updates:notice.download'),
        notice.downloadUrl ?? releaseUrl(notice.version),
      )
    case 'downloading':
      return row(
        i18n.t('updates:notice.downloading'),
        false,
        null,
        'cancel',
        i18n.t('updates:notice.cancel'),
      )
    case 'updated':
      return row(
        i18n.t('updates:notice.updatedTo'),
        false,
        i18n.t('updates:notice.updatedDetail', { version: notice.from }),
        'whats-new',
        i18n.t('updates:notice.whatsNew'),
        releaseUrl(notice.version),
      )
  }
}

/** What clicking the card does: the row's own action, except a cancel, which is the corner's. */
export function cardAction(row: AppUpdateRow): AppUpdateAction | null {
  return row.action === 'cancel' ? null : row.action
}
