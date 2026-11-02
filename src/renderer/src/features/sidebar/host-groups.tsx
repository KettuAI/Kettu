// The sidebar with other hosts added: Needs you across the hosts, and each host's heading over
// its projects, which says whether it is online.

import { useMemo } from 'react'
import { CircleAlertIcon, LaptopIcon, MonitorIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import { SidebarMenu } from '@renderer/components/ui/sidebar'
import { Spinner } from '@renderer/components/ui/spinner'
import { HostIcon, OnlineDot } from '@renderer/features/settings/remote-parts'
import { deviceShape } from '@renderer/features/settings/remote-text'
import { connectionText, routeName } from '@renderer/features/settings/host-text'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useHostsStore, useOtherHost, type OtherHost } from '@renderer/stores/hosts'
import { hostOfSession, needsYouTree, useSessionsStore } from '@renderer/stores/sessions'
import { useHostLabel } from './host-label'
import { SessionRow } from './session-row'

/** The sessions on the hosts shown that wait for you or failed, each naming its host. */
export function NeedsYouGroup({
  hosts,
  away,
}: {
  hosts: readonly (string | null)[]
  /** Hosts not connected now: what waits on them cannot be answered, so it is left out. */
  away: readonly string[]
}) {
  const { t } = useTranslation('sidebar')
  // The sessions that need you and their parents, so a sub-session's request lists its root.
  const summaries = useSessionsStore(
    useShallow((s) => {
      const found = new Set<SessionSummary>()
      for (const summary of Object.values(s.byId)) {
        if (summary.permissionCount === 0 && summary.attention !== 'error') continue
        let at: SessionSummary | undefined = summary
        while (at && !found.has(at)) {
          found.add(at)
          at = at.parentId ? s.byId[at.parentId] : undefined
        }
      }
      return [...found]
    }),
  )
  const tree = useMemo(
    () =>
      needsYouTree(Object.fromEntries(summaries.map((x) => [x.id, x]))).filter((node) => {
        const host = hostOfSession(node.summary)
        return hosts.includes(host) && !(host !== null && away.includes(host))
      }),
    [summaries, hosts, away],
  )
  if (tree.length === 0) return null
  return (
    <section aria-label={t('needsYou.label')} className="flex flex-col gap-0.5">
      <div className="mt-1.5 flex h-7 items-center gap-[5px] pr-1 pl-2.5">
        <h3 className="m-0 text-group font-medium text-primary">{t('needsYou.label')}</h3>
        <span className="text-xs text-tertiary tabular-nums">{tree.length}</span>
      </div>
      <SidebarMenu className="gap-0.5">
        {tree.map((node) => (
          <SessionRow key={node.summary.id} node={node} tabStopId={null} showHost />
        ))}
      </SidebarMenu>
    </section>
  )
}

/** A host's heading over its projects: its name, and whether it is online and how it is reached. */
export function HostHeading({ hostId }: { hostId: string | null }) {
  const host = useOtherHost(hostId)
  const name = useHostLabel(hostId)
  const model = useHostsStore((s) => s.status?.self.model ?? '')
  const laptop = deviceShape({ kind: 'desktop', model }) === 'laptop'
  const Icon = hostId === null ? (laptop ? LaptopIcon : MonitorIcon) : null
  const state = host ? <HostStateText host={host} /> : null
  return (
    <div className="mt-5.5 flex h-6.5 items-center gap-1.5 pr-2 pl-2.5 text-xs text-tertiary">
      {Icon ? (
        <Icon aria-hidden className="size-[13px] shrink-0" />
      ) : (
        <HostIcon platform={host?.platform ?? 'linux'} className="size-[13px] shrink-0" />
      )}
      <h3 className="m-0 min-w-0 truncate text-xs font-semibold text-secondary">{name}</h3>
      <span className="min-w-2 flex-1" />
      {state}
    </div>
  )
}

/** Online with its route, connecting, offline since when, or why it is not tried. */
function HostStateText({ host }: { host: OtherHost }) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const { connection } = host
  if (connection.state === 'online') {
    return (
      <span className="inline-flex shrink-0 items-center gap-[5px]">
        <OnlineDot />
        <span>{routeName(t, host)}</span>
        <span className="sr-only">{t('hosts.state.online')}</span>
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex min-w-0 shrink items-center gap-[5px]',
        connection.state === 'stopped' && 'text-warning',
      )}
    >
      {connection.state === 'connecting' && <Spinner className="size-3 shrink-0" />}
      {connection.state === 'offline' && (
        <span aria-hidden className="size-1.75 shrink-0 rounded-full bg-border-strong" />
      )}
      {connection.state === 'stopped' && <CircleAlertIcon className="size-3.5 shrink-0" />}
      <span className="truncate">{connectionText(t, host, now)}</span>
    </span>
  )
}

/** In place of a host's projects while it lists no session. */
export function HostEmpty() {
  const { t } = useTranslation('sidebar')
  return <p className="mt-1 px-2.5 py-1 text-xs leading-normal text-tertiary">{t('hosts.empty')}</p>
}
