import type { MouseEvent } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@renderer/components/ui/spinner'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { folderOf } from '@renderer/features/files/paths'
import { cn } from '@renderer/lib/utils'
import type { MentionRow } from './mentions'
import type { MentionList } from './use-mention-list'

/** A mention's row: the type icon, the name with its matched characters marked, then the folder. */
export function MentionItem({
  row,
  onChoose,
}: {
  row: MentionRow
  onChoose: (row: MentionRow) => void
}) {
  const nameStart = row.path.lastIndexOf('/') + 1
  const name = row.path.slice(nameStart)
  const marked = new Set(row.positions)
  const folder = folderOf(row.path)
  return (
    <Autocomplete.Item
      value={row}
      // The composer writes the name and adds the file; Base UI would put the row in the text.
      onClick={(event: MouseEvent & { preventBaseUIHandler?: () => void }) => {
        event.preventBaseUIHandler?.()
        onChoose(row)
      }}
      title={row.folder ? `${row.path}/` : row.path}
      className="flex min-h-row cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-ui outline-none select-none data-highlighted:bg-accent"
    >
      <FileTypeIcon path={row.path} folder={row.folder} className="size-4 shrink-0" />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0">
          {[...name].map((char, i) =>
            marked.has(nameStart + i) ? (
              <mark key={i} className="rounded-xs bg-mark text-primary">
                {char}
              </mark>
            ) : (
              char
            ),
          )}
          {row.folder && '/'}
        </span>
        {folder && <span className="truncate text-xs text-tertiary">{folder}</span>}
      </span>
    </Autocomplete.Item>
  )
}

/** The label over the rows when they are the files the session used. */
export function MentionHeader({ id }: { id: string }) {
  const { t } = useTranslation('composer')
  return (
    <div id={id} className="shrink-0 px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
      {t('mentions.used')}
    </div>
  )
}

/** The line under the rows: how many files there are to search, or why there are none yet. */
export function MentionFooter({ list }: { list: MentionList }) {
  const { t } = useTranslation('composer')
  const { files } = list
  let line
  if (!files) {
    line = (
      <span className="flex items-center gap-2">
        <Spinner className="size-3.5" />
        {t('mentions.loading')}
      </span>
    )
  } else if (files.error && files.paths.length === 0) {
    line = <span className="text-danger">{files.error}</span>
  } else if (list.used) {
    line = t('mentions.toSearch', { count: files.paths.length })
  } else {
    return null
  }
  return (
    <p
      className={cn(
        'shrink-0 px-3 py-2 text-xs text-tertiary',
        list.rows.length > 0 && 'border-t border-subtle',
      )}
    >
      {line}
    </p>
  )
}
