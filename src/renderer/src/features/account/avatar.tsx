import { CircleUserRoundIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Masked } from '@renderer/features/settings/controls'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import type { Identity } from './model'

/** The account's picture, its initial on a dark gradient, or a person while signed out. */
export function Avatar({ identity, size }: { identity: Identity; size: 24 | 32 }) {
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const picture = identity.avatar && !hidden
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-full bg-linear-135 from-(--avatar-from) to-(--avatar-to) font-semibold text-(--on-fill)',
        size === 24 ? 'size-6 text-[11px]' : 'size-8 text-control',
      )}
    >
      {picture ? (
        <img src={identity.avatar!} alt="" draggable={false} className="size-full object-cover" />
      ) : identity.initial && !hidden ? (
        identity.initial
      ) : (
        <CircleUserRoundIcon strokeWidth={1.5} className={size === 24 ? 'size-3.5' : 'size-4.5'} />
      )}
    </span>
  )
}

/** The account's name, masked while accounts are hidden; "Not signed in" without one. */
export function IdentityName({ identity }: { identity: Identity }) {
  const { t } = useTranslation('sidebar')
  if (!identity.name) return <>{t('account.signedOut')}</>
  return <Masked revealable={false}>{identity.name}</Masked>
}
