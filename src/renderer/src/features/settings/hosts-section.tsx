import { useState } from 'react'
import { Add01Icon, ComputerIcon, LaptopIcon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { HostStatus, HostsStatus } from '@shared/remote/hosts'
import { Icon } from '@renderer/components/affect/app-shell'
import { useNow } from '@renderer/lib/use-now'
import { useHostsStore } from '@renderer/stores/hosts'
import { openSettings, openSettingsItem } from '@renderer/stores/view'
import { AddHostDialog } from './host-add'
import { connectionText, platformName, routeText } from './host-text'
import { DeviceTile, HostIcon } from './remote-parts'
import { deviceShape } from './remote-text'
import { Pill, SetButton, Spin } from './controls'
import { GroupNote, ItemLine, ItemRow, Thing } from './rows'

/** Add host, at the end of the list's heading. */
export function AddHostButton() {
  const { t } = useTranslation('settings')
  const keyFailed = useHostsStore((s) => s.status?.keyFailed === true)
  const [open, setOpen] = useState(false)
  return (
    <>
      <SetButton
        variant="primary"
        icon={<Icon icon={Add01Icon} size={14} />}
        disabled={keyFailed}
        onClick={() => setOpen(true)}
      >
        {t('hosts.add.button')}
      </SetButton>
      <AddHostDialog open={open} onOpenChange={setOpen} />
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

/** This computer, first in the list; nothing to open. */
export function SelfRow({ self }: { self: HostsStatus['self'] }) {
  const { t } = useTranslation('settings')
  const laptop = deviceShape({ kind: 'desktop', model: self.model }) === 'laptop'
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<Icon icon={laptop ? LaptopIcon : ComputerIcon} size={20} />}
        name={<span className="k-name">{self.name || t('hosts.self.label')}</span>}
      >
        <ItemLine>
          {[
            t('hosts.self.label'),
            platformName(self.platform),
            t('hosts.version', { version: self.version }),
          ].join(' · ')}
        </ItemLine>
      </Thing>
      <span className="ui-sg-control">
        <Pill>{t('hosts.self.badge')}</Pill>
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
      tile={<DeviceTile icon={<HostIcon platform={host.platform} />} />}
      name={<span className="k-name">{host.name}</span>}
      right={<HostState host={host} />}
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
