import { useContext, useState, type ReactNode } from 'react'
import { ArrowDownToLineIcon, FolderIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MediaGrant } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { fileType, REASONS, type CardReason } from './layout'
import { insideProject, revealFileAction } from './show-file'

/**
 * A file in a reply that shows no preview: its type tile, its name, a line of what is known of it
 * and the ways to it. `danger` sets that line in red, for a failure.
 */
export function FileCard({
  name,
  type,
  meta,
  danger = false,
  title,
  actions,
}: {
  name: string
  /** The tile's word, such as CSV; null shows the file's icon instead. */
  type: string | null
  meta: ReactNode
  danger?: boolean
  /** The full path, or what else the card's name stands for. */
  title?: string
  actions?: ReactNode
}) {
  return (
    <span className="flex w-full min-w-0 items-center gap-3 rounded-code px-3 py-2.5 text-left shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]">
      <span
        aria-hidden
        className={cn(
          'flex h-10 w-8.5 shrink-0 justify-center rounded-md bg-subtle shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
          type ? 'items-end pb-1.25 text-file-type font-bold text-secondary' : 'items-center',
        )}
      >
        {type ?? <FileTypeIcon path={name} className="size-4" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span title={title} className="truncate text-file text-primary">
          {name}
        </span>
        <span className={cn('truncate text-meta', danger ? 'text-danger' : 'text-tertiary')}>
          {meta}
        </span>
      </span>
      {actions && <span className="flex shrink-0 items-center">{actions}</span>}
    </span>
  )
}

/** One of a file card's 28 px icon buttons, named by its tooltip. */
export function FileCardButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
            className="text-tertiary"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A media file the thread names that shows no preview, as a file card: its size, why, and whether
 * it is in the project, with Show in the file manager and Download.
 */
export function MediaFileCard({
  path,
  name,
  grant,
  reason,
}: {
  path: string
  name: string
  grant: MediaGrant
  reason: CardReason
}) {
  const { t } = useTranslation('session')
  const projectPath = useContext(ProjectPathContext)
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  const show = revealFileAction(path, projectPath, grant.url)
  const meta = [
    bytes(grant.size),
    t(REASONS[reason]),
    insideProject(path, projectPath) && t('media.inProject'),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <FileCard
      name={name}
      title={path}
      type={fileType(name, grant.mimeType)}
      meta={error ?? meta}
      danger={error !== null}
      actions={
        <>
          {show && (
            <FileCardButton
              label={
                show.inFiles
                  ? t('media.showInFiles')
                  : t('media.showIn', { name: fileManagerName() })
              }
              onClick={() => run(show.show)}
            >
              <FolderIcon className="size-3.5" />
            </FileCardButton>
          )}
          <FileCardButton
            label={t('media.download')}
            onClick={() => run(() => window.kettu.media.saveAs(grant.url))}
          >
            <ArrowDownToLineIcon className="size-3.5" />
          </FileCardButton>
        </>
      }
    />
  )
}
