import { useEffect, useState } from 'react'
import { PlugSocketIcon, RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { McpStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentTile } from '@renderer/components/agents/agent-mark'
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
  Thing,
} from './rows'
import { Pill, SetButton, SettingSwitch, Skel } from './controls'
import { PlaceAction } from './places'
import { useApply } from './use-apply'

/** Both groups wait for the first status this long, then show what comes, or a skeleton. */
const SKELETON_AFTER_MS = 200

/** The saved state of a switch: the settings the renderer holds, out of reach of the page. */
function useKettuOff(): AgentId[] {
  const { useSettingsStore } = useHostScope()
  return useSettingsStore((s) => s.settings.mcp.kettu.off)
}

/** Kettu's own server's mark, unframed, at the size a row or a page header uses. */
function ServerTile({ size }: { size: number }) {
  return <Icon icon={PlugSocketIcon} size={size} />
}

/** Whether the server listens, as a badge on its row and its page. */
function RunningDot({ running }: { running: boolean }) {
  const { t } = useTranslation('settings')
  return running ? (
    <Pill tone="success">{t('mcp.state.running')}</Pill>
  ) : (
    <span className="ui-ss-badge" data-tone="danger">
      {t('mcp.state.notRunning')}
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
      tile={<ServerTile size={20} />}
      name={
        <>
          <span className="k-name">{server.title}</span>
          {server.builtIn && <Pill>{t('mcp.builtIn')}</Pill>}
        </>
      }
      right={<RunningDot running={server.running} />}
    >
      <ServerSummary server={server} />
    </ItemRow>
  )
}

/**
 * One agent's own configuration: its tile and name, then where its servers come from, saying so
 * when the file is not there yet, with Show in Finder or Copy path at the end while it is.
 */
export function AgentPlaceRow({ place }: { place: McpStatus['places'][number] }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const agent = useAgentsStore((s) => s.byId[place.agentId])
  const name = agent?.name ?? place.agentId
  const note = place.chosen
    ? t('agents.chosenInKettu')
    : place.env && t('agents.setByLine', { env: place.env })
  const values = {
    path: note ? t('mcp.place.pathNote', { path: place.path, note }) : place.path,
    command: place.listCommand,
    file: place.project,
  }
  // Where a command lists the servers, the line names the file only when it is missing or moved.
  const line = place.listCommand
    ? t(
        !place.exists
          ? 'mcp.place.ownWithCommandMissing'
          : note
            ? 'mcp.place.ownWithCommandFrom'
            : 'mcp.place.ownWithCommand',
        values,
      )
    : t(place.exists ? 'mcp.place.ownFrom' : 'mcp.place.ownFromMissing', values)
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<AgentTile agent={place.agentId} size={24} />}
        name={<span className="k-name">{name}</span>}
      >
        <small className="k-clamp" title={line} data-selectable="">
          {line}
        </small>
      </Thing>
      {place.exists && (
        <span className="ui-sg-control">
          <PlaceAction path={place.path} icon />
        </span>
      )}
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
        <RowShell key={i}>
          <div className="ui-sg-row">
            <Thing mark={<Skel width={24} className="k-skel--mark" />} name={<Skel width={128} />}>
              <Skel width={192} />
            </Thing>
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
      title={t('mcp.error.title')}
      action={
        <SetButton
          loading={busy}
          icon={<Icon icon={RefreshIcon} size={14} />}
          onClick={() => {
            setBusy(true)
            void retry().finally(() => setBusy(false))
          }}
        >
          {t('common:actions.retry')}
        </SetButton>
      }
    >
      <span className="k-mono k-break" data-selectable="">
        {error}
      </span>
    </Notice>
  )
}

/** Both groups while the first status is on its way: skeletons after a short wait. */
export function PendingList() {
  const { t } = useTranslation('settings')
  return (
    <div className="k-groups">
      {[
        { id: 'kettu', label: t('mcp.groups.kettu'), rows: 1 },
        { id: 'own', label: t('mcp.groups.own'), rows: 3 },
      ].map((group) => (
        <section key={group.id} className="k-group" aria-label={group.label}>
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
    <>
      <ItemPageHeader
        back={t('sections.mcp')}
        onBack={() => openSettingsItem('mcp', null)}
        item={name}
        icon={<ServerTile size={28} />}
        title={server?.title ?? name}
        subtitle={
          <>
            <span className="k-mono">{name}</span>
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
        <div className="k-groups">
          {!server.running && <NotRunning server={server} />}
          <AgentsGroup />
          <ToolsGroup tools={server.tools} />
        </div>
      )}
    </>
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
      title={t('mcp.server.notRunning.title')}
      action={
        <SetButton
          loading={busy}
          icon={<Icon icon={RefreshIcon} size={14} />}
          onClick={() => {
            setBusy(true)
            void retry().finally(() => setBusy(false))
          }}
        >
          {t('common:actions.retry')}
        </SetButton>
      }
      more={
        server.error ? (
          <span className="k-mono k-break k-danger" data-selectable="">
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
    <section className="k-group" aria-label={t('mcp.agents')}>
      <GroupLabel group={{ id: 'agents', label: t('mcp.agents'), count: agents.length }} />
      {error && <p className="ui-sg-hint k-danger">{error}</p>}
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
      <div className="ui-sg-row">
        <Thing
          mark={<AgentTile agent={agentId} size={24} />}
          name={<span className="k-name">{name}</span>}
        >
          <small>
            {takesNone
              ? t('mcp.agent.takesNone', { name })
              : t(off ? 'mcp.agent.off' : 'mcp.agent.on')}
          </small>
          {!takesNone && active !== null && active !== runs && (
            <small>{t('mcp.agent.nextStart', { name })}</small>
          )}
        </Thing>
        {!takesNone && (
          <span className="ui-sg-control">
            <SettingSwitch
              label={t('mcp.agent.switch', { name })}
              checked={!off}
              onChange={(on) => set(agentId, on)}
            />
          </span>
        )}
      </div>
    </RowShell>
  )
}

/** A row per tool in the order the server lists them, its name in mono and its first sentence. */
function ToolsGroup({ tools }: { tools: McpStatus['servers'][number]['tools'] }) {
  const { t } = useTranslation('settings')
  return (
    <section className="k-group" aria-label={t('mcp.tools')}>
      <GroupLabel group={{ id: 'tools', label: t('mcp.tools'), count: tools.length }} />
      <RowGroup>
        {tools.map((tool) => (
          <RowShell key={tool.name}>
            <div className="ui-sg-row">
              <RowText
                name={<span className="k-mono">{tool.name}</span>}
                description={tool.description}
              />
            </div>
          </RowShell>
        ))}
      </RowGroup>
    </section>
  )
}
