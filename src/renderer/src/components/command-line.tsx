import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { CopyAction } from './copy-action'

/** A command as it runs, which can be copied into a terminal; `wrap` shows all of it. */
export function CommandLine({
  command,
  label,
  wrap,
}: {
  command: string
  label?: string
  wrap?: boolean
}) {
  const { t } = useTranslation('common')
  return (
    <div
      className={cn(
        'flex min-w-0 gap-1.5 rounded-lg bg-code-block pr-0.75 pl-2.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]',
        wrap ? 'items-start py-1.5' : 'items-center py-0.75',
      )}
    >
      <code
        className={cn(
          'min-w-0 flex-1 font-mono text-code text-primary',
          wrap ? 'py-0.5 break-all whitespace-pre-wrap' : 'truncate',
        )}
        data-selectable=""
        title={command}
      >
        {command}
      </code>
      <CopyAction text={command} label={label ?? t('actions.copyCommand')} />
    </div>
  )
}
