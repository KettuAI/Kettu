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
import { cn } from '@renderer/lib/utils'
import { usableAgents } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { openSettingsItem } from '@renderer/stores/view'
import {
  GroupLabel,
  ItemLine,
  ItemPageHeader,
  ItemRow,
  Notice,
  RowGroup,
  RowShell,
  RowText,
} from './rows'
import { Pill, ROW_BUTTON, SettingSwitch } from './controls'
import { useApply } from './use-apply'

/** Both groups wait for the first status this long, then show what comes, or a skeleton. */
const SKELETON_AFTER_MS = 200

/** The saved state of a switch: the settings the renderer holds, out of reach of the page. */
function useKettuOff(): AgentId[] {
  const { useSettingsStore } = useHostScope()
  return useSettingsStore((s) => s.settings.mcp.kettu.off)
}

/** Kettu's own server's tile, in the fox, at the size a row or a page header uses. */
function ServerTile({ size, glyph }: { size: number; glyph: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-segments bg-(image:--brand-kettu-tile) text-(--on-fill)"
    >
      <PlugIcon style={{ width: glyph, height: glyph }} />
    </span>
  )
}

/** Whether the server listens: a dot and the word, on its row and its page. */
function RunningDot({ running }: { running: boolean }) {
  const { t } = useTranslation('settings')
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 text-hint whitespace-nowrap',
        running ? 'text-secondary' : 'text-danger',
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.75 rounded-full', running ? 'bg-success' : 'bg-danger')}
      />
      {t(running ? 'mcp.state.running' : 'mcp.state.notRunning')}
    </span>
  )
}

/** "3 tools", and then who the server is off for. */
function ServerSummary({ server }: { server: McpStatus['servers'][number] }) {
  const { useAgentsStore } = useHostScope()
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
    <ItemLine>
      {t('mcp.row.tools', { count: server.tools.length })}
      {offLine && `${' · '}${offLine}`}
    </ItemLine>
  )
}

/** Kettu's own server in the list: its tile, its tool count and whether it runs. */
export function ServerRow({ server }: { server: McpStatus['servers'][number] }) {
  const { t } = useTranslation('settings')
  return (
    <ItemRow
      item={server.name}
      label={server.title}
      onOpen={() => openSettingsItem('mcp', server.name)}
      tile={<ServerTile size={34} glyph={17} />}
      name={
        <>
          <span className="truncate">{server.title}</span>
          {server.builtIn && <Pill>{t('mcp.builtIn')}</Pill>}
        </>
      }
      right={<RunningDot running={server.running} />}
    >
      <ServerSummary server={server} />
    </ItemRow>
  )
}

/** One agent's own configuration: its tile and name, then where its servers come from. */
export function AgentPlaceRow({ place }: { place: McpStatus['places'][number] }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const agent = useAgentsStore((s) => s.byId[place.agentId])
  const name = agent?.name ?? place.agentId
  return (
    <div className="flex items-center gap-3.5 py-3.25">
      <AgentTile agent={place.agentId} size={30} glyph={16} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label leading-tight">{name}</span>
        <span className="text-group text-pretty text-tertiary" data-selectable="">
          {place.listCommand
            ? t('mcp.place.ownWithCommand', { command: place.listCommand, file: place.project })
            : t('mcp.place.ownFrom', { path: place.path, file: place.project })}
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
  const { useMcpStore } = useHostScope()
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
          className={ROW_BUTTON}

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
  const { useMcpStore } = useHostScope()
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
        subtitle={
          <>
            <span className="font-mono text-code">{name}</span>
            {server?.builtIn && <Pill>{t('mcp.builtIn')}</Pill>}
          </>
        }
      >
        {server && <RunningDot running={server.running} />}
      </ItemPageHeader>
      {/* Until the first status, the page holds its shape rather than flashing an error. */}
      {!server ? (
        error ? (
          <FailedRead error={error} />
        ) : (
          <LoadingRows rows={1} />
        )
      ) : (
        <div className="flex flex-col">
          {!server.running && (
            <div className="mt-5">
              <NotRunning server={server} />
            </div>
          )}
          <AgentsGroup />
          <ToolsGroup tools={server.tools} />
        </div>
      )}
    </div>
  )
}

/** The notice a server that does not listen shows, with Retry at its end. */
function NotRunning({ server }: { server: McpStatus['servers'][number] }) {
  const { useMcpStore } = useHostScope()
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
          className={ROW_BUTTON}

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
  const { useAgentsStore } = useHostScope()
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
      {error && <p className="pb-1 text-hint text-danger">{error}</p>}
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
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const status = useAgentsStore((s) => s.byId[agentId])
  const name = status?.name ?? agentId
  const active = status?.kettuServer.active ?? null
  const runs = status?.kettuServer.runs ?? !off
  const takesNone = status?.capabilities.mcpHttp === false
  return (
    <RowShell>
      <div className="flex items-center gap-3.5 py-3.25">
        <AgentTile agent={agentId} size={30} glyph={16} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-label leading-tight">{name}</span>
          <span className="text-group text-tertiary">
            {takesNone
              ? t('mcp.agent.takesNone', { name })
              : t(off ? 'mcp.agent.off' : 'mcp.agent.on')}
          </span>
          {!takesNone && active !== null && active !== runs && (
            <span className="text-hint text-tertiary">{t('mcp.agent.nextStart', { name })}</span>
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
            <div className="py-3.25">
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
