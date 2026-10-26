import { useContext, useState, type ReactNode } from 'react'
import { FileDownIcon, FolderIcon, Maximize2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MediaGrant } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { bytes as formatBytes, clock } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { saveCarried, type PlayedMedia } from './carried'
import { showFileAction } from './show-file'

/**
 * The row under a clip or a sound: its type icon, name, length and size, then on hover or focus
 * Open larger, for a clip, and Show in Files or the file manager, or Save as… for carried bytes,
 * which have no file to show.
 */
export function MediaCaption({
  media,
  name,
  seconds,
  onOpenLarger,
}: {
  media: PlayedMedia
  name: string
  seconds: number | null
  onOpenLarger?: () => void
}) {
  const { t } = useTranslation('session')
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  const meta = [seconds !== null && Number.isFinite(seconds) ? clock(seconds) : null]
    .concat(formatBytes(media.kind === 'file' ? media.grant.size : media.size))
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="mt-1.5 flex h-6 min-w-0 items-center gap-1.5 text-small">
      <FileTypeIcon path={name} className="size-3 shrink-0" />
      <span
        className="min-w-0 truncate text-muted-foreground"
        title={media.kind === 'file' ? media.path : name}
      >
        {name}
      </span>
      <span className="shrink-0 text-meta text-tertiary tabular">{meta}</span>
      {error && <span className="min-w-0 truncate text-meta text-danger">{error}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/media:opacity-100 group-hover/media:opacity-100">
        {onOpenLarger && (
          <CaptionButton label={t('media.openLarger')} onClick={onOpenLarger}>
            <Maximize2Icon />
          </CaptionButton>
        )}
        {media.kind === 'file' ? (
          <ShowFileButton path={media.path} grant={media.grant} run={run} />
        ) : (
          <CaptionButton
            label={t('media.saveAs')}
            onClick={() => run(() => saveCarried(media.mimeType, media.data, name))}
          >
            <FileDownIcon />
          </CaptionButton>
        )}
      </span>
    </span>
  )
}

/** Shows a project file in the Files pane, any other in the file manager. */
function ShowFileButton({
  path,
  grant,
  run,
}: {
  path: string
  grant: MediaGrant
  run: (action: () => Promise<unknown>) => void
}) {
  const { t } = useTranslation('session')
  const projectPath = useContext(ProjectPathContext)
  const action = showFileAction(path, projectPath, grant.url)
  return (
    <CaptionButton
      label={
        action.inFiles ? t('media.showInFiles') : t('media.showIn', { name: fileManagerName() })
      }
      onClick={() => run(action.show)}
    >
      <FolderIcon />
    </CaptionButton>
  )
}

function CaptionButton({
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
        render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
