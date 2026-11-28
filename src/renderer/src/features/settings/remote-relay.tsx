// The relay in Settings › Remote access: its part of the status line, each region of the Kettu
// relay, speed testing and manual node selection, and the direct connections' switch.

import { useState } from 'react'
import { AlertCircleIcon, RefreshIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { MAX_REGIONS } from '@shared/remote/relay'
import type { RelayRegionStatus } from '@shared/remote/relay-host'
import { localizedRegionName } from '@shared/remote/relay-regions'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { useHostHas } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { signIn } from '@renderer/stores/account'
import { useHostScope } from '@renderer/stores/host-scope'
import { useCloudOffHere } from './use-cloud-off-here'
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

/** Triggers a fresh latency probe across all official relay regions on the host. */
export function MeasureRelays() {
  const { api } = useHostScope()
  const { t } = useTranslation('settings')
  const canMeasure = useHostHas('relayMeasure') !== false
  const refresh = useRefresh()
  const [error, setError] = useState<string | null>(null)
  if (!canMeasure) return null
  return (
    <>
      <ControlError error={error} />
      <SetButton
        size="sm"
        loading={refresh.phase === 'turning'}
        icon={<Icon icon={refresh.phase === 'done' ? Tick02Icon : RefreshIcon} size={14} />}
        onClick={() => {
          setError(null)
          void refresh
            .run(() => api.remote.measureRelays())
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        {t('remote.relay.measure')}
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

/**
 * Let devices on the account find this computer and ask to be added; only through the official
 * Kettu relay, which names the computer to the account.
 */
export function DiscoverableSwitch({ label }: { label: string }) {
  const { useSettingsStore } = useHostScope()
  const checked = useSettingsStore((s) => s.settings.remote.discoverable)
  const officialOff = useSettingsStore((s) => !s.settings.remote.relay)
  const [apply, error] = useApply()
  if (officialOff)
    return <SettingSwitch label={label} checked={false} disabled onChange={() => {}} />
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ remote: { discoverable: v } })}
      />
    </>
  )
}

/**
 * Official relay regions with live status, measured RTT, and automatic vs. manual host selection.
 * Strictly renders localized region labels and never exposes underlying domains, IPs, or ports.
 */
export function RelayRegions() {
  const { useRemoteStore, useSettingsStore } = useHostScope()
  const { t, i18n } = useTranslation('settings')
  const relay = useRemoteStore((s) => s.status?.relay)
  const selected = useSettingsStore((s) => s.settings.remote.relayRegions)
  const canSelect = useHostHas('relayMeasure') !== false
  const [apply, error] = useApply()

  if (relay?.state !== 'on') {
    return <span className="text-hint text-tertiary">{t('remote.relay.regionsNone')}</span>
  }
  const nodes: RelayRegionStatus[] =
    relay.available && relay.available.length > 0
      ? relay.available
      : relay.relays.map((entry) => ({ ...entry, rtt: entry.rtt ?? null }))
  if (nodes.length === 0) {
    return <span className="text-hint text-tertiary">{t('remote.relay.regionsNone')}</span>
  }

  const mainNode = nodes.find((entry) => entry.id === 'main')
  const regionalNodes = nodes.filter((entry) => entry.id !== 'main')
  const selectable = canSelect && regionalNodes.length > 0
  const isAutomatic = selected === null || selected.length === 0
  const maxManual = MAX_REGIONS - 1

  const toggleRegion = (id: string): void => {
    if (isAutomatic) {
      apply({ remote: { relayRegions: [id] } })
      return
    }
    if (selected.includes(id)) {
      const next = selected.filter((item) => item !== id)
      apply({ remote: { relayRegions: next.length > 0 ? next : null } })
      return
    }
    if (selected.length >= maxManual) return
    apply({ remote: { relayRegions: [...selected, id] } })
  }

  const regionLabel = (entry: RelayRegionStatus): string =>
    entry.id === 'main'
      ? t('remote.relay.regionMain')
      : (localizedRegionName(entry.name, entry.names, i18n.language) ??
        t('remote.relay.region', { id: entry.id.toUpperCase() }))

  if (!selectable) {
    return (
      <ul className="k-inset k-list">
        {nodes.map((entry) => (
          <li key={entry.url} className="k-list__row">
            <span className="k-list__name">{regionLabel(entry)}</span>
            <RegionPill relay={entry} />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <>
      <ControlError error={error} wrap />
      <ul className="k-inset k-list k-relay-nodes">
        <li className="k-relay-node-item">
          <button
            type="button"
            role="radio"
            aria-checked={isAutomatic}
            className="k-list__row k-relay-node"
            data-selected={isAutomatic || undefined}
            onClick={() => {
              if (!isAutomatic) apply({ remote: { relayRegions: null } })
            }}
          >
            <span className="k-relay-node__check k-relay-node__check--radio" aria-hidden>
              {isAutomatic && <Icon icon={Tick02Icon} size={11} />}
            </span>
            <span className="k-relay-node__text">
              <span className="k-list__name">{t('remote.relay.auto.name')}</span>
              <span className="k-relay-node__sub">{t('remote.relay.auto.description')}</span>
            </span>
          </button>
        </li>
        {mainNode && (
          <li key={mainNode.url} className="k-relay-node-item">
            <div className="k-list__row k-relay-node k-relay-node--static">
              <span className="k-relay-node__check k-relay-node__check--locked" aria-hidden>
                <Icon icon={Tick02Icon} size={11} />
              </span>
              <span className="k-relay-node__text">
                <span className="k-list__name">{regionLabel(mainNode)}</span>
                <span className="k-relay-node__sub">{t('remote.relay.alwaysOn')}</span>
              </span>
              <RegionPill relay={mainNode} />
            </div>
          </li>
        )}
        {regionalNodes.map((entry) => {
          const checked = !isAutomatic && selected.includes(entry.id)
          const atLimit = !isAutomatic && !checked && selected.length >= maxManual
          const button = (
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              disabled={atLimit}
              className="k-list__row k-relay-node"
              data-selected={checked || undefined}
              onClick={() => toggleRegion(entry.id)}
            >
              <span className="k-relay-node__check" aria-hidden>
                {checked && <Icon icon={Tick02Icon} size={11} />}
              </span>
              <span className="k-list__name">{regionLabel(entry)}</span>
              <RegionPill relay={entry} />
            </button>
          )
          return (
            <li key={entry.url} className="k-relay-node-item">
              {atLimit ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="k-relay-node__wrap">{button}</span>} />
                  <TooltipContent>
                    {t('remote.relay.maxSelected', { max: maxManual })}
                  </TooltipContent>
                </Tooltip>
              ) : (
                button
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function RegionPill({ relay }: { relay: RelayRegionStatus }) {
  const { t } = useTranslation('settings')
  const { connection } = relay
  const rtt = relay.rtt !== null ? t('remote.relay.rtt', { ms: Math.round(relay.rtt) }) : null
  const withRtt = (label: string): string => (rtt ? `${label} · ${rtt}` : label)
  switch (connection.state) {
    case 'connected':
      return <Pill tone="success">{withRtt(t('remote.relay.state.connected'))}</Pill>
    case 'standby':
      return <Pill>{withRtt(t('remote.relay.state.standby'))}</Pill>
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
 * Direct connections: the owner's choice while at least one relay is in use; held on otherwise,
 * since they are then the devices' only way.
 */
export function DirectSwitch({ label }: { label: string }) {
  const { useSettingsStore, useRemoteStore } = useHostScope()
  const enabled = useSettingsStore((s) => s.settings.remote.direct.enabled)
  const cloudOff = useCloudOffHere()
  const own = useSettingsStore((s) => s.settings.remote.ownRelayEnabled)
  // Local mode keeps the owner's own relay, so only the Kettu relay is off there.
  const free = useRemoteStore((s) => relayInUse(s.status)) && (!cloudOff || own)
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
