// A host's load as Settings › Computers draws it: CPU and memory at the end of each row, the Load
// group at the top of a host's page with what uses the computer, and the tag that says a host runs
// low, which the sidebar and New session's host menu show too.

import { Fragment, useState, type ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  BatteryCharging01Icon,
  BatteryEmptyIcon,
  BatteryFullIcon,
  BatteryLowIcon,
  Chip02Icon,
  Clock01Icon,
  ComputerTerminal01Icon,
  CpuIcon,
  HardDriveIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  DISK_CRITICAL_BYTES,
  type HostDisk,
  type HostLoad,
  type HostLoadUsage,
  type HostStrain,
  type LoadUse,
} from '@shared/host-load'
import type { HostStatus } from '@shared/remote/hosts'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { revealSurface } from '@renderer/features/shell/open-surfaces'
import { basename, monthDay } from '@renderer/lib/format'
import type { LimitLevel } from '@renderer/lib/plan-limit'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import {
  SPARK_MS,
  useLiveLoad,
  useLoadUnsupported,
  useLoadWatch,
  useStrains,
  type LiveLoad,
} from '@renderer/stores/host-load'
import { useIdleRelease } from '@renderer/stores/idle-release'
import { useProjectsStore } from '@renderer/stores/projects'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { Meter, Segmented, Spin } from './controls'
import { diskBytes, memoryBytes, memoryLevel, memoryShare, strainText } from './host-load-text'
import { GroupLabel, GroupNote, Notice } from './rows'

const STRAIN_ICON: Record<HostStrain['kind'], IconSvgElement> = {
  memory: Chip02Icon,
  disk: HardDriveIcon,
  battery: BatteryEmptyIcon,
}

const whole = (value: number): string => (value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`)

/** A strain as a small tag: yellow while it warns, red once it gets in the way of work. */
export function StrainTag({ strain, className }: { strain: HostStrain; className?: string }) {
  const { t } = useTranslation('settings')
  return (
    <span className={cn('kettu-strain-tag', className)} data-level={strain.level}>
      <Icon icon={STRAIN_ICON[strain.kind]} size={11} />
      {strainText(t, strain)}
    </span>
  )
}

/** The most pressing strain of a host as a tag, or nothing while it runs fine. */
export function HostStrainTag({
  hostId,
  className,
}: {
  hostId: string | null
  className?: string
}) {
  const strain = useStrains(hostId)[0]
  return strain ? <StrainTag strain={strain} className={className} /> : null
}

/** CPU and memory at the end of a host's row, in fixed columns so the rows line up. */
export function LoadColumns({ load }: { load: HostLoad }) {
  const { t } = useTranslation('settings')
  const memory = memoryShare(load)
  return (
    <span className="k-load-cols">
      <span className="k-list-meter k-load-col">
        <span className="k-list-meter__label">{t('hosts.load.cpu')}</span>
        <Meter
          value={load.cpu.percent}
          text={whole(load.cpu.percent)}
          label={t('hosts.load.cpuLabel')}
        />
      </span>
      <span className="k-list-meter k-load-col" data-kind="memory">
        <span className="k-list-meter__label">{t('hosts.load.mem')}</span>
        <Meter
          value={memory}
          level={memoryLevel(load)}
          text={whole(memory)}
          label={t('hosts.load.memoryLabel')}
        />
      </span>
    </span>
  )
}

/** Up "12 days", "5 h" or "40 min". */
function uptimeText(t: TFunction<'settings'>, seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('hosts.load.uptime.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('hosts.load.uptime.hours', { count: hours })
  return t('hosts.load.uptime.days', { count: Math.floor(hours / 24) })
}

function minutesText(t: TFunction<'settings'>, minutes: number): string {
  const h = Math.floor(minutes / 60)
  return h > 0
    ? t('hosts.load.hoursMinutes', { h, m: minutes % 60 })
    : t('hosts.load.minutes', { m: minutes })
}

/** The strain of a disk, by its path, if it has one. */
const diskStrain = (strains: HostStrain[], disk: HostDisk): HostStrain | undefined =>
  strains.find((strain) => strain.kind === 'disk' && strain.path === disk.path)

const STRAIN_FILL: Record<HostStrain['level'], LimitLevel> = { warn: 'warn', critical: 'bad' }

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

/** A thin bar under a tile, in its own color or a strain's. */
function TileBar({
  value,
  tone,
}: {
  value: number
  tone: 'cpu' | 'memory' | 'disk' | 'battery' | LimitLevel
}) {
  return (
    <span className="k-load-bar" data-tone={tone} aria-hidden>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  )
}

const SPARK_W = 160
const SPARK_H = 46

/** The CPU of the last ten minutes: the host's minute points, then each reading since. */
function Sparkline({ live }: { live: LiveLoad }) {
  const end = live.load.at
  const firstRecent = live.recent[0]?.at ?? end
  const points = [
    // A minute's point stands at its middle, and gives way to the readings it overlaps.
    ...live.history
      .map((point) => ({ at: point.at + 30_000, cpu: point.cpu }))
      .filter((point) => point.at >= end - SPARK_MS && point.at < firstRecent),
    ...live.recent,
  ]
  if (points.length < 2) return null
  // A host read for less than ten minutes draws what it has across the whole width.
  const start = points[0]!.at
  const span = Math.max(1, end - start)
  const x = (at: number) => ((at - start) / span) * SPARK_W
  const y = (cpu: number) => SPARK_H - 2 - (Math.min(100, cpu) / 100) * (SPARK_H - 4)
  const line = points.map((point) => `${x(point.at).toFixed(1)},${y(point.cpu).toFixed(1)}`)
  const area = `${x(points[0]!.at).toFixed(1)},${SPARK_H} ${line.join(' ')} ${x(points.at(-1)!.at).toFixed(1)},${SPARK_H}`
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

function Tiles({ live, strains }: { live: LiveLoad; strains: HostStrain[] }) {
  const { t } = useTranslation('settings')
  const { load } = live
  const memory = memoryShare(load)
  const disk = load.disks[0]
  const battery = load.battery
  const average = load.cpu.loadAverage?.[0]
  const cores = load.container
    ? t('hosts.load.coresLimit', { count: load.cpu.cores })
    : t('hosts.load.cores', { count: load.cpu.cores })
  return (
    <div className="k-load-tiles">
      <Tile
        icon={CpuIcon}
        name={t('hosts.load.cpu')}
        value={whole(load.cpu.percent)}
        sub={
          average === undefined
            ? cores
            : `${cores} · ${t('hosts.load.loadAverage', { value: average.toFixed(1) })}`
        }
      >
        <Sparkline live={live} />
      </Tile>
      <Tile
        icon={Chip02Icon}
        name={t('hosts.load.memory')}
        value={whole(memory)}
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
      {disk ? (
        <Tile
          icon={HardDriveIcon}
          name={t('hosts.load.disk')}
          end={<span className="truncate">{disk.name}</span>}
          value={
            <>
              {diskBytes(disk.free)}
              <small>{t('hosts.load.free')}</small>
            </>
          }
          sub={
            load.disks.length > 1
              ? t('hosts.load.diskOfMany', {
                  total: diskBytes(disk.total),
                  count: load.disks.length,
                })
              : t('hosts.load.diskOf', { total: diskBytes(disk.total) })
          }
        >
          <TileBar
            value={disk.total > 0 ? ((disk.total - disk.free) / disk.total) * 100 : 0}
            tone={(() => {
              const strain = diskStrain(strains, disk)
              return strain ? STRAIN_FILL[strain.level] : 'disk'
            })()}
          />
        </Tile>
      ) : (
        <span />
      )}
      {battery ? (
        <BatteryTile load={load} strains={strains} />
      ) : (
        <Tile
          icon={Clock01Icon}
          name={t(load.container ? 'hosts.load.containerUptime' : 'hosts.load.uptimeTile')}
          value={uptimeText(t, load.uptime)}
          sub={t('hosts.load.since', { date: monthDay(load.at - load.uptime * 1000) })}
        />
      )}
    </div>
  )
}

function BatteryTile({ load, strains }: { load: HostLoad; strains: HostStrain[] }) {
  const { t } = useTranslation('settings')
  const battery = load.battery!
  const strain = strains.find((s) => s.kind === 'battery')
  const state = battery.onBattery
    ? t('hosts.load.onBattery')
    : battery.charging
      ? t('hosts.load.charging')
      : t('hosts.load.pluggedIn')
  const time =
    battery.minutesLeft === undefined
      ? null
      : t(battery.charging ? 'hosts.load.fullIn' : 'hosts.load.left', {
          time: minutesText(t, battery.minutesLeft),
        })
  const icon = battery.charging
    ? BatteryCharging01Icon
    : battery.percent !== undefined && battery.percent < 20
      ? BatteryLowIcon
      : BatteryFullIcon
  return (
    <Tile
      icon={icon}
      name={t('hosts.load.battery')}
      value={battery.percent === undefined ? state : `${battery.percent}%`}
      sub={battery.percent === undefined ? '' : [state, time].filter(Boolean).join(' · ')}
    >
      {battery.percent !== undefined && (
        <TileBar value={battery.percent} tone={strain ? STRAIN_FILL[strain.level] : 'battery'} />
      )}
    </Tile>
  )
}

/** One notice per strain over the tiles: the figure, and what it gets in the way of. */
function StrainNotices({ host, strains }: { host: HostStatus; strains: HostStrain[] }) {
  const { t } = useTranslation('settings')
  const idle = useIdleRelease(host.id)
  return strains.map((strain) => {
    const critical = strain.level === 'critical'
    const key = `${strain.kind}-${strain.path ?? ''}`
    let text: string
    if (strain.kind === 'disk') {
      text = t(critical ? 'hosts.load.notice.diskCritical' : 'hosts.load.notice.disk', {
        free: diskBytes(strain.value),
        path: strain.path ?? '',
        critical: diskBytes(DISK_CRITICAL_BYTES),
      })
    } else if (strain.kind === 'memory') {
      text = t('hosts.load.notice.memory', { name: host.name, percent: strain.value })
      if (idle?.rule?.now) text = `${text} ${t('hosts.load.notice.memoryRelease')}`
    } else {
      text = t(critical ? 'hosts.load.notice.batteryCritical' : 'hosts.load.notice.battery', {
        name: host.name,
        percent: strain.value,
      })
    }
    return (
      <Notice
        key={key}
        variant={critical ? 'error' : 'warning'}
        title={t(`hosts.load.notice.${strain.kind}Title`)}
      >
        {text}
      </Notice>
    )
  })
}

/**
 * The top of a host's page: its load now, read every 2 s while the page shows, and what uses it.
 * An old host says to update Kettu there; an offline one shows nothing here.
 */
export function HostLoadGroup({ host }: { host: HostStatus }) {
  const { t } = useTranslation('settings')
  const online = host.connection.state === 'online'
  useLoadWatch(host.id, true, online)
  const live = useLiveLoad(host.id)
  const unsupported = useLoadUnsupported(host.id)
  const strains = useStrains(host.id)
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
  return (
    <>
      <section aria-label={label} className="k-group">
        <GroupLabel
          group={{
            id: 'load',
            label,
            actions: (
              <span className="k-load-live">
                <span aria-hidden className="k-load-live__dot" />
                {t('hosts.load.live')}
              </span>
            ),
          }}
        />
        {strains.length > 0 && (
          <div className="k-load-notices">
            <StrainNotices host={host} strains={strains} />
          </div>
        )}
        {live ? (
          <Tiles live={live} strains={strains} />
        ) : (
          <div className="k-load-wait">
            <Spin />
          </div>
        )}
      </section>
      <UsingTheMost host={host} live={live} />
    </>
  )
}

type Order = 'cpu' | 'memory'

interface KettuRow {
  key: string
  use: LoadUse
  render: (order: Order) => ReactNode
}

function UsingTheMost({ host, live }: { host: HostStatus; live: LiveLoad | null }) {
  const { t } = useTranslation('settings')
  const [order, setOrder] = useState<Order>('cpu')
  const label = t('hosts.load.using')
  const usage = live?.usage ?? null
  const windows = host.platform === 'win32'
  return (
    <section aria-label={label} className="k-group">
      <GroupLabel
        group={{
          id: 'using',
          label,
          actions: windows ? undefined : (
            <Segmented
              label={t('hosts.load.order')}
              value={order}
              options={[
                { value: 'cpu', label: t('hosts.load.cpu') },
                { value: 'memory', label: t('hosts.load.memory') },
              ]}
              onChange={setOrder}
            />
          ),
        }}
      />
      {windows ? (
        <Notice variant="info" title={t('hosts.load.windows', { name: host.name })} />
      ) : usage && live ? (
        <UsageCard hostId={host.id} usage={usage} load={live.load} order={order} />
      ) : (
        <div className="ui-sg-card k-load-wait">
          <Spin />
        </div>
      )}
      <GroupNote>
        {[
          t('hosts.load.note', { name: host.name }),
          live ? t('hosts.load.up', { time: uptimeText(t, live.load.uptime) }) : null,
        ]
          .filter(Boolean)
          .join(' ')}
      </GroupNote>
    </section>
  )
}

function UsageCard({
  hostId,
  usage,
  load,
  order,
}: {
  hostId: string
  usage: HostLoadUsage
  load: HostLoad
  order: Order
}) {
  const { t } = useTranslation('settings')
  const by = (a: LoadUse, b: LoadUse) => b[order] - a[order]
  const own: KettuRow[] = [
    ...usage.sessions.map((session) => ({
      key: `s:${session.sessionId}`,
      use: session,
      render: (o: Order) => <SessionUse hostId={hostId} use={session} order={o} total={load} />,
    })),
    ...usage.agents.map((agent) => ({
      key: `a:${agent.agentId}`,
      use: agent,
      render: (o: Order) => (
        <UseRow
          lead={<AgentMark agent={agent.agentId} size={17} hostId={hostId} />}
          name={agentName(agent.agentId, hostId)}
          line={t('hosts.load.agentLine', { count: agent.sessions })}
          use={agent}
          order={o}
          total={load}
        />
      ),
    })),
    ...usage.terminals.map((terminal) => ({
      key: `t:${terminal.terminalId}`,
      use: terminal,
      render: (o: Order) => <TerminalUse terminal={terminal} order={o} total={load} />,
    })),
    {
      key: 'kettu',
      use: usage.kettu,
      render: (o: Order) => (
        <UseRow
          lead={<BrandIcon size={18} className="k-load-brand" />}
          name="Kettu"
          line={t(usage.kettu.daemon ? 'hosts.load.kettuDaemon' : 'hosts.load.kettuApp')}
          use={usage.kettu}
          order={o}
          total={load}
        />
      ),
    },
  ]
  own.sort((a, b) => by(a.use, b.use))
  const others = [...usage.others].sort(by)
  const shown = others.slice(0, 3)
  const rest = others
    .slice(3)
    .reduce(
      (sum, other) => ({ cpu: sum.cpu + other.cpu, memory: sum.memory + other.memory }),
      usage.rest,
    )
  return (
    <div className="ui-sg-card k-load-use">
      <div className="k-load-use__head">
        <span>{t('hosts.load.inKettu')}</span>
        <span className="k-load-use__cols">
          <span>{t('hosts.load.cpu')}</span>
          <span>{t('hosts.load.memory')}</span>
        </span>
      </div>
      {own.map((row) => (
        <Fragment key={row.key}>{row.render(order)}</Fragment>
      ))}
      <div className="k-load-use__head">
        <span>{t('hosts.load.otherApps')}</span>
      </div>
      {shown.map((other) => (
        <UseRow
          key={other.name}
          lead={<span className="k-load-letter">{other.name.slice(0, 1).toUpperCase()}</span>}
          name={other.name}
          use={other}
          order={order}
          total={load}
        />
      ))}
      <UseRow lead={null} name={t('hosts.load.rest')} quiet use={rest} order={order} total={load} />
    </div>
  )
}

function SessionUse({
  hostId,
  use,
  order,
  total,
}: {
  hostId: string
  use: HostLoadUsage['sessions'][number]
  order: Order
  total: HostLoad
}) {
  const { t } = useTranslation('settings')
  const summary = useSessionsStore((s) => s.byId[use.sessionId])
  const project = useProjectsStore((s) =>
    summary?.projectPath ? s.projects.find((p) => p.path === summary.projectPath) : undefined,
  )
  const commands = use.processes - 1
  const line = [
    t('hosts.load.sessionKind'),
    summary?.projectPath ? (project?.name ?? basename(summary.projectPath)) : null,
    commands > 0 ? t('hosts.load.commands', { count: commands }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <UseRow
      lead={summary ? <AgentMark agent={summary.agentId} size={17} hostId={hostId} /> : null}
      name={summary ? sessionTitle(summary) : t('hosts.load.sessionKind')}
      line={line}
      use={use}
      order={order}
      total={total}
      onOpen={summary ? () => openSession(summary.id, summary.projectPath) : undefined}
      openLabel={
        summary ? t('hosts.load.openSession', { title: sessionTitle(summary) }) : undefined
      }
    />
  )
}

function TerminalUse({
  terminal,
  order,
  total,
}: {
  terminal: HostLoadUsage['terminals'][number]
  order: Order
  total: HostLoad
}) {
  const { t } = useTranslation('settings')
  const summary = useSessionsStore((s) =>
    terminal.sessionId ? s.byId[terminal.sessionId] : undefined,
  )
  const project = useProjectsStore((s) =>
    summary?.projectPath ? s.projects.find((p) => p.path === summary.projectPath) : undefined,
  )
  const name = terminal.name || t('hosts.load.terminalKind')
  const line = [
    t('hosts.load.terminalKind'),
    summary?.projectPath ? (project?.name ?? basename(summary.projectPath)) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const open = summary
    ? () => {
        openSession(summary.id, summary.projectPath)
        revealSurface(summary.id, 'terminal', terminal.terminalId)
      }
    : undefined
  return (
    <UseRow
      lead={<Icon icon={ComputerTerminal01Icon} size={17} />}
      name={name}
      line={line}
      use={terminal}
      order={order}
      total={total}
      onOpen={open}
      openLabel={open ? t('hosts.load.openTerminal', { name }) : undefined}
    />
  )
}

/** One row of what uses the computer: its mark and lines, the share it uses, and its memory. */
function UseRow({
  lead,
  name,
  line,
  quiet,
  use,
  order,
  total,
  onOpen,
  openLabel,
}: {
  lead: ReactNode
  name: string
  line?: string
  quiet?: boolean
  use: LoadUse
  order: Order
  total: HostLoad
  onOpen?: () => void
  openLabel?: string
}) {
  const share =
    order === 'cpu' ? use.cpu : total.memory.total > 0 ? (use.memory / total.memory.total) * 100 : 0
  const body = (
    <>
      <span className="k-load-use__lead" aria-hidden>
        {lead}
      </span>
      <span className="k-load-use__text">
        <b className={cn(quiet && 'k-load-use__quiet')}>{name}</b>
        {line && <small>{line}</small>}
      </span>
      <span className="k-load-use__nums k-num">
        <span className="k-load-use__cpu">
          {order === 'cpu' && <TileBar value={share} tone="cpu" />}
          <b>{whole(use.cpu)}</b>
        </span>
        <span className="k-load-use__cpu">
          {order === 'memory' && <TileBar value={share} tone="memory" />}
          <span>{memoryBytes(use.memory)}</span>
        </span>
      </span>
    </>
  )
  if (!onOpen) return <div className="k-load-use__row">{body}</div>
  return (
    <button type="button" className="k-load-use__row" aria-label={openLabel} onClick={onOpen}>
      {body}
    </button>
  )
}
