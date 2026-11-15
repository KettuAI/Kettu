import { useTranslation } from 'react-i18next'
import { starKettu, useStarPhase, useStarsInBrowser } from '@renderer/stores/github-star'
import { StarMark } from './star-button'

export function useStarLabel(): string {
  const { t } = useTranslation('star')
  const phase = useStarPhase()
  if (phase === 'starring') return t('button.starring')
  if (phase === 'starred') return t('button.starred')
  return t('button.star')
}

/** Account menu › Help: stars in place, and the menu stays open. */
export function useStarMenuItem() {
  const { t } = useTranslation('star')
  const phase = useStarPhase()
  const inBrowser = useStarsInBrowser()
  return {
    id: 'star',
    label:
      phase === 'starring'
        ? t('menu.starring')
        : phase === 'starred'
          ? t('menu.starred')
          : t('menu.star'),
    icon: <StarMark size={16} />,
    tone: phase === 'starred' ? ('quiet' as const) : undefined,
    note: inBrowser && phase === 'idle' ? '↗' : undefined,
    onSelect: () => void starKettu(),
  }
}
