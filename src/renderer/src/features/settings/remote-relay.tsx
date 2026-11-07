// The Kettu relay in Settings › Remote access: its part of the status line, Use the Kettu relay,
// each region's state, and the direct connections' switch, which it frees while it is in use.

import { useState } from 'react'
import { AlertCircleIcon, RefreshIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { RelayStatus } from '@shared/remote/relay-host'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { errorMessage } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { signIn } from '@renderer/stores/account'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, Pill, SetButton, SettingSwitch } from './controls'
import { errorGroup, relayInUse } from './relay-text'
import { useApply } from './use-apply'

/** Retry, after the relay could not be reached or another copy of Kettu took its place. */
export function RetryRelay() {
  const { api } = useHostScope()
  const { t } = useTranslation('settings')
  const refresh = useRefresh()
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SetButton
        loading={refresh.phase === 'turning'}
        icon={<Icon icon={refresh.phase === 'done' ? Tick02Icon : RefreshIcon} size={14} />}
        onClick={() => {
          setError(null)
          void refresh
            .run(() => api.remote.retryRelay())
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        {t('remote.status.retry')}
      </SetButton>
    </>
  )
}

/** Sign in, on this computer's own page, where the hint says signing in reaches it from anywhere. */
export function RelaySignIn() {
  const { hostId } = useHostScope()
  const { t } = useTranslation('settings')
  if (isWeb || hostId !== null) return null
  return <SetButton onClick={() => void signIn()}>{t('account.signIn')}</SetButton>
}

/** Use the Kettu relay. */
export function RelaySwitch({ label }: { label: string }) {
  const { useSettingsStore } = useHostScope()
  const checked = useSettingsStore((s) => s.settings.remote.relay)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ remote: { relay: v } })}
      />
    </>
  )
}

/** Each relay and how it is doing, while the host signs in to them. */
export function RelayRegions() {
  const { useRemoteStore } = useHostScope()
  const { t } = useTranslation('settings')
  const relay = useRemoteStore((s) => s.status?.relay)
  if (relay?.state !== 'on' || relay.relays.length === 0) {
    return <span className="text-hint text-tertiary">{t('remote.relay.regionsNone')}</span>
  }
  return (
    <ul className="k-inset k-list">
      {relay.relays.map((entry) => (
        <li key={entry.url} className="k-list__row">
          <span className="k-list__name">
            {entry.id === 'main'
              ? t('remote.relay.regionMain')
              : t('remote.relay.region', { id: entry.id.toUpperCase() })}
            <span className="k-mono text-tertiary"> {new URL(entry.url).host}</span>
          </span>
          <RegionPill relay={entry} />
        </li>
      ))}
    </ul>
  )
}

function RegionPill({ relay }: { relay: RelayStatus }) {
  const { t } = useTranslation('settings')
  const { connection } = relay
  switch (connection.state) {
    case 'connected':
      return <Pill tone="success">{t('remote.relay.state.connected')}</Pill>
    case 'connecting':
      return <Pill>{t('remote.relay.state.connecting')}</Pill>
    case 'conflict':
      return (
        <Pill tone="warning">
          <Icon icon={AlertCircleIcon} size={12} />
          {t('remote.relay.state.conflict')}
        </Pill>
      )
    case 'retrying':
    case 'refused':
      return <Pill tone="warning">{t(`remote.relay.state.${errorGroup(connection.error)}`)}</Pill>
  }
}

/**
 * Direct connections: the owner's choice while the relay is in use; held on otherwise, since
 * they are then the devices' only way.
 */
export function DirectSwitch({ label }: { label: string }) {
  const { useSettingsStore, useRemoteStore } = useHostScope()
  const enabled = useSettingsStore((s) => s.settings.remote.direct.enabled)
  const free = useRemoteStore((s) => relayInUse(s.status))
  const [apply, error] = useApply()
  if (!free) return <SettingSwitch label={label} checked disabled onChange={() => {}} />
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={enabled}
        onChange={(v) => apply({ remote: { direct: { enabled: v } } })}
      />
    </>
  )
}
