import { useTranslation } from 'react-i18next'
import { CopyAction } from './copy-action'

/** A command as it runs, which can be copied into a terminal. */
export function CommandLine({ command }: { command: string }) {
  const { t } = useTranslation('common')
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-code-block py-0.75 pr-0.75 pl-2.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]">
      <code
        className="min-w-0 flex-1 truncate font-mono text-code text-primary"
        data-selectable=""
        title={command}
      >
        {command}
      </code>
      <CopyAction text={command} label={t('actions.copyCommand')} />
    </div>
  )
}
