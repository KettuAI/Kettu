import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { StrainTag } from '@renderer/features/settings/host-load'
import { diskBytes, memoryLevel, strainText } from '@renderer/features/settings/host-load-text'
import { useLiveLoad, useLoadWatch, useStrains } from '@renderer/stores/host-load'
import { openSettings, openSettingsItem } from '@renderer/stores/view'
import { useHostLabel } from './host-label'

/**
 * At the end of a host's heading while it runs low: its most pressing strain as a tag. Hovering it
 * shows CPU, memory and disk, read while the card is open; a click opens the host's page, or for
 * this computer the list of computers.
 */
export function HostStrain({ hostId }: { hostId: string | null }) {
  const { t } = useTranslation('settings')
  const strains = useStrains(hostId)
  const name = useHostLabel(hostId)
  const [open, setOpen] = useState(false)
  const strain = strains[0]
  if (!strain) return null
  const label = t('hosts.load.tagLabel', { name, strain: strainText(t, strain) })
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        delay={300}
        closeDelay={150}
        render={
          <button
            type="button"
            aria-label={label}
            className="kettu-host-strain"
            onClick={() => (hostId ? openSettingsItem('hosts', hostId) : openSettings('hosts'))}
          />
        }
      >
        <StrainTag strain={strain} />
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={8} className="w-[268px] p-0">
        <StrainCard hostId={hostId} name={name} />
      </HoverCardContent>
    </HoverCard>
  )
}

type Tone = 'cpu' | 'memory' | 'ok' | 'warn' | 'bad'

/** One line of the card: the name, a bar and the figure, in the tone of its state. */
function Line({
  name,
  value,
  text,
  tone,
}: {
  name: string
  value: number | null
  text: string
  tone: Tone
}) {
  return (
    <div className="kettu-strain-card__line" data-tone={tone}>
      <span>{name}</span>
      <span className="kettu-strain-card__bar" aria-hidden>
        {value !== null && <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />}
      </span>
      <b className="k-num">{text}</b>
    </div>
  )
}

function StrainCard({ hostId, name }: { hostId: string | null; name: string }) {
  const { t } = useTranslation('settings')
  useLoadWatch(hostId, false)
  const live = useLiveLoad(hostId)
  const strains = useStrains(hostId)
  const load = live?.load
  const diskStrain = strains.find((strain) => strain.kind === 'disk')
  const disk = load?.disks.find((d) => d.path === diskStrain?.path) ?? load?.disks[0]
  const memory = load && load.memory.total > 0 ? (load.memory.used / load.memory.total) * 100 : null
  const memoryTone = load ? memoryLevel(load) : 'ok'
  const diskUsed = disk && disk.total > 0 ? ((disk.total - disk.free) / disk.total) * 100 : null
  const none = '–'
  return (
    <div className="kettu-strain-card">
      <div className="kettu-strain-card__title">{name}</div>
      <Line
        name={t('hosts.load.cpu')}
        value={load?.cpu.percent ?? null}
        text={load ? `${Math.round(load.cpu.percent)}%` : none}
        tone="cpu"
      />
      <Line
        name={t('hosts.load.memory')}
        value={memory}
        text={memory === null ? none : `${Math.round(memory)}%`}
        tone={memoryTone === 'ok' ? 'memory' : memoryTone}
      />
      <Line
        name={t('hosts.load.disk')}
        value={diskUsed}
        text={disk ? diskBytes(disk.free) : none}
        tone={diskStrain ? (diskStrain.level === 'critical' ? 'bad' : 'warn') : 'ok'}
      />
      <div className="kettu-strain-card__foot">
        {disk && diskStrain
          ? t(hostId ? 'hosts.load.cardFoot' : 'hosts.load.cardFootSelf', {
              free: diskBytes(disk.free),
              path: disk.path,
            })
          : t(hostId ? 'hosts.load.cardOpen' : 'hosts.load.cardOpenSelf')}
      </div>
    </div>
  )
}
