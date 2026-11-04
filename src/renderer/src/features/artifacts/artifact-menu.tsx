import {
  ExternalLinkIcon,
  FileDownIcon,
  HistoryIcon,
  ImageDownIcon,
  MessageSquareIcon,
  PencilIcon,
  RotateCwIcon,
  ShapesIcon,
  TrashIcon,
  Undo2Icon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NO_SESSION } from '@shared/artifacts'
import { EXPORT_FORMATS, type ArtifactTypeName } from '@shared/artifact-types'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@renderer/components/ui/dropdown-menu'
import { askArtifactDialog, deleteArtifact, restoreArtifact } from '@renderer/stores/artifacts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useHostHas } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { isPublished, useSharingStore } from '@renderer/stores/sharing'
import { openSessionWithArtifact } from '@renderer/stores/view'

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

/**
 * An artifact's menu, the same on its card, in the viewer and in the pane: the copies, renaming,
 * the history and its session, then Delete; in Recently deleted, Restore and Delete permanently.
 */
export function ArtifactMenuItems({
  target,
  onOpen,
  onReload,
  onVersionHistory,
  historyOpen,
  onDeleted,
  onDownloadPng,
}: {
  target: MenuTarget
  onOpen?: () => void
  /** In the viewer, which shows the page live. */
  onReload?: () => void
  onVersionHistory: () => void
  /** Where the history can show beside the artifact, whether it does; Version history checks it. */
  historyOpen?: boolean
  onDeleted?: () => void
  /** Saves the page as an image, where it is a single page a host can render. */
  onDownloadPng?: () => void
}) {
  const { t } = useTranslation('artifacts')
  const session = useSessionsStore((s) =>
    target.sessionId === NO_SESSION ? null : (s.byId[target.sessionId] ?? null),
  )
  // Deleting a published artifact asks first, so the link can be taken down with it.
  const asks = useSharingStore(
    (s) => s.status?.published.some((page) => page.id === target.id) ?? false,
  )
  const failed = (what: string) => (error: unknown) =>
    console.error(`Could not ${what} ${target.id}`, error)
  // A PDF is printed by a desktop app, also for the web client it serves.
  const prints = useHostHas('thumbnails')
  const typed = target.type ?? null

  if (target.deletedAt !== null) {
    return (
      <>
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => void restoreArtifact(target.id).catch(failed('restore'))}
          >
            <Undo2Icon />
            {t('menu.restore')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            variant="destructive"
            onClick={() =>
              askArtifactDialog({
                kind: 'erase',
                id: target.id,
                title: target.title,
                versions: target.versions,
                published: isPublished(target.id),
              })
            }
          >
            <TrashIcon />
            {t('menu.erase')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </>
    )
  }

  return (
    <>
      <DropdownMenuGroup>
        {onOpen && (
          <DropdownMenuItem onClick={onOpen}>
            <ShapesIcon />
            {t('menu.open')}
          </DropdownMenuItem>
        )}
        {onReload && (
          <DropdownMenuItem onClick={onReload}>
            <RotateCwIcon />
            {t('viewer.reload')}
          </DropdownMenuItem>
        )}
        {/* The web client shows it in a browser already; a type's viewer needs Kettu. */}
        {!isWeb && !typed && (
          <DropdownMenuItem
            onClick={() =>
              void window.kettu.artifacts
                .openExternal(target.id, target.version)
                .catch(failed('open in the browser'))
            }
          >
            <ExternalLinkIcon />
            {t('menu.openInBrowser')}
          </DropdownMenuItem>
        )}
        {typed ? (
          EXPORT_FORMATS[typed]
            .filter((format) => format !== 'pdf' || prints)
            .map((format) => {
              // Markdown with pictures is saved as a folder.
              const noFolder = format === 'md' && target.files > 1 && !canSaveFolders()
              return (
                <DropdownMenuItem
                  key={format}
                  disabled={noFolder}
                  onClick={() =>
                    void window.kettu.artifacts
                      .exportAs(target.id, target.version, format)
                      .catch(failed(`export as ${format}`))
                  }
                >
                  <FileDownIcon />
                  {noFolder ? (
                    <span className="flex min-w-0 flex-col">
                      {t(`menu.exportAs.${format}`)}
                      <span className="text-xs text-tertiary">{t('menu.exportNoFolders')}</span>
                    </span>
                  ) : (
                    t(`menu.exportAs.${format}`)
                  )}
                </DropdownMenuItem>
              )
            })
        ) : (
          <DropdownMenuItem
            disabled={target.files > 1 && !canSaveFolders()}
            onClick={() =>
              void window.kettu.artifacts.export(target.id, target.version).catch(failed('export'))
            }
          >
            <FileDownIcon />
            {target.files > 1 && !canSaveFolders() ? (
              <span className="flex min-w-0 flex-col">
                {t('menu.export')}
                <span className="text-xs text-tertiary">{t('menu.exportNoFolders')}</span>
              </span>
            ) : (
              t('menu.export')
            )}
          </DropdownMenuItem>
        )}
        {onDownloadPng && !typed && (
          <DropdownMenuItem onClick={onDownloadPng}>
            <ImageDownIcon />
            {t('canvas.downloadPng')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => askArtifactDialog({ kind: 'rename', id: target.id, title: target.title })}
        >
          <PencilIcon />
          {t('menu.rename')}
        </DropdownMenuItem>
        {historyOpen === undefined ? (
          <DropdownMenuItem onClick={onVersionHistory}>
            <HistoryIcon />
            {t('menu.versionHistory')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuCheckboxItem
            checked={historyOpen}
            onCheckedChange={onVersionHistory}
            closeOnClick
          >
            <HistoryIcon />
            {t('menu.versionHistory')}
          </DropdownMenuCheckboxItem>
        )}
      </DropdownMenuGroup>
      {session && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => openSessionWithArtifact(session.id, session.projectPath, target.id)}
            >
              <MessageSquareIcon />
              {t('menu.openSession')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            if (isPublished(target.id)) {
              askArtifactDialog({ kind: 'delete', id: target.id, title: target.title, onDeleted })
              return
            }
            deleteArtifact(target.id).then(onDeleted, failed('delete'))
          }}
        >
          <TrashIcon />
          {asks ? t('menu.deleteAsk') : t('menu.delete')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  )
}
