import { useContext, useState, type ReactNode } from 'react'
import { FolderIcon, Maximize2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MediaGrant } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { parseFileRef, ProjectPathContext } from '@renderer/features/files/file-refs'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { bytes as formatBytes, clock } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { openFile } from '@renderer/stores/files'

/** Shows a project file in the Files pane, any other in the file manager. */
function useShowFile(path: string, grant: MediaGrant) {
  const { t } = useTranslation('session')
  const projectPath = useContext(ProjectPathContext)
  const ref = projectPath ? parseFileRef(path, projectPath) : null
  return {
    label: ref ? t('media.showInFiles') : t('media.showIn', { name: fileManagerName() }),
    show: (): Promise<void> => {
      if (ref && projectPath) {
        openFile(projectPath, ref.path)
        return Promise.resolve()
      }
      return window.overbench.media.reveal(grant.url)
    },
  }
}

/**
 * The row under a clip or a sound: its type icon, name, length and size, then on hover or focus
 * Open larger, for a clip, and Show in Files or the file manager.
 */
export function MediaCaption({
  path,
  name,
  grant,
  seconds,
  onOpenLarger,
}: {
  path: string
  name: string
  grant: MediaGrant
  seconds: number | null
  onOpenLarger?: () => void
}) {
  const { t } = useTranslation('session')
  const showFile = useShowFile(path, grant)
  const [error, setError] = useState<string | null>(null)
  const meta = [seconds !== null && Number.isFinite(seconds) ? clock(seconds) : null]
    .concat(formatBytes(grant.size))
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="mt-1.5 flex h-6 min-w-0 items-center gap-1.5 text-small">
      <FileTypeIcon path={name} className="size-3 shrink-0" />
      <span className="min-w-0 truncate text-muted-foreground" title={path}>
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
        <CaptionButton
          label={showFile.label}
          onClick={() => {
            setError(null)
            showFile.show().catch((e: unknown) => setError(errorMessage(e)))
          }}
        >
          <FolderIcon />
        </CaptionButton>
      </span>
    </span>
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
