import { useTranslation } from 'react-i18next'
import { Kbd } from '@renderer/components/ui/kbd'
import { formatShortcut } from '@renderer/lib/platform'
import { useViewStore } from '@renderer/stores/view'

/** At the end of a group, the rename keys while one of its rows is being renamed. */
export function GroupRenameHints({ scope }: { scope: string }) {
  const shown = useViewStore((s) => s.renamingIn?.scope === scope)
  return shown ? (
    <li>
      <RenameHints />
    </li>
  ) : null
}

const MOD_Z = [formatShortcut('Mod'), 'Z']

/** The keys that save, cancel and undo a rename. */
export function RenameHints() {
  const { t } = useTranslation('sidebar')
  return (
    <div aria-hidden className="flex flex-wrap gap-3.5 px-2.5 pt-2.5 pb-1 text-meta text-tertiary">
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
        <Kbd>↵</Kbd>
        {t('rename.save')}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
        <Kbd>esc</Kbd>
        {t('rename.cancel')}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
        {MOD_Z.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
        {t('rename.undo')}
      </span>
    </div>
  )
}
