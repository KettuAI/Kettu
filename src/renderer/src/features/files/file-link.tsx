import { FolderOpenIcon, Link01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { fileManagerName, isWeb } from '@renderer/lib/platform'
import { openFile } from '@renderer/stores/files'
import { FileTypeIcon } from './file-type-icon'
import type { AgentFileRef, FileRef } from './file-refs'
import { hostFilePath } from './operations'
import { nameOf } from './paths'

/**
 * The chip both kinds of file reference draw, like the thread's links: the file's icon and name
 * over one line, with the path in its tooltip. A right click offers to show the file in the file
 * manager, which only this computer's files can be, and to copy its path.
 */
function FileChip({
  path,
  line,
  projectPath,
  hostFile,
  onOpen,
}: {
  path: string
  line: number | null
  projectPath: string
  /** The file's path as its host writes it. */
  hostFile: string
  onOpen: () => void
}) {
  const { t } = useTranslation('files')
  const target = line ? `${path}:${line}` : path
  const local = !isWeb && hostOfPath(projectPath) === null
  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="select-auto"
        render={
          <button
            type="button"
            data-file-ref=""
            title={target}
            aria-label={t('link.open', { target })}
            onClick={onOpen}
          />
        }
      >
        {/* A button lays out as an inline block, so the line is drawn by an inline span inside it,
            at the same depth as a link's. */}
        <span className="thread-link">
          <FileTypeIcon
            path={path}
            className="relative -top-[1.5px] mr-1.5 inline-block size-4 align-middle"
          />
          {nameOf(path)}
          {line && <span className="text-tertiary">:{line}</span>}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-56">
        {local && (
          <ContextMenuItem
            onClick={() =>
              void window.kettu.shell
                .showItem(hostFile)
                .catch((failure: unknown) => toast(errorMessage(failure)))
            }
          >
            <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={1.9} aria-hidden />
            {t('preview.showIn', { name: fileManagerName() })}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() =>
            void navigator.clipboard.writeText(hostFile).then(
              () => toast(t('tree.copiedPath', { count: 1 })),
              (failure: unknown) => toast(errorMessage(failure)),
            )
          }
        >
          <HugeiconsIcon icon={Link01Icon} strokeWidth={1.9} aria-hidden />
          {t('tree.copyPath')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * A file reference in a reply, drawn like the thread's links: the file's icon and name over one
 * line, with the path in its tooltip. It opens the file in the Files pane at its line.
 */
export function FileLink({ file }: { file: FileRef & { projectPath: string } }) {
  return (
    <FileChip
      path={file.path}
      line={file.line}
      projectPath={file.projectPath}
      hostFile={hostFilePath(file.projectPath, file.path)}
      onOpen={() => openFile(file.projectPath, file.path, file.line, { preview: true })}
    />
  )
}

/** A link to a file of the session agent's own folder, drawn the same; it opens read-only. */
export function AgentFileLink({ file }: { file: AgentFileRef }) {
  return (
    <FileChip
      path={file.path}
      line={file.line}
      projectPath={file.projectPath}
      hostFile={file.path}
      onOpen={() =>
        openFile(file.projectPath, file.path, file.line, {
          preview: true,
          agent: { sessionId: file.sessionId, agentId: file.agentId },
        })
      }
    />
  )
}
