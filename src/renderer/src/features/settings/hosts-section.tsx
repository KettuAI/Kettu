import { useState } from 'react'
import { CircleAlertIcon, LaptopIcon, MonitorIcon, PlusIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { HostStatus, HostsStatus } from '@shared/remote/hosts'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useHostsStore } from '@renderer/stores/hosts'
import { openSettings, openSettingsItem } from '@renderer/stores/view'
import { AddHostDialog } from './host-add'
import { connectionText, hostLine, platformName } from './host-text'
import { DeviceTile, HostIcon, OnlineDot } from './remote-parts'
import { deviceShape } from './remote-text'
import { GroupNote, ItemRow } from './rows'

/** The page's title and line, with Add host at their end. */
export function HostsHeader({ id }: { id: string }) {
  const { t } = useTranslation('settings')
  const keyFailed = useHostsStore((s) => s.status?.keyFailed === true)
  const [open, setOpen] = useState(false)
  return (
    <header className="flex items-center gap-3.5 pb-7">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id={id} className="font-heading text-title font-medium text-balance">
          {t('sections.hosts')}
        </h2>
        <p className="text-small text-pretty text-tertiary">{t('pages.hosts')}</p>
      </div>
      <Button size="sm" disabled={keyFailed} onClick={() => setOpen(true)}>
        <PlusIcon data-icon="inline-start" />
        {t('hosts.add.button')}
      </Button>
      <AddHostDialog open={open} onOpenChange={setOpen} />
    </header>
  )
}

/** Whether a host is online, or how it is not, as its row and its page say it. */
export function HostState({
  host,
  className,
}: {
  host: Pick<HostStatus, 'connection' | 'lastOnlineAt'>
  className?: string
}) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const { state } = host.connection
  const stopped = state === 'stopped'
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-xs',
        stopped ? 'text-warning' : 'text-tertiary',
        className,
      )}
    >
      {state === 'online' && <OnlineDot />}
      {state === 'offline' && (
        <span aria-hidden className="size-1.75 shrink-0 rounded-full bg-border-strong" />
      )}
      {state === 'connecting' && <Spinner className="size-3" />}
      {stopped && <CircleAlertIcon className="size-3.5 shrink-0" />}
      {connectionText(t, host, now)}
    </span>
  )
}

/** This computer, first in the list; nothing to open. */
export function SelfRow({ self }: { self: HostsStatus['self'] }) {
  const { t } = useTranslation('settings')
  const laptop = deviceShape({ kind: 'desktop', model: self.model }) === 'laptop'
  const Icon = laptop ? LaptopIcon : MonitorIcon
  return (
    <div className="-mx-3 flex items-start gap-3 py-3 pr-3 pl-4">
      <DeviceTile icon={<Icon className="size-4" />} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-h-5.5 min-w-0 items-center gap-2">
          <span className="truncate text-ui font-medium">{self.name}</span>
          <Badge variant="neutral">{t('hosts.self.badge')}</Badge>
        </div>
        <span className="truncate text-command leading-4.5 text-secondary">
          {[platformName(self.platform), t('hosts.version', { version: self.version })].join(' · ')}
        </span>
      </div>
      <span className="flex h-5.5 shrink-0 items-center text-xs text-tertiary">
        {t('hosts.self.label')}
      </span>
    </div>
  )
}

/** A known host in the list, which opens its page. */
export function HostRow({ host }: { host: HostStatus }) {
  const { t } = useTranslation('settings')
  return (
    <ItemRow
      item={host.id}
      label={host.name}
      onOpen={() => openSettingsItem('hosts', host.id)}
      tile={<DeviceTile icon={<HostIcon platform={host.platform} className="size-4" />} />}
      name={host.name}
      right={<HostState host={host} />}
    >
      <span className="truncate text-command leading-4.5 text-secondary">{hostLine(t, host)}</span>
    </ItemRow>
  )
}

/** In place of the hosts while the remote host has not reported them. */
export function HostsLoading() {
  return (
    <div className="flex h-12 items-center px-1">
      <Spinner className="size-3.5 text-icon" />
    </div>
  )
}

/** Under the list: where devices connect to this computer, and how the device key is kept. */
export function HostsNote() {
  const { t } = useTranslation('settings')
  const plain = useHostsStore((s) => s.status?.plainTextKey === true)
  const failed = useHostsStore((s) => s.status?.keyFailed === true)
  return (
    <>
      {failed && (
        <p className="mt-2.5 flex items-start gap-1.5 px-1 text-xs text-pretty text-danger">
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
          {t('hosts.keyFailed')}
        </p>
      )}
      <GroupNote>
        <Trans
          t={t}
          i18nKey="hosts.note"
          components={{
            link: (
              <button
                type="button"
                onClick={() => openSettings('remote')}
                className="rounded-sm text-primary underline-offset-2 outline-none hover:underline focus-ring"
              />
            ),
          }}
        />
      </GroupNote>
      {plain && <GroupNote>{t('hosts.plainTextKey')}</GroupNote>}
    </>
  )
}
