import { useRef, useState } from 'react'
import { Add01Icon, ComputerIcon, LaptopIcon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { HostStatus, HostsStatus } from '@shared/remote/hosts'
import { Icon } from '@renderer/components/affect/app-shell'
import { useNow } from '@renderer/lib/use-now'
import { useLiveLoad, useLoadWatch } from '@renderer/stores/host-load'
import { useHostsStore } from '@renderer/stores/hosts'
import { openSettings, openSettingsItem } from '@renderer/stores/view'
import { AddHostDialog } from './host-add'
import { connectionText, platformName, routeText } from './host-text'
import { LoadColumns } from './host-load'
import { DeviceTile, HostIcon } from './remote-parts'
import { deviceShape } from './remote-text'
import { Pill, SetButton, Spin } from './controls'
import { GroupNote, ItemLine, ItemRow, Thing } from './rows'

/** Add host, at the end of the list's heading. */
export function AddHostButton() {
  const { t } = useTranslation('settings')
  const keyFailed = useHostsStore((s) => s.status?.keyFailed === true)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <SetButton
        ref={trigger}
        variant="primary"
        icon={<Icon icon={Add01Icon} size={14} />}
        disabled={keyFailed}
        onClick={() => setOpen(true)}
      >
        {t('hosts.add.button')}
      </SetButton>
      <AddHostDialog open={open} onOpenChange={setOpen} finalFocus={trigger} />
    </>
  )
}

/** Whether a host is online, or how it is not, as a badge on its row and its page. */
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
  const text = connectionText(t, host, now)
  // A host that cannot be used until Kettu is updated says so as a warning.
  if (state === 'stopped') {
    return (
      <Pill tone="warning" className={className}>
        {text}
      </Pill>
    )
  }
  if (state === 'online') {
    return (
      <Pill tone="success" className={className}>
        {text}
      </Pill>
    )
  }
  return (
    <span className="k-end">
      {state === 'connecting' && <Spin />}
      <Pill className={className}>{text}</Pill>
    </span>
  )
}

/**
 * A host's state at the end of its row: CPU and memory while it is online and reports them,
 * read every 2 s while the list shows, else whether it is online.
 */
function HostEnd({ host }: { host: HostStatus }) {
  const online = host.connection.state === 'online'
  useLoadWatch(host.id, online)
  const live = useLiveLoad(host.id)
  return online && live ? <LoadColumns load={live.load} /> : <HostState host={host} />
}

/** This computer, first in the list; nothing to open. */
export function SelfRow({ self }: { self: HostsStatus['self'] }) {
  const { t } = useTranslation('settings')
  const laptop = deviceShape({ kind: 'desktop', model: self.model }) === 'laptop'
  useLoadWatch(null)
  const live = useLiveLoad(null)
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<Icon icon={laptop ? LaptopIcon : ComputerIcon} size={20} />}
        name={
          <span className="k-host-title">
            <span className="k-name">{self.name || t('hosts.self.label')}</span>
            <Pill>{t('hosts.self.badge')}</Pill>
          </span>
        }
      >
        <ItemLine>
          {[
            t('hosts.self.label'),
            platformName(self.platform),
            t('hosts.version', { version: self.version }),
          ].join(' · ')}
        </ItemLine>
      </Thing>
      {live && (
        <span className="ui-sg-control k-load-self">
          <LoadColumns load={live.load} />
        </span>
      )}
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
      tile={<DeviceTile icon={<HostIcon platform={host.platform} />} />}
      name={<span className="k-name">{host.name}</span>}
      right={<HostEnd host={host} />}
    >
      <ItemLine>{routeText(t, host)}</ItemLine>
    </ItemRow>
  )
}

/** In place of the hosts while the remote host has not reported them. */
export function HostsLoading() {
  return (
    <div className="ui-sg-row">
      <Spin />
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
        <GroupNote>
          <span className="k-danger">{t('hosts.keyFailed')}</span>
        </GroupNote>
      )}
      <GroupNote>
        <Trans
          t={t}
          i18nKey="hosts.note"
          components={{
            link: (
              <button type="button" onClick={() => openSettings('remote')} className="k-link" />
            ),
          }}
        />
      </GroupNote>
      {plain && <GroupNote>{t('hosts.plainTextKey')}</GroupNote>}
    </>
  )
}
