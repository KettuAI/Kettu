// What a task delivered, as rows of links that open: its pull requests with their state, the
// documents its steps handed in, and the files and links they handed over.

import { File01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TaskDeliverable } from '@shared/workflow'
import { parseFileRef } from '@renderer/features/files/file-refs'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { nameOf } from '@renderer/features/files/paths'
import { ConfirmedLink } from '@renderer/features/session/link-confirm'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { openFile } from '@renderer/stores/files'
import { openArtifactTab } from '@renderer/stores/view'

function deliverableKey(item: TaskDeliverable): string {
  switch (item.kind) {
    case 'pull_request':
    case 'link':
      return `${item.kind}:${item.url}`
    case 'document':
      return `document:${item.artifactId}`
    case 'file':
      return `file:${item.path}`
  }
}

/**
 * The rows, each opening where it lives: a pull request or link as the thread's links do, a
 * document beside the page in `panel`, a file of `projectPath` in the Files pane, and any other in
 * the system's file manager, on this computer only. `projectPath` is null where no Files pane is.
 */
export function DeliverableRows({
  deliverables,
  panel,
  projectPath,
  local,
  className,
}: {
  deliverables: TaskDeliverable[]
  panel: string
  projectPath: string | null
  local: boolean
  className?: string
}) {
  if (deliverables.length === 0) return null
  return (
    <ul className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {deliverables.map((item) => (
        <li key={deliverableKey(item)} className="min-w-0 text-small text-(--thread-text)">
          <Row item={item} panel={panel} projectPath={projectPath} local={local} />
        </li>
      ))}
    </ul>
  )
}

function Row({
  item,
  panel,
  projectPath,
  local,
}: {
  item: TaskDeliverable
  panel: string
  projectPath: string | null
  local: boolean
}) {
  const { t } = useTranslation('tasks')
  switch (item.kind) {
    case 'pull_request':
      return <ConfirmedLink url={item.url} />
    case 'link':
      return (
        <>
          <ConfirmedLink url={item.url}>{item.title}</ConfirmedLink>
          <Detail text={item.detail} />
        </>
      )
    case 'document':
      return (
        <>
          <button
            type="button"
            className="text-left"
            onClick={() => openArtifactTab(panel, item.artifactId, { preview: true })}
          >
            <span className="thread-link">
              <Glyph
                icon={File01Icon}
                size={14}
                className="relative -top-[1.5px] mr-1.5 inline-block align-middle"
              />
              {item.title}
            </span>
          </button>
          <Detail text={t('deliverables.version', { version: item.version })} />
        </>
      )
    case 'file': {
      const inside = projectPath ? parseFileRef(item.path, projectPath, true) : null
      const open =
        projectPath && inside
          ? () => openFile(projectPath, inside.path, null, { preview: true })
          : local
            ? () => void window.kettu.shell.showItem(item.path)
            : null
      const label = (
        <>
          <FileTypeIcon
            path={item.path}
            className="relative -top-[1.5px] mr-1.5 inline-block size-4 align-middle"
          />
          {item.title}
        </>
      )
      return (
        <>
          {open ? (
            <button type="button" title={item.path} className="text-left" onClick={open}>
              <span className="thread-link">{label}</span>
            </button>
          ) : (
            <span title={item.path}>{label}</span>
          )}
          <Detail
            text={item.detail ?? (nameOf(item.path) === item.title ? null : nameOf(item.path))}
          />
        </>
      )
    }
  }
}

function Detail({ text }: { text: string | null }) {
  if (!text) return null
  return <span className="text-(--thread-faint)"> · {text}</span>
}
