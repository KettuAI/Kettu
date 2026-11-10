// Settings > General > Kettu cloud: the switch for Kettu's own services on this computer, and the
// connections that stay either way.

import { useState, type ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  AiBrain01Icon,
  GithubIcon,
  Globe02Icon,
  PackageIcon,
  ServerStack02Icon,
  Share08Icon,
  UserIcon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { BrandIcon } from '@renderer/components/brand'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { errorMessage } from '@renderer/lib/host'
import { signOut, useAccountStore } from '@renderer/stores/account'
import { useSettingsStore } from '@renderer/stores/settings'
import { CONFIRM, ControlError, SettingSwitch } from './controls'
import { BlockLine } from './rows'

const MASK = '•'.repeat(8)

/** A small neutral tile with an icon, before a line of a list. */
function IconTile({ icon }: { icon: IconSvgElement }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-(--shell-chip) text-(--shell-ink)"
    >
      <Icon icon={icon} size={14} />
    </span>
  )
}

/** Self-hosted's mark, `size` px square like the app icon it stands beside, whose tile fills 94% of it. */
export function SelfHostedMark({ size }: { size: number }) {
  const tile = Math.round(size * 0.94)
  return (
    <span
      aria-hidden
      className="k-host-mark"
      style={{ width: tile, height: tile, margin: (size - tile) / 2 }}
    >
      <Icon icon={ServerStack02Icon} size={Math.round(size * 0.5)} />
    </span>
  )
}

function TileLine({ icon, children }: { icon: IconSvgElement; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <IconTile icon={icon} />
      <span className="min-w-0">{children}</span>
    </li>
  )
}

/** Use Kettu cloud: the mode's mark, who is signed in, and a switch that asks before sign-out. */
export function CloudSwitchRow() {
  const { t } = useTranslation(['settings', 'common'])
  const on = useSettingsStore((s) => s.settings.cloud.enabled)
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const email = useAccountStore((s) =>
    s.status?.state === 'signed-in' ? s.status.account.email : null,
  )
  const shown = email && (hidden ? MASK : email)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apply = async (enabled: boolean): Promise<void> => {
    setError(null)
    try {
      await useSettingsStore.getState().update({ cloud: { enabled } })
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const change = (next: boolean): void => {
    if (!next && email) setAsking(true)
    else void apply(next)
  }
  // Signed out first, so the account service revokes the session while the cloud is still on.
  const turnOff = async (): Promise<void> => {
    setAsking(false)
    setBusy(true)
    await signOut()
    await apply(false)
    setBusy(false)
  }
  const description = !on
    ? t('general.cloud.off')
    : shown
      ? t('general.cloud.signedIn', { email: shown })
      : t('general.cloud.signedOut')
  return (
    <>
      <div className="ui-sg-row">
        <span className="flex min-w-0 flex-1 items-center gap-3">
          {on ? <BrandIcon size={34} className="k-cloud-mark" /> : <SelfHostedMark size={34} />}
          <span className="ui-sg-label min-w-0 flex-1">
            <b>{t('general.cloud.name')}</b>
            <small>{description}</small>
            <ControlError error={error} wrap />
          </span>
        </span>
        <span className="ui-sg-control">
          <SettingSwitch
            label={t('general.cloud.name')}
            checked={on}
            disabled={busy}
            onChange={change}
          />
        </span>
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('general.cloud.offTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('general.cloud.offBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="grid gap-2.5 text-hint text-(--shell-ink)">
            <TileLine icon={UserIcon}>
              {t('general.cloud.offSignOut', { email: shown ?? '' })}
            </TileLine>
            <TileLine icon={Wifi01Icon}>{t('general.cloud.offDevices')}</TileLine>
            <TileLine icon={Share08Icon}>{t('general.cloud.offSharing')}</TileLine>
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void turnOff()}>
              {t('general.cloud.offConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const OTHERS = [
  { id: 'updates', icon: GithubIcon },
  { id: 'installs', icon: PackageIcon },
  { id: 'siteIcons', icon: Globe02Icon },
  { id: 'agents', icon: AiBrain01Icon },
] as const

/** What Kettu still reaches with its cloud on or off, and whose service each is. */
export function OtherConnections({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  return (
    <>
      <BlockLine text={text} />
      <ul className="grid gap-2 text-hint text-(--shell-ink)">
        {OTHERS.map(({ id, icon }) => (
          <TileLine key={id} icon={icon}>
            {t(`general.others.items.${id}.name`)}
            <span className="text-(--shell-muted)">
              {' · '}
              {t(`general.others.items.${id}.source`)}
            </span>
          </TileLine>
        ))}
      </ul>
    </>
  )
}
