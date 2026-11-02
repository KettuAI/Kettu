import { FileIcon, FolderIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { markedRuns, type MentionRow } from './mentions'
import type { MentionList } from './use-mention-list'

/** A run of a path, with what the query matched in it in the fox tint. */
function Runs({ text, offset, positions }: { text: string; offset: number; positions: number[] }) {
  return markedRuns(text, offset, positions).map((run, i) =>
    run.marked ? (
      <mark key={i} className="rounded-xs bg-match text-primary">
        {run.text}
      </mark>
    ) : (
      run.text
    ),
  )
}

/** A mention's row: the type icon, then the path, its folders quiet and its matches tinted. */
export function MentionItem({
  id,
  row,
  highlighted,
  onHighlight,
  onChoose,
}: {
  id: string
  row: MentionRow
  highlighted: boolean
  onHighlight: () => void
  onChoose: (row: MentionRow) => void
}) {
  const { t } = useTranslation('composer')
  const nameStart = row.path.lastIndexOf('/') + 1
  const Icon = row.folder ? FolderIcon : FileIcon
  return (
    <div
      role="option"
      id={id}
      aria-selected={highlighted}
      data-highlighted={highlighted ? '' : undefined}
      // Pressing a row keeps the focus, and with it the caret, in the box.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHighlight}
      onClick={() => onChoose(row)}
      title={row.folder ? `${row.path}/` : row.path}
      className="flex min-h-7.5 cursor-default items-center gap-2.25 rounded-md px-2 text-menu outline-none select-none data-highlighted:bg-selected"
    >
      <Icon strokeWidth={1.4} className="size-3.75 shrink-0 text-icon" />
      <span className="min-w-0 flex-1 truncate font-mono text-hint">
        <span className="text-tertiary">
          <Runs text={row.path.slice(0, nameStart)} offset={0} positions={row.positions} />
        </span>
        <Runs text={row.path.slice(nameStart)} offset={nameStart} positions={row.positions} />
        {row.folder && '/'}
      </span>
      {row.folder && (
        <span className="shrink-0 pl-4 text-hint text-tertiary">{t('mentions.folder')}</span>
      )}
    </div>
  )
}

/**
 * The line under the rows: the keys while there are rows to choose, else how many files there are
 * to search or why there are none yet.
 */
export function MentionFooter({ list }: { list: MentionList }) {
  const { t } = useTranslation('composer')
  const { files } = list
  let line
  if (list.noProject) {
    line = t('mentions.chooseProject')
  } else if (!files) {
    line = (
      <span className="flex items-center gap-2">
        <Spinner className="size-3.5" />
        {t('mentions.loading')}
      </span>
    )
  } else if (files.error && files.paths.length === 0) {
    line = <span className="text-danger">{files.error}</span>
  } else if (list.rows.length > 0) {
    line = (
      <span className="flex gap-3">
        <span>{t('mentions.keysMove')}</span>
        <span>{t('mentions.keysInsert')}</span>
        {list.rows.some((row) => row.folder) && <span>{t('mentions.keysFolder')}</span>}
      </span>
    )
  } else if (list.used) {
    line = t('mentions.toSearch', { count: files.paths.length })
  } else {
    return null
  }
  return (
    <p
      className={cn(
        'shrink-0 px-3 pt-1 pb-1.5 text-small text-tertiary',
        list.rows.length > 0 && 'mx-1 border-t border-subtle pt-1.5',
      )}
    >
      {line}
    </p>
  )
}
