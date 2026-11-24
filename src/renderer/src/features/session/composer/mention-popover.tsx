import { File01Icon, Folder01Icon } from '@hugeicons/core-free-icons'
import { Glyph } from '@renderer/features/shell/glyph'
import { useTranslation } from 'react-i18next'
import { pluginText } from '@shared/plugins'
import { Spinner } from '@renderer/components/ui/spinner'
import { VIEW_ICONS } from '@renderer/features/plugin-views/icons'
import { PluginMark } from '@renderer/features/plugin-views/plugin-mark'
import { cn } from '@renderer/lib/utils'
import { markedRuns, type MentionRow } from './mentions'
import type { MentionList } from './use-mention-list'
import type { PluginMentionGroup, PluginRow } from './use-plugin-mentions'

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
  const icon = row.folder ? Folder01Icon : File01Icon
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
      <Glyph icon={icon} className="size-3.75 shrink-0 text-icon" />
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

/** A plugin source's heading in the list: the plugin's mark and the source's name. */
export function PluginGroupHeading({ id, group }: { id: string; group: PluginMentionGroup }) {
  const { i18n } = useTranslation('composer')
  const { source, decl } = group
  return (
    <div
      id={id}
      className="flex h-6.5 shrink-0 items-center gap-2 px-2 text-small font-medium text-tertiary"
    >
      <PluginMark source={source} />
      <span className="min-w-0 truncate">
        {pluginText(decl.title, source.title, i18n.language)}
      </span>
      {group.searching && group.items.length > 0 && <Spinner className="size-3 shrink-0" />}
    </div>
  )
}

/** What a plugin source says while it has no items: that it is searching, or why it failed. */
export function PluginGroupNote({ group }: { group: PluginMentionGroup }) {
  const { t } = useTranslation('composer')
  if (group.error) {
    const { code, detail } = group.error
    return (
      <p className="px-2 pb-1.5 text-small text-danger" title={detail}>
        {t(`mentions.pluginError.${code}`)}
        {detail && (
          <span className="mt-0.5 line-clamp-3 font-mono text-hint break-words text-tertiary">
            {detail}
          </span>
        )}
      </p>
    )
  }
  if (!group.searching) return null
  return (
    <p className="flex items-center gap-2 px-2 pb-1.5 text-small text-tertiary">
      <Spinner className="size-3.5" />
      {t('mentions.pluginSearching')}
    </p>
  )
}

/** An item of a plugin's: its icon, its title, what the plugin says under it, and its figure. */
export function PluginItem({
  id,
  row,
  group,
  highlighted,
  onHighlight,
  onChoose,
}: {
  id: string
  row: PluginRow
  group: PluginMentionGroup
  highlighted: boolean
  onHighlight: () => void
  onChoose: (row: PluginRow) => void
}) {
  const { item } = row
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
      title={item.subtitle ? `${item.title}\n${item.subtitle}` : item.title}
      className="flex min-h-7.5 cursor-default items-center gap-2.25 rounded-md px-2 text-menu outline-none select-none data-highlighted:bg-selected"
    >
      <Glyph
        icon={VIEW_ICONS[item.icon ?? group.decl.icon ?? 'tag']}
        className="size-3.75 shrink-0 text-icon"
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-primary">{item.title}</span>
        {item.subtitle && (
          <span className="pl-2 font-mono text-hint text-tertiary">{item.subtitle}</span>
        )}
      </span>
      {item.end && <span className="shrink-0 pl-3 text-hint text-tertiary">{item.end}</span>}
    </div>
  )
}

/**
 * The line under the rows: the keys while there are rows to choose, else how many files there are
 * to search or why there are none yet. `more` counts the rows of plugins, which the keys serve too.
 */
export function MentionFooter({ list, more = 0 }: { list: MentionList; more?: number }) {
  const { t } = useTranslation('composer')
  const { files } = list
  let line
  if (list.rows.length + more > 0) {
    line = (
      <span className="flex gap-3">
        <span>{t('mentions.keysMove')}</span>
        <span>{t('mentions.keysInsert')}</span>
        {list.rows.some((row) => row.folder) && <span>{t('mentions.keysFolder')}</span>}
      </span>
    )
  } else if (list.noProject) {
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
  } else if (list.used) {
    line = t('mentions.toSearch', { count: files.paths.length })
  } else {
    return null
  }
  return (
    <p
      className={cn(
        'shrink-0 px-3 pt-1 pb-1.5 text-small text-tertiary',
        list.rows.length + more > 0 && 'mx-1 border-t border-subtle pt-1.5',
      )}
    >
      {line}
    </p>
  )
}
