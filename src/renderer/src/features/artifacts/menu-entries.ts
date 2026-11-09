import {
  ArrowRight01Icon,
  Clock01Icon,
  Delete02Icon,
  Download04Icon,
  Image01Icon,
  LinkSquare02Icon,
  PencilEdit02Icon,
  RefreshIcon,
  RotateLeft01Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { NO_SESSION } from '@shared/artifacts'
import { EXPORT_FORMATS, type ArtifactTypeName } from '@shared/artifact-types'
import type { MenuItem } from '@renderer/components/affect/app-shell'
import { askArtifactDialog, deleteArtifact, restoreArtifact } from '@renderer/stores/artifacts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useHostHas } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { isPublished, useSharingStore } from '@renderer/stores/sharing'
import { openSessionWithArtifact } from '@renderer/stores/view'
import { removeCard } from './card-dust'

/** Whether this browser can save a folder, which exporting a version of several files needs. */
function canSaveFolders(): boolean {
  return (
    !isWeb ||
    typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  )
}

/** What an artifact's menu acts on. */
export interface MenuTarget {
  id: string
  title: string
  /** The version the copies take: the latest on a card, the one shown in the viewer. */
  version: number
  /** All its versions, for the permanent delete's warning. */
  versions: number
  /** The files of `version`, which a browser without a folder picker cannot export as several. */
  files: number
  sessionId: string
  deletedAt: number | null
  /** The type it was made from, which exports to its own formats; null for a page. */
  type?: ArtifactTypeName | null
}

export interface MenuOptions {
  onOpen?: () => void
  /** In the viewer, which shows the page live. */
  onReload?: () => void
  onVersionHistory: () => void
  /** Where the history can show beside the artifact, whether it does; Version history checks it. */
  historyOpen?: boolean
  onDeleted?: () => void
  /** Saves the page as an image, where it is a single page a host can render. */
  onDownloadPng?: () => void
}

/** One of the menu's actions, drawn by either menu below. */
export interface Entry {
  key: string
  label: string
  /** Why it cannot run, under its label. */
  note?: string
  icon: MenuItem['icon']
  danger?: boolean
  /** A line above it. */
  divider?: boolean
  /** A choice that is on, such as the history shown beside the artifact. */
  checked?: boolean
  disabled?: boolean
  /** Choices that open to the side in the page's menus; each its own item in a context menu. */
  submenu?: Entry[]
  run?: () => void
}

/**
 * An artifact's menu, the same on its card, in the viewer and in the pane: the copies, renaming,
 * the history and its session, then Delete; in Recently deleted, Restore and Delete permanently.
 */
export function useEntries(target: MenuTarget, options: MenuOptions): Entry[] {
  const { t } = useTranslation('artifacts')
  const session = useSessionsStore((s) =>
    target.sessionId === NO_SESSION ? null : (s.byId[target.sessionId] ?? null),
  )
  // Deleting a published artifact asks first, so the link can be taken down with it.
  const asks = useSharingStore(
    (s) => s.status?.published.some((page) => page.id === target.id) ?? false,
  )
  // A PDF is printed by a desktop app, also for the web client it serves.
  const prints = useHostHas('thumbnails')
  const failed = (what: string) => (error: unknown) =>
    console.error(`Could not ${what} ${target.id}`, error)
  const typed = target.type ?? null
  const { onOpen, onReload, onVersionHistory, historyOpen, onDeleted, onDownloadPng } = options

  if (target.deletedAt !== null) {
    return [
      {
        key: 'restore',
        label: t('menu.restore'),
        icon: RotateLeft01Icon,
        run: () => void restoreArtifact(target.id).catch(failed('restore')),
      },
      {
        key: 'erase',
        label: t('menu.erase'),
        icon: Delete02Icon,
        danger: true,
        divider: true,
        run: () =>
          askArtifactDialog({
            kind: 'erase',
            id: target.id,
            title: target.title,
            versions: target.versions,
            published: isPublished(target.id),
          }),
      },
    ]
  }

  const noFolder = target.files > 1 && !canSaveFolders()
  const exports: Entry[] = typed
    ? EXPORT_FORMATS[typed]
        .filter((format) => format !== 'pdf' || prints)
        .map((format) => {
          // Markdown with pictures is saved as a folder.
          const blocked = format === 'md' && noFolder
          return {
            key: `export-${format}`,
            label: t(`menu.exportAs.${format}`),
            note: blocked ? t('menu.exportNoFolders') : undefined,
            icon: Download04Icon,
            disabled: blocked,
            run: () =>
              void window.kettu.artifacts
                .exportAs(target.id, target.version, format)
                .catch(failed(`export as ${format}`)),
          }
        })
    : [
        {
          key: 'export',
          label: t('menu.export'),
          note: noFolder ? t('menu.exportNoFolders') : undefined,
          icon: Download04Icon,
          disabled: noFolder,
          run: () =>
            void window.kettu.artifacts.export(target.id, target.version).catch(failed('export')),
        },
      ]
  const entries: Entry[] = []
  if (onOpen) entries.push({ key: 'open', label: t('menu.open'), icon: ViewIcon, run: onOpen })
  if (onReload) {
    entries.push({ key: 'reload', label: t('viewer.reload'), icon: RefreshIcon, run: onReload })
  }
  // The web client shows it in a browser already; a type's viewer needs Kettu.
  if (!isWeb && !typed) {
    entries.push({
      key: 'browser',
      label: t('menu.openInBrowser'),
      icon: LinkSquare02Icon,
      run: () =>
        void window.kettu.artifacts
          .openExternal(target.id, target.version)
          .catch(failed('open in the browser')),
    })
  }
  entries.push(
    exports.length > 1
      ? {
          key: 'export',
          label: t('menu.exportTo'),
          icon: Download04Icon,
          divider: true,
          submenu: exports,
        }
      : { ...exports[0]!, divider: true },
  )
  if (onDownloadPng && !typed) {
    entries.push({
      key: 'png',
      label: t('canvas.downloadPng'),
      icon: Image01Icon,
      run: onDownloadPng,
    })
  }
  entries.push(
    {
      key: 'rename',
      label: t('menu.rename'),
      icon: PencilEdit02Icon,
      run: () => askArtifactDialog({ kind: 'rename', id: target.id, title: target.title }),
    },
    {
      key: 'history',
      label: t('menu.versionHistory'),
      icon: Clock01Icon,
      checked: historyOpen,
      run: onVersionHistory,
    },
  )
  if (session) {
    entries.push({
      key: 'session',
      label: t('menu.openSession'),
      icon: ArrowRight01Icon,
      run: () => openSessionWithArtifact(session.id, session.projectPath, target.id),
    })
  }
  entries.push({
    key: 'delete',
    label: asks ? t('menu.deleteAsk') : t('menu.delete'),
    icon: Delete02Icon,
    danger: true,
    divider: true,
    run: () => {
      if (isPublished(target.id)) {
        askArtifactDialog({ kind: 'delete', id: target.id, title: target.title, onDeleted })
        return
      }
      removeCard(target.id, () => deleteArtifact(target.id)).then(onDeleted, failed('delete'))
    },
  })
  return entries
}

/** The menu as affectUI's menu items, for a Dropdown on a card or in a bar. */
export function useArtifactMenu(target: MenuTarget, options: MenuOptions): MenuItem[] {
  const toItem = (entry: Entry): MenuItem => ({
    label: entry.label,
    description: entry.note,
    icon: entry.icon,
    danger: entry.danger,
    divider: entry.divider,
    checked: entry.checked,
    submenu: entry.submenu?.map(toItem),
    // A blocked choice stays listed with its reason.
    disabled: entry.disabled,
    onSelect: entry.run,
  })
  return useEntries(target, options).map(toItem)
}
