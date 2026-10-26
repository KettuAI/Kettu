import { useTranslation } from 'react-i18next'
import type { CatalogInstallError, ThemeFileError } from '@shared/themes'

type Failure = ThemeFileError | CatalogInstallError | { code: 'unreadable' } | { code: 'missing' }

/** Why a file, a catalog theme or the chosen theme failed, as the end of a sentence. */
export function useReason(): (error: Failure) => string {
  const { t } = useTranslation('settings')
  return (error) => {
    switch (error.code) {
      case 'invalid-field':
      case 'invalid-color':
        return t(`appearance.theme.errors.${error.code}`, { path: error.path })
      case 'missing-variant':
        return t('appearance.theme.errors.missing-variant', { variant: error.variant })
      default:
        return t(`appearance.theme.errors.${error.code}`)
    }
  }
}
