import { useEffect, useState } from 'react'
import { CircleAlertIcon, PlugIcon, RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { McpStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useMcpStore } from '@renderer/stores/mcp'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSettingsItem } from '@renderer/stores/view'
import { ConfigNote, ConfigPath } from './places'
import { GroupLabel, ItemPageHeader, ItemRow, Notice, RowGroup, RowShell, RowText } from './rows'
import { SettingSwitch } from './controls'
import { useApply } from './use-apply'

/** Both groups wait for the first status this long, then show what comes, or a skeleton. */
const SKELETON_AFTER_MS = 200

/** The saved state of a switch: the settings the renderer holds, out of reach of the page. */
function useKettuOff(): AgentId[] {
  return useSettingsStore((s) => s.settings.mcp.kettu.off)
}

/** The shell's tile for Kettu's own server, at the size a row or a page header uses. */
function ServerTile({ size, glyph }: { size: number; glyph: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid place-items-center rounded-lg bg-tile text-icon shadow-[inset_0_0_var(--hairline)_var(--border-subtle)]"
    >
      <PlugIcon style={{ width: glyph, height: glyph }} />
    </span>
  )
}

/** Whether the server listens, as a dot alone on the row and in words on its page. */
function RunningDot({ running, words }: { running: boolean; words: boolean }) {
  const { t } = useTranslation('settings')
  const label = t(running ? 'mcp.state.running' : 'mcp.state.notRunning')
  if (words) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 font-medium',
          running ? 'text-secondary' : 'text-danger',
        )}
      >
        <span
          aria-hidden
          className={cn('size-1.5 rounded-full', running ? 'bg-success' : 'bg-danger')}
        />
        {label}
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="flex h-4 items-center px-1" />}
      >
        <span
          className={cn('size-1.5 rounded-full', running ? 'bg-success' : 'bg-danger')}
          aria-hidden
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** "3 tools", and then who the server is off for. */
function ServerSummary({ server }: { server: McpStatus['servers'][number] }) {
  const { t } = useTranslation('settings')
  const off = useKettuOff()
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const names = off.map((id) => agents.find((a) => a.id === id)?.name ?? id)
  const every = agents.length > 0 && agents.every((a) => off.includes(a.id))
  const offLine = every
    ? t('mcp.row.offEvery')
    : names.length > 0
      ? t('mcp.row.off', { names: names.join(', ') })
      : null
  return (
    <span className="flex min-h-4.5 min-w-0 items-center text-command leading-4.5 text-secondary">
      <span className="min-w-0 truncate">
        {t('mcp.row.tools', { count: server.tools.length })}
        {offLine && `${' · '}${offLine}`}
      </span>
    </span>
  )
}

/** Kettu's own server in the list: its tile, its tool count and its state. */
export function ServerRow({ server }: { server: McpStatus['servers'][number] }) {
  return (
    <ItemRow
      item={server.name}
      label={server.title}
      onOpen={() => openSettingsItem('mcp', server.name)}
      tile={<ServerTile size={30} glyph={16} />}
      name={<span className="truncate text-ui font-medium">{server.title}</span>}
      right={<RunningDot running={server.running} words={false} />}
    >
      <ServerSummary server={server} />
    </ItemRow>
  )
}

/** One agent's own configuration: its tile and name, then the file as a place. */
export function AgentPlaceRow({ place }: { place: McpStatus['places'][number] }) {
  const { t } = useTranslation('settings')
  const agent = useAgentsStore((s) => s.byId[place.agentId])
  const name = agent?.name ?? place.agentId
  return (
    <div className="flex items-start gap-3 py-3">
      <AgentTile agent={place.agentId} size={30} glyph={16} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-ui font-medium">{name}</span>
        <span className="text-xs text-secondary">
          {t('mcp.place.connects', { name })}
          {place.listCommand && ` ${t('mcp.place.list', { command: place.listCommand })}`}
        </span>
        <ConfigPath item={place} />
        <ConfigNote item={place} />
        <span className="text-xs text-tertiary">
          {t('mcp.place.project', { file: place.project })}
        </span>
      </div>
    </div>
  )
}

/** Skeleton rows while the first status is on its way, once a short wait has passed. */
function LoadingRows({ rows }: { rows: number }) {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), SKELETON_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])
  if (!late) return null
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <RowShell key={i} plain>
          <div className="flex items-center gap-3 py-3">
            <Skeleton className="size-7.5 rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        </RowShell>
      ))}
    </>
  )
}

/** In place of both groups when the read failed: what went wrong and Retry at its end. */
export function FailedRead({ error }: { error: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const [busy, setBusy] = useState(false)
  const retry = useMcpStore((s) => s.retry)
  return (
    <Notice
      variant="error"
      icon={<CircleAlertIcon />}
      title={t('mcp.error.title')}
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void retry().finally(() => setBusy(false))
          }}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
          {t('common:actions.retry')}
        </Button>
      }
    >
      <span className="font-mono text-code break-words" data-selectable="">
        {error}
      </span>
    </Notice>
  )
}

/** Both groups while the first status is on its way: skeletons after a short wait. */
export function PendingList() {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col gap-7">
      {[
        { id: 'kettu', label: t('mcp.groups.kettu'), rows: 1 },
        { id: 'own', label: t('mcp.groups.own'), rows: 3 },
      ].map((group) => (
        <section key={group.id} className="flex flex-col" aria-label={group.label}>
          <GroupLabel group={{ id: group.id, label: group.label }} />
          <RowGroup>
            <LoadingRows rows={group.rows} />
          </RowGroup>
        </section>
      ))}
    </div>
  )
}

/** Kettu's own server's page: its state, the agents it is for and its tools. */
export function McpServerPage({ name }: { name: string }) {
  const { t } = useTranslation('settings')
  const status = useMcpStore((s) => s.status)
  const error = useMcpStore((s) => s.error)
  const server = status?.servers.find((s) => s.name === name) ?? null
  return (
    <div className="flex flex-col">
      <ItemPageHeader
        back={t('sections.mcp')}
        onBack={() => openSettingsItem('mcp', null)}
        item={name}
        icon={<ServerTile size={40} glyph={20} />}
        title={server?.title ?? name}
      >
        <p className="flex min-w-0 items-center gap-1.75 text-command leading-4.5 text-tertiary">
          {server && <RunningDot running={server.running} words />}
          <span aria-hidden>·</span>
          <span className="font-mono text-code">{name}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{t('mcp.server.builtIn')}</span>
        </p>
      </ItemPageHeader>
      {/* Until the first status, the page holds its shape rather than flashing an error. */}
      {!server ? (
        error ? (
          <FailedRead error={error} />
        ) : (
          <LoadingRows rows={1} />
        )
      ) : (
        <div className="flex flex-col gap-7">
          {!server.running && <NotRunning server={server} />}
          <AgentsGroup />
          <ToolsGroup tools={server.tools} />
        </div>
      )}
    </div>
  )
}

/** The notice a server that does not listen shows, with Retry at its end. */
function NotRunning({ server }: { server: McpStatus['servers'][number] }) {
  const { t } = useTranslation(['settings', 'common'])
  const retry = useMcpStore((s) => s.retry)
  const [busy, setBusy] = useState(false)
  return (
    <Notice
      variant="error"
      icon={<CircleAlertIcon />}
      title={t('mcp.server.notRunning.title')}
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void retry().finally(() => setBusy(false))
          }}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
          {t('common:actions.retry')}
        </Button>
      }
      more={
        server.error ? (
          <span className="font-mono text-code break-words text-danger" data-selectable="">
            {server.error}
          </span>
        ) : null
      }
    >
      {t('mcp.server.notRunning.body')}
    </Notice>
  )
}

/** A switch per agent in catalog order: whether its sessions get Kettu's tools. */
function AgentsGroup() {
  const { t } = useTranslation('settings')
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const off = useKettuOff()
  const [apply, error] = useApply()
  const set = (agentId: AgentId, on: boolean) => {
    const next = on ? off.filter((id) => id !== agentId) : [...off, agentId]
    apply({ mcp: { kettu: { off: next } } })
  }
  return (
    <section className="flex flex-col" aria-label={t('mcp.agents')}>
      <GroupLabel group={{ id: 'agents', label: t('mcp.agents'), count: agents.length }} />
      {error && <p className="px-1 pb-1 text-xs text-danger">{error}</p>}
      <RowGroup>
        {agents.map((agent) => (
          <AgentSwitchRow
            key={agent.id}
            agentId={agent.id}
            off={off.includes(agent.id)}
            set={set}
          />
        ))}
      </RowGroup>
    </section>
  )
}

function AgentSwitchRow({
  agentId,
  off,
  set,
}: {
  agentId: AgentId
  off: boolean
  set: (agentId: AgentId, on: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const status = useAgentsStore((s) => s.byId[agentId])
  const name = status?.name ?? agentId
  const active = status?.kettuServer.active ?? null
  const runs = status?.kettuServer.runs ?? !off
  const takesNone = status?.capabilities.mcpHttp === false
  return (
    <RowShell>
      <div className="flex items-center gap-3 py-2.5">
        <AgentTile agent={agentId} size={30} glyph={16} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui font-medium">{name}</span>
          <span className="text-xs text-secondary">
            {takesNone
              ? t('mcp.agent.takesNone', { name })
              : t(off ? 'mcp.agent.off' : 'mcp.agent.on')}
          </span>
          {!takesNone && active !== null && active !== runs && (
            <span className="text-xs text-muted-foreground">
              {t('mcp.agent.nextStart', { name })}
            </span>
          )}
        </div>
        {!takesNone && (
          <SettingSwitch
            label={t('mcp.agent.switch', { name })}
            checked={!off}
            onChange={(on) => set(agentId, on)}
          />
        )}
      </div>
    </RowShell>
  )
}

/** A row per tool in the order the server lists them, its name in mono and its first sentence. */
function ToolsGroup({ tools }: { tools: McpStatus['servers'][number]['tools'] }) {
  const { t } = useTranslation('settings')
  return (
    <section className="flex flex-col" aria-label={t('mcp.tools')}>
      <GroupLabel group={{ id: 'tools', label: t('mcp.tools'), count: tools.length }} />
      <RowGroup>
        {tools.map((tool) => (
          <RowShell key={tool.name}>
            <div className="py-2.5">
              <RowText
                name={<span className="font-mono text-code">{tool.name}</span>}
                description={tool.description}
              />
            </div>
          </RowShell>
        ))}
      </RowGroup>
    </section>
  )
}
