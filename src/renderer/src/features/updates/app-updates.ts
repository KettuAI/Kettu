import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { i18n } from '@renderer/lib/i18n'

/** The app's update notice, shown only when there is something to do. */
export type AppUpdateNotice =
  | { kind: 'ready'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'link'; version: string; downloadUrl: string | null }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'updated'; version: string; from: string }

export function appUpdateNotice(
  status: UpdateStatus | null,
  updatedSeen: boolean,
): AppUpdateNotice | null {
  if (!status) return null
  const { state } = status
  if (state.kind === 'downloading' && state.manual && status.dismissed !== state.version)
    return { kind: 'downloading', version: state.version, percent: state.percent }
  if (state.kind === 'ready' && status.dismissed !== state.version)
    return { kind: 'ready', version: state.version }
  if (state.kind === 'available' && status.dismissed !== state.version) {
    return state.mode === 'install'
      ? { kind: 'available', version: state.version }
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
  /** The second line; null while downloading, when the progress bar is the second line. */
  detail: string | null
  action: AppUpdateAction
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
  ): AppUpdateRow => ({
    words,
    versionFirst,
    label: versionFirst ? `${notice.version} ${words}` : `${words} ${notice.version}`,
    detail,
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
      )
    case 'available':
      return row(
        i18n.t('updates:notice.available'),
        true,
        i18n.t('updates:notice.updateDetail'),
        'update',
        i18n.t('updates:notice.update'),
      )
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
