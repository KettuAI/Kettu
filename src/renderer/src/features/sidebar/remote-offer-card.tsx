import { ComputerIcon, Globe02Icon, SmartPhone01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { RemoteOffer } from '@shared/remote/discovery'
import { Glyph } from '@renderer/features/shell/glyph'
import { CardButton } from '@renderer/features/updates/update-parts'
import { NoticeCard } from '@renderer/features/updates/update-notice'
import { openSettings } from '@renderer/stores/view'

const ICONS = {
  ios: SmartPhone01Icon,
  web: Globe02Icon,
  desktop: ComputerIcon,
  daemon: ComputerIcon,
} as const

/**
 * Another client of the account signed in while this computer's remote access is off: asks
 * once whether to turn it on, so that client can ask to use this computer.
 */
export function RemoteOfferCard({ offer }: { offer: RemoteOffer }) {
  const { t } = useTranslation('sidebar')
  const name = offer.name || t(`remoteOffer.kind.${offer.kind}`)
  const text = t('remoteOffer.text', { name })
  const answer = (turnOn: boolean) =>
    window.kettu.remote
      .answerOffer(offer.clientId, turnOn)
      .then(() => {
        if (turnOn) openSettings('remote')
      })
      .catch((error: unknown) => console.error('Could not answer the remote access offer', error))
  return (
    <NoticeCard
      icon={<Glyph icon={ICONS[offer.kind]} size={14} className="text-(--shell-muted)" />}
      text={text}
      label={text}
      detail={t('remoteOffer.detail')}
      onOpen={() => openSettings('remote')}
      action={
        <CardButton primary onClick={() => void answer(true)}>
          {t('remoteOffer.turnOn')}
        </CardButton>
      }
      onCancel={() => void answer(false)}
      cancelLabel={t('remoteOffer.notNow')}
    />
  )
}
