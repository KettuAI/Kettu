import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { folderOf, nameOf } from './paths'

/** The Diff and File toggle of a changed file's header. */
export function DiffFileToggle({
  value,
  onChange,
  disabled,
}: {
  value: 'diff' | 'file'
  onChange: (value: 'diff' | 'file') => void
  disabled?: boolean
}) {
  const { t } = useTranslation('files')
  // The fieldset disables the segments natively; without pointer events the track's own press
  // and drag cannot move the thumb either.
  return (
    <fieldset disabled={disabled} className="shrink-0 disabled:pointer-events-none">
      <SegmentedControl
        aria-label={t('diff.view')}
        value={value}
        onChange={onChange}
        size="small"
        className="app-region-no-drag"
        itemClassName="h-5.5 px-2 text-small"
        segments={[
          { value: 'diff', label: t('diff.diff') },
          { value: 'file', label: t('diff.file') },
        ]}
      />
    </fieldset>
  )
}

/** A file's path in a preview's header: the folder quiet, the name after it. */
export function PathLabel({ path }: { path: string }) {
  const folder = folderOf(path)
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-caption text-secondary" title={path}>
      {folder && <span className="text-tertiary">{folder}/</span>}
      {nameOf(path)}
    </span>
  )
}
