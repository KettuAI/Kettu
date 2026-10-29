import {
  ExternalLinkIcon,
  FileDownIcon,
  HistoryIcon,
  MessageSquareIcon,
  PencilIcon,
  ShapesIcon,
  TrashIcon,
  Undo2Icon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NO_SESSION } from '@shared/artifacts'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@renderer/components/ui/dropdown-menu'
import { askArtifactDialog, deleteArtifact, restoreArtifact } from '@renderer/stores/artifacts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { isPublished, useSharingStore } from '@renderer/stores/sharing'
import { openSessionWithArtifact } from '@renderer/stores/view'

/** What an artifact's menu acts on. */
export interface MenuTarget {
  id: string
  title: string
  /** The version the copies take: the latest on a card, the one shown in the viewer. */
  version: number
  /** All its versions, for the permanent delete's warning. */
  versions: number
  sessionId: string
  deletedAt: number | null
}

/**
 * An artifact's menu, the same on its card, in the viewer and in the pane: the copies, renaming,
 * the history and its session, then Delete; in Recently deleted, Restore and Delete permanently.
 */
export function ArtifactMenuItems({
  target,
  onOpen,
  onVersionHistory,
  historyOpen,
  onDeleted,
}: {
  target: MenuTarget
  onOpen?: () => void
  onVersionHistory: () => void
  /** Where the history can show beside the artifact, whether it does; Version history checks it. */
  historyOpen?: boolean
  onDeleted?: () => void
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
        <DropdownMenuItem
          onClick={() =>
            void window.kettu.artifacts.export(target.id, target.version).catch(failed('export'))
          }
        >
          <FileDownIcon />
          {t('menu.export')}
        </DropdownMenuItem>
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
