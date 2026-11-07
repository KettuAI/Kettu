import { useState } from 'react'
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { PaneIcon } from '@renderer/features/shell/panel-button'

/** The Diff and File toggle of a changed file's bar. */
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
      variant="tray"
      size="md"
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={[
        { value: 'diff', label: t('diff.diff') },
        { value: 'file', label: t('diff.file') },
      ]}
    />
  )
}

/** Between a Markdown or SVG file drawn as it shows and its text in the editor. */
export function PreviewEditToggle({
  value,
  onChange,
}: {
  value: 'preview' | 'edit'
  onChange: (value: 'preview' | 'edit') => void
}) {
  const { t } = useTranslation('files')
  return (
    <SegmentedControl
      aria-label={t('preview.view')}
      variant="tray"
      size="md"
      value={value}
      onChange={onChange}
      options={[
        { value: 'preview', label: t('preview.preview') },
        { value: 'edit', label: t('preview.edit') },
      ]}
    />
  )
}

/** A file's path in a bar, which copies itself when clicked; a long one keeps its end in view. */
export function PathCopy({ path, shown = path }: { path: string; shown?: string }) {
  const { t } = useTranslation(['files', 'common'])
  const [copied, setCopied] = useState(false)
  const label = copied ? t('common:actions.copied') : t('preview.copyPath')
  return (
    <button
      type="button"
      className="kp-doc__path"
      title={`${shown} · ${label}`}
      aria-label={`${shown}, ${label}`}
      data-copied={copied || undefined}
      onClick={() =>
        void navigator.clipboard.writeText(path).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {/* The bidi isolate keeps a path's slashes in place in the right-to-left box. */}
      <span>
        <bdi>{shown}</bdi>
      </span>
      <PaneIcon icon={copied ? Tick02Icon : Copy01Icon} size={12} />
    </button>
  )
}
