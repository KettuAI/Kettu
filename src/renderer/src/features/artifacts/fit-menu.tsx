import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import type { FitMode } from '@renderer/stores/artifact-viewer'

const MODES: FitMode[] = ['auto', 'screen', 'width', 'actual']

/** How an opened or presented frame is sized: the reading size, or one of three plain fits. */
export function FitMenu({ value, onChange }: { value: FitMode; onChange: (fit: FitMode) => void }) {
  const { t } = useTranslation('artifacts')
  return (
    <Dropdown
      side="top"
      align="end"
      items={MODES.map((mode, i) => ({
        label: t(`reading.fit.${mode}`),
        checked: mode === value,
        divider: i === 1,
        onSelect: () => onChange(mode),
      }))}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="avs-dock__btn"
          data-text=""
          aria-haspopup="menu"
          aria-expanded={open}
          title={t('reading.fit.label')}
          onClick={toggle}
        >
          {t(`reading.fit.${value}`)}
          <Icon icon={ArrowDown01Icon} size={12} />
        </button>
      )}
    />
  )
}
