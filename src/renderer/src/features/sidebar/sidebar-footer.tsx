import { useTranslation } from 'react-i18next'
import { AccountRow } from '@renderer/features/account/account-row'
import { UpdateCardView } from '@renderer/features/updates/update-card'
import { NoticeCard } from '@renderer/features/updates/update-notice'
import { useUpdates } from '@renderer/features/updates/use-updates'
import { isWeb } from '@renderer/lib/platform'
import { openSettings } from '@renderer/stores/view'
import { InsecureCard } from './insecure-card'
import { signInLabel, useNotices } from './notices'

/**
 * The footer: one update card for Kettu and the harnesses, never stacked, over the account row,
 * which opens the account menu with Settings, shortcuts and help.
 */
export function SidebarFooterContent() {
  const { signIn } = useNotices()
  const { card, items } = useUpdates()
  return (
    <>
      {isWeb && !window.isSecureContext && <InsecureCard />}
      {signIn.length > 0 && <SignInCard names={signIn} />}
      {card && <UpdateCardView card={card} items={items} />}
      <AccountRow />
    </>
  )
}

/** An agent needs sign-in: something to do, so it takes the warning color, and it cannot be dismissed. */
function SignInCard({ names }: { names: string[] }) {
  const { t } = useTranslation('sidebar')
  const label = signInLabel(names)
  return (
    <NoticeCard
      icon={<span aria-hidden className="size-1.5 rounded-full bg-current text-warning" />}
      text={label}
      label={label}
      detail={t('footer.signInDetail')}
      onOpen={() => openSettings('agents')}
    />
  )
}
