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
  return (
    <SegmentedControl
      aria-label={t('diff.view')}
      value={value}
      onChange={(next) => !disabled && onChange(next)}
      className="app-region-no-drag shrink-0"
      itemClassName="h-5.5 px-2 text-small"
      segments={[
        { value: 'diff', label: t('diff.diff') },
        { value: 'file', label: t('diff.file') },
      ]}
    />
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
