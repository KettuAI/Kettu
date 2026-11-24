// A host's load as Kettu draws it: CPU and memory at the end of a row in Settings › Computers and
// in New session's host menu, with the battery while it runs on one, and the Load group at the top
// of a computer's page with its four figures.

import type { ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  ArrowDataTransferVerticalIcon,
  BatteryCharging01Icon,
  BatteryEmptyIcon,
  BatteryFullIcon,
  BatteryLowIcon,
  Chip02Icon,
  CpuIcon,
  HardDriveIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  BATTERY_CRITICAL_PERCENT,
  BATTERY_WARN_PERCENT,
  type HostBattery,
  type HostLoad,
} from '@shared/host-load'
import type { HostStatus } from '@shared/remote/hosts'
import { Icon } from '@renderer/components/affect/app-shell'
import type { LimitLevel } from '@renderer/lib/plan-limit'
import { cn } from '@renderer/lib/utils'
import {
  useHostLoadStore,
  useLiveLoad,
  useLoadUnsupported,
  useLoadWatch,
  type LiveLoad,
} from '@renderer/stores/host-load'
import { Meter, Spin } from './controls'
import {
  batteryLevel,
  diskBytes,
  diskLevel,
  memoryBytes,
  memoryLevel,
  memoryShare,
  rateText,
  wholePercent,
} from './host-load-text'
import { GroupLabel, GroupNote, Notice } from './rows'

function batteryIcon(battery: HostBattery): IconSvgElement {
  if (battery.charging) return BatteryCharging01Icon
  if (battery.percent === undefined) return BatteryFullIcon
  if (battery.percent <= BATTERY_CRITICAL_PERCENT) return BatteryEmptyIcon
  return battery.percent <= BATTERY_WARN_PERCENT ? BatteryLowIcon : BatteryFullIcon
}

/** The battery's icon and percent while the computer runs on it, in its level's color. */
export function OnBattery({ load, className }: { load: HostLoad; className?: string }) {
  const { t } = useTranslation('settings')
  const battery = load.battery
  if (!battery?.onBattery) return null
  const label =
    battery.percent === undefined
      ? t('hosts.load.onBattery')
      : t('hosts.load.onBatteryPercent', { percent: battery.percent })
  return (
    <span
      role="img"
      className={cn('k-load-battery k-num', className)}
      data-level={batteryLevel(battery)}
      aria-label={label}
    >
      <Icon icon={batteryIcon(battery)} size={13} />
      {battery.percent === undefined ? null : `${battery.percent}%`}
    </span>
  )
}

/**
 * Whether rows keep the battery's room: while any host shown runs on one, so the figures of the
 * others line up with its row.
 */
const useBatterySlot = (): boolean =>
  useHostLoadStore((s) =>
    Object.values(s.live).some((live) => live.load.battery?.onBattery === true),
  )

/** CPU and memory at the end of a host's row, in fixed columns so the rows line up. */
export function LoadColumns({ load }: { load: HostLoad }) {
  const { t } = useTranslation('settings')
  const slot = useBatterySlot()
  const memory = memoryShare(load)
  return (
    <span className="k-load-cols">
      <span className="k-list-meter k-load-col">
        <span className="k-list-meter__label">{t('hosts.load.cpu')}</span>
        <Meter
          value={load.cpu.percent}
          text={wholePercent(load.cpu.percent)}
          label={t('hosts.load.cpuLabel')}
        />
      </span>
      <span className="k-list-meter k-load-col" data-kind="memory">
        <span className="k-list-meter__label">{t('hosts.load.mem')}</span>
        <Meter
          value={memory}
          level={memoryLevel(load)}
          text={wholePercent(memory)}
          label={t('hosts.load.memoryLabel')}
        />
      </span>
      {slot && (
        <span className="k-load-battery-slot">
          <OnBattery load={load} />
        </span>
      )}
    </span>
  )
}

/**
 * The end of a host's row in New session's host menu: its CPU and memory now, and its battery
 * while it runs on one. Mounted only while the menu is open, which is when it is read.
 */
export function HostMenuLoad({ hostId }: { hostId: string | null }) {
  const { t } = useTranslation('settings')
  useLoadWatch(hostId)
  const live = useLiveLoad(hostId)
  const slot = useBatterySlot()
  if (!live) return null
  const { load } = live
  return (
    <span className="k-load-menu k-num">
      <span className="k-load-menu__label">{t('hosts.load.cpu')}</span>
      <span className="k-load-menu__value">{wholePercent(load.cpu.percent)}</span>
      <span className="k-load-menu__label">{t('hosts.load.mem')}</span>
      <span className="k-load-menu__value" data-level={memoryLevel(load)}>
        {wholePercent(memoryShare(load))}
      </span>
      {slot && (
        <span className="k-load-battery-slot">
          <OnBattery load={load} />
        </span>
      )}
    </span>
  )
}

function minutesText(t: TFunction<'settings'>, minutes: number): string {
  const h = Math.floor(minutes / 60)
  return h > 0
    ? t('hosts.load.hoursMinutes', { h, m: minutes % 60 })
    : t('hosts.load.minutes', { m: minutes })
}

/** "Battery 86% · Charging", "On battery · 18% · 1 h 20 min left", next to Live. */
function BatteryItem({ battery }: { battery: HostBattery }) {
  const { t } = useTranslation('settings')
  const percent = battery.percent === undefined ? null : `${battery.percent}%`
  const parts = battery.onBattery
    ? [
        t('hosts.load.onBattery'),
        percent,
        battery.minutesLeft === undefined
          ? null
          : t('hosts.load.left', { time: minutesText(t, battery.minutesLeft) }),
      ]
    : [
        battery.percent === undefined
          ? t('hosts.load.battery')
          : t('hosts.load.batteryPercent', { percent: battery.percent }),
        t(battery.charging ? 'hosts.load.charging' : 'hosts.load.pluggedIn'),
      ]
  return (
    <span className="k-load-battery k-load-battery--head" data-level={batteryLevel(battery)}>
      <Icon icon={batteryIcon(battery)} size={14} />
      <span className="k-num">{parts.filter(Boolean).join(' · ')}</span>
    </span>
  )
}

function Tile({
  icon,
  name,
  end,
  value,
  sub,
  children,
}: {
  icon: IconSvgElement
  name: string
  end?: ReactNode
  value: ReactNode
  sub: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="k-load-tile">
      <div className="k-load-tile__head">
        <Icon icon={icon} size={14} />
        <span>{name}</span>
        {end && <span className="k-load-tile__end">{end}</span>}
      </div>
      <div className="k-load-tile__value k-num">{value}</div>
      <div className="k-load-tile__sub">{sub}</div>
      {children}
    </div>
  )
}

/** A thin bar under a tile, in its own color or its level's. */
function TileBar({ value, tone }: { value: number; tone: 'memory' | 'disk' | LimitLevel }) {
  return (
    <span className="k-load-bar" data-tone={tone} aria-hidden>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  )
}

const SPARK_W = 160
const SPARK_H = 46

/** The CPU of each reading since the page opened, up to the last ten minutes. */
function Sparkline({ live }: { live: LiveLoad }) {
  const points = live.recent
  if (points.length < 2) return <span className="k-load-spark" aria-hidden />
  // Until ten minutes are read, what there is spans the whole width.
  const start = points[0]!.at
  const span = Math.max(1, points.at(-1)!.at - start)
  const x = (at: number) => ((at - start) / span) * SPARK_W
  const y = (cpu: number) => SPARK_H - 2 - (Math.min(100, cpu) / 100) * (SPARK_H - 4)
  const line = points.map((point) => `${x(point.at).toFixed(1)},${y(point.cpu).toFixed(1)}`)
  const area = `0,${SPARK_H} ${line.join(' ')} ${SPARK_W},${SPARK_H}`
  return (
    <svg
      className="k-load-spark"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polygon points={area} />
      <polyline points={line.join(' ')} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Tiles({ live }: { live: LiveLoad }) {
  const { t } = useTranslation('settings')
  const { load } = live
  const memory = memoryShare(load)
  const { disk, io, network } = load
  const none = '–'
  return (
    <div className="k-load-tiles">
      <Tile
        icon={CpuIcon}
        name={t('hosts.load.cpu')}
        value={wholePercent(load.cpu.percent)}
        sub={t(load.container ? 'hosts.load.coresLimit' : 'hosts.load.cores', {
          count: load.cpu.cores,
        })}
      >
        <Sparkline live={live} />
      </Tile>
      <Tile
        icon={Chip02Icon}
        name={t('hosts.load.memory')}
        value={wholePercent(memory)}
        sub={[
          t('hosts.load.memoryOf', {
            used: memoryBytes(load.memory.used),
            total: memoryBytes(load.memory.total),
          }),
          load.memory.state === 'unknown' ? null : t(`hosts.load.memoryState.${load.memory.state}`),
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <TileBar value={memory} tone={memoryLevel(load) === 'ok' ? 'memory' : memoryLevel(load)} />
      </Tile>
      <Tile
        icon={HardDriveIcon}
        name={t('hosts.load.disk')}
        end={disk && <span className="truncate">{disk.name}</span>}
        value={
          disk ? (
            <>
              {diskBytes(disk.free)}
              <small>{t('hosts.load.free')}</small>
            </>
          ) : (
            none
          )
        }
        sub={disk ? t('hosts.load.diskOf', { total: diskBytes(disk.total) }) : none}
      >
        <div className="k-load-tile__sub">
          {t('hosts.load.io', {
            read: rateText(io?.readPerSecond),
            write: rateText(io?.writePerSecond),
          })}
        </div>
        {disk && (
          <TileBar
            value={disk.total > 0 ? ((disk.total - disk.free) / disk.total) * 100 : 0}
            tone={diskLevel(disk.free) === 'ok' ? 'disk' : diskLevel(disk.free)}
          />
        )}
      </Tile>
      <Tile
        icon={ArrowDataTransferVerticalIcon}
        name={t('hosts.load.network')}
        value={
          <span
            className="k-load-pair"
            aria-label={t('hosts.load.networkLabel', {
              receive: rateText(network?.receivePerSecond),
              send: rateText(network?.sendPerSecond),
            })}
          >
            <span aria-hidden>↓ {rateText(network?.receivePerSecond)}</span>
            <span aria-hidden>↑ {rateText(network?.sendPerSecond)}</span>
          </span>
        }
        sub={t('hosts.load.networkSub')}
      />
    </div>
  )
}

/**
 * The top of a computer's page: its CPU, memory, disk and network now, and its battery beside
 * Live, read every 2 s while the page shows. An old host says to update Kettu there; an offline
 * one shows nothing here.
 */
export function HostLoadGroup({ host }: { host: HostStatus }) {
  const { t } = useTranslation('settings')
  const online = host.connection.state === 'online'
  useLoadWatch(host.id, online)
  const live = useLiveLoad(host.id)
  const unsupported = useLoadUnsupported(host.id)
  if (!online) return null
  const label = t('hosts.load.group')
  if (unsupported) {
    return (
      <section aria-label={label} className="k-group">
        <GroupLabel group={{ id: 'load', label }} />
        <Notice variant="info" title={t('hosts.load.old', { name: host.name })} />
      </section>
    )
  }
  const battery = live?.load.battery
  return (
    <section aria-label={label} className="k-group">
      <GroupLabel
        group={{
          id: 'load',
          label,
          actions: (
            <span className="k-load-head">
              {battery && <BatteryItem battery={battery} />}
              <span className="k-load-live">
                <span aria-hidden className="k-load-live__dot" />
                {t('hosts.load.live')}
              </span>
            </span>
          ),
        }}
      />
      {live ? (
        <Tiles live={live} />
      ) : (
        <div className="k-load-wait">
          <Spin />
        </div>
      )}
      <GroupNote>{t('hosts.load.note', { name: host.name })}</GroupNote>
    </section>
  )
}
