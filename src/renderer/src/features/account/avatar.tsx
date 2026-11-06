import { Settings01Icon, UserCircleIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback, AvatarImage } from '@renderer/components/ui/avatar'
import { Masked } from '@renderer/features/settings/controls'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import type { Identity } from './model'

/** The account's picture, its initial on a dark gradient, or a person while signed out. */
export function AccountAvatar({ identity, size }: { identity: Identity; size: 24 | 32 }) {
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  return (
    <Avatar aria-hidden size={size === 24 ? 'sm' : 'default'} className="after:border-0">
      {identity.avatar && !hidden && <AvatarImage src={identity.avatar} alt="" draggable={false} />}
      {/* A face or a letter tells who it is, so hiding accounts hides them too. */}
      <AvatarFallback
        className={cn(
          'bg-linear-135 from-(--avatar-from) to-(--avatar-to) font-semibold text-(--on-fill)',
          size === 24 ? 'text-[11px]' : 'text-control',
        )}
      >
        {identity.initial && !hidden ? (
          identity.initial
        ) : (
          <Glyph icon={UserCircleIcon} size={size === 24 ? 14 : 18} />
        )}
      </AvatarFallback>
    </Avatar>
  )
}

/** The account's name, masked while accounts are hidden; "Not signed in" without one. */
export function IdentityName({ identity }: { identity: Identity }) {
  const { t } = useTranslation('sidebar')
  if (!identity.name) return <>{t('account.signedOut')}</>
  return <Masked revealable={false}>{identity.name}</Masked>
}

/** Settings' gear, as the account row's button draws it. */
export function SettingsGlyph() {
  return <Glyph icon={Settings01Icon} />
}
