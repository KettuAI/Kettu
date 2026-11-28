// Shared client-side relay node selector for Settings › Hosts (desktop and hosted web).
// Official regions strictly display localized names and never expose underlying domains, IPs, or ports.

import { useState } from 'react'
import { RefreshIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ClientRelayNodes, ClientRelayOfficialNode } from '@shared/remote/hosts'
import {
  localizedRegionName,
  parseRelayPreference,
  serializeRelayPreference,
} from '@shared/remote/relay-regions'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { errorMessage } from '@renderer/lib/host'
import { ControlError, Pill, SetButton } from './controls'
import { relayHostName } from './relay-text'

/** Header action button to re-probe latency across all selectable client relay nodes. */
export function ClientRelayNodesMeasureButton({ onMeasure }: { onMeasure: () => Promise<void> }) {
  const { t } = useTranslation('settings')
  const refresh = useRefresh()
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SetButton
        size="sm"
        loading={refresh.phase === 'turning'}
        icon={<Icon icon={refresh.phase === 'done' ? Tick02Icon : RefreshIcon} size={14} />}
        onClick={() => {
          setError(null)
          void refresh.run(() => onMeasure()).catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        {t('remote.relay.measure')}
      </SetButton>
    </>
  )
}

/**
 * Radio list for selecting the client's preferred relay node: Automatic, known own relays, and
 * official relay regions, each with live in-use/standby status and measured RTT.
 */
export function ClientRelayNodesCard({
  nodes,
  preference,
  onSelect,
  error,
}: {
  nodes: ClientRelayNodes
  /** Optional override for immediate optimistic selection state (e.g. desktop settings store). */
  preference?: string
  onSelect: (preference: string) => void | Promise<void>
  error?: string | null
}) {
  const { t, i18n } = useTranslation('settings')
  const [selectError, setSelectError] = useState<string | null>(null)
  const activePreference = serializeRelayPreference(
    parseRelayPreference(preference ?? nodes.preference),
  )

  const choose = (next: string): void => {
    if (next === activePreference) return
    setSelectError(null)
    void Promise.resolve(onSelect(next)).catch((e: unknown) => setSelectError(errorMessage(e)))
  }

  const officialLabel = (node: ClientRelayOfficialNode): string =>
    node.id === 'main'
      ? t('remote.relay.regionMain')
      : (localizedRegionName(node.name, node.names, i18n.language) ??
        t('remote.relay.region', { id: node.id.toUpperCase() }))

  const autoSelected = activePreference === 'auto'
  const autoDescription =
    nodes.own.length > 0
      ? t('hosts.relayNodes.auto.descriptionBoth')
      : t('hosts.relayNodes.auto.description')

  return (
    <div className="k-block">
      <ControlError error={error ?? selectError} wrap />
      <ul
        className="k-inset k-list k-relay-nodes"
        role="radiogroup"
        aria-label={t('hosts.relayNodes.group')}
      >
        <li className="k-relay-node-item">
          <button
            type="button"
            role="radio"
            aria-checked={autoSelected}
            className="k-list__row k-relay-node"
            data-selected={autoSelected || undefined}
            onClick={() => choose('auto')}
          >
            <span className="k-relay-node__check k-relay-node__check--radio" aria-hidden>
              {autoSelected && <Icon icon={Tick02Icon} size={11} />}
            </span>
            <span className="k-relay-node__text">
              <span className="k-list__name">{t('hosts.relayNodes.auto.name')}</span>
              <span className="k-relay-node__sub">{autoDescription}</span>
            </span>
          </button>
        </li>
        {nodes.own.map((node) => {
          const value = `own:${node.origin}`
          const selected = activePreference === value
          return (
            <li key={value} className="k-relay-node-item">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                className="k-list__row k-relay-node"
                data-selected={selected || undefined}
                onClick={() => choose(value)}
              >
                <span className="k-relay-node__check k-relay-node__check--radio" aria-hidden>
                  {selected && <Icon icon={Tick02Icon} size={11} />}
                </span>
                <span className="k-relay-node__text">
                  <span className="k-list__name">{relayHostName(node.origin)}</span>
                  <span className="k-relay-node__sub">{t('hosts.relayNodes.ownLabel')}</span>
                </span>
                <ClientNodePill inUse={node.inUse} rtt={node.rtt} />
              </button>
            </li>
          )
        })}
        {nodes.official.map((node) => {
          const value = `official:${node.id}`
          const selected = activePreference === value
          return (
            <li key={node.url} className="k-relay-node-item">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                className="k-list__row k-relay-node"
                data-selected={selected || undefined}
                onClick={() => choose(value)}
              >
                <span className="k-relay-node__check k-relay-node__check--radio" aria-hidden>
                  {selected && <Icon icon={Tick02Icon} size={11} />}
                </span>
                <span className="k-list__name">{officialLabel(node)}</span>
                <ClientNodePill inUse={node.inUse} rtt={node.rtt} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ClientNodePill({ inUse, rtt }: { inUse: boolean; rtt: number | null }) {
  const { t } = useTranslation('settings')
  const state = t(inUse ? 'hosts.relayNodes.state.inUse' : 'hosts.relayNodes.state.standby')
  const label =
    rtt !== null ? `${state} · ${t('remote.relay.rtt', { ms: Math.round(rtt) })}` : state
  return <Pill tone={inUse ? 'success' : undefined}>{label}</Pill>
}
