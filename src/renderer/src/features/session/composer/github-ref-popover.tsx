import { useTranslation } from 'react-i18next'
import { Spinner } from '@renderer/components/ui/spinner'
import { RepositoryReferenceIcon } from '@renderer/features/git/gh-reference'
import { cn } from '@renderer/lib/utils'
import type { GitHubRefRow } from './github-picker'
import { markedRuns } from './mentions'
import type { GitHubRefPickerState } from './use-github-ref-picker'

function HighlightedText({ text, positions }: { text: string; positions: readonly number[] }) {
  if (positions.length === 0) return text
  return markedRuns(text, 0, positions).map((run, i) =>
    run.marked ? (
      <mark key={i} className="rounded-xs bg-match text-primary">
        {run.text}
      </mark>
    ) : (
      run.text
    ),
  )
}

/** One GitHub issue or pull request row in the `#` picker popover. */
export function GitHubRefItem({
  id,
  row,
  highlighted,
  onHighlight,
  onChoose,
}: {
  id: string
  row: GitHubRefRow
  highlighted: boolean
  onHighlight: () => void
  onChoose: (row: GitHubRefRow) => void
}) {
  const { item } = row
  const numberLabel = `#${item.number}`
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
      title={`${numberLabel} ${item.title}`}
      className="flex min-h-7.5 cursor-default items-center gap-2 rounded-md px-2 text-menu outline-none select-none data-highlighted:bg-selected"
    >
      <RepositoryReferenceIcon item={item} size={14} />
      <span className="shrink-0 font-mono text-hint font-medium text-secondary tabular">
        <HighlightedText text={numberLabel} positions={row.numberMatches} />
      </span>
      <span className="min-w-0 flex-1 truncate text-primary">
        <HighlightedText text={item.title} positions={row.titleMatches} />
      </span>
    </div>
  )
}

/** Header line for the `#` picker showing the linked `owner/repo` and live search spinner. */
export function GitHubRefHeading({ id, picker }: { id: string; picker: GitHubRefPickerState }) {
  const { t } = useTranslation('composer')
  return (
    <div
      id={id}
      className="flex h-6.5 shrink-0 items-center justify-between gap-2 px-2 text-small font-medium text-tertiary"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">{t('githubRefs.heading')}</span>
        {picker.repo && (
          <span className="min-w-0 truncate font-mono text-hint font-normal">
            {picker.repo.owner}/{picker.repo.repo}
          </span>
        )}
      </span>
      {(picker.loading || picker.searching) && picker.rows.length > 0 && (
        <Spinner className="size-3 shrink-0" />
      )}
    </div>
  )
}

/** Footer line for the `#` picker: keyboard hints while rows exist, or loading/empty/gh guidance. */
export function GitHubRefFooter({ picker }: { picker: GitHubRefPickerState }) {
  const { t } = useTranslation('composer')
  let line
  if (picker.rows.length > 0) {
    line = (
      <span className="flex gap-3">
        <span>{t('mentions.keysMove')}</span>
        <span>{t('mentions.keysInsert')}</span>
        <span>{t('githubRefs.keysClose')}</span>
      </span>
    )
  } else if (picker.loading || picker.searching) {
    line = (
      <span className="flex items-center gap-2">
        <Spinner className="size-3.5" />
        {t(picker.hasQuery ? 'githubRefs.searching' : 'githubRefs.loading')}
      </span>
    )
  } else if (picker.unavailable === 'gh-missing') {
    line = t('githubRefs.ghMissing')
  } else if (picker.unavailable === 'gh-signed-out') {
    line = t('githubRefs.ghSignedOut')
  } else if (picker.unavailable) {
    line = <span className="text-danger">{t('githubRefs.failed')}</span>
  } else {
    line = t(picker.hasQuery ? 'githubRefs.noMatch' : 'githubRefs.empty')
  }
  return (
    <p
      className={cn(
        'shrink-0 px-3 pt-1 pb-1.5 text-small text-tertiary',
        picker.rows.length > 0 && 'mx-1 border-t border-subtle pt-1.5',
      )}
    >
      {line}
    </p>
  )
}
