// The sidebar with other hosts added: Needs you across the hosts, and each host's heading over
// its projects, which says whether it is online.

import { useMemo } from 'react'
import { Alert02Icon, ComputerIcon, LaptopIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import { Spinner } from '@renderer/components/ui/spinner'
import { HostIcon, OnlineDot } from '@renderer/features/settings/remote-parts'
import { deviceShape } from '@renderer/features/settings/remote-text'
import { connectionText, routeName } from '@renderer/features/settings/host-text'
import { Glyph } from '@renderer/features/shell/glyph'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useHostsStore, useOtherHost, type OtherHost } from '@renderer/stores/hosts'
import { hostOfSession, needsYouTree, useSessionsStore } from '@renderer/stores/sessions'
import { useHostLabel } from './host-label'
import { GroupRenameHints } from './rename-hints'
import { RenameScope } from './rename-scope'
import { SessionRow } from './session-row'

// Its rows' group, for the rename keys at its end; no project path looks like it.
const NEEDS_YOU_GROUP = 'needs-you'

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
    <section aria-label={t('needsYou.label')} className="ui-as-side__group">
      <div className="ui-as-side__label kettu-host-label">
        <h3>{t('needsYou.label')}</h3>
        <span className="tabular-nums">{tree.length}</span>
      </div>
      <ul className="flex flex-col">
        <RenameScope value={NEEDS_YOU_GROUP}>
          {tree.map((node) => (
            <SessionRow key={node.summary.id} node={node} tabStopId={null} showHost />
          ))}
        </RenameScope>
        <GroupRenameHints scope={NEEDS_YOU_GROUP} />
      </ul>
    </section>
  )
}

/** A host's heading over its projects: its name, and whether it is online and how it is reached. */
export function HostHeading({ hostId }: { hostId: string | null }) {
  const host = useOtherHost(hostId)
  const name = useHostLabel(hostId)
  const model = useHostsStore((s) => s.status?.self.model ?? '')
  const laptop = deviceShape({ kind: 'desktop', model }) === 'laptop'
  const state = host ? <HostStateText host={host} /> : null
  return (
    <div className="ui-as-side__label kettu-host-label">
      {hostId === null ? (
        <Glyph icon={laptop ? LaptopIcon : ComputerIcon} size={13} className="shrink-0" />
      ) : (
        <HostIcon platform={host?.platform ?? 'linux'} className="size-[13px] shrink-0" />
      )}
      <h3>{name}</h3>
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
      {connection.state === 'stopped' && (
        <Glyph icon={Alert02Icon} size={14} className="shrink-0" />
      )}
      <span className="truncate">{connectionText(t, host, now)}</span>
    </span>
  )
}

/** In place of a host's projects while it lists no session. */
export function HostEmpty() {
  const { t } = useTranslation('sidebar')
  return <span className="ui-as-side__empty">{t('hosts.empty')}</span>
}
