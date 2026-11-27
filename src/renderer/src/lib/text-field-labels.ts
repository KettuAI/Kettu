import { useTranslation } from 'react-i18next'
import type { TextFieldLabels } from '@renderer/components/affect/text-field'

/** Localized accessible labels for affectUI's TextField action buttons. */
export function useTextFieldLabels(): Partial<TextFieldLabels> {
  const { t } = useTranslation('common')
  return {
    clear: t('actions.clear'),
    showPassword: t('actions.showPassword'),
    hidePassword: t('actions.hidePassword'),
    copy: t('actions.copy'),
    copied: t('actions.copied'),
  }
}
