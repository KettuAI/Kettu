// What a kept MCP server's page shows of it as Kettu runs it: the instances running and who gets
// it on Overview, then its tools, its recent calls and its processes' logs, each in a tab.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Search01Icon,
  SquareLock02Icon,
} from '@hugeicons/core-free-icons'
import { harnessOf, type AgentId } from '@shared/agents'
import { MCP_TERMINAL_APPS } from '@shared/mcp-terminal'
import type { MarketServer } from '@shared/marketplace'
import type {
  McpCallRecord,
  McpCallResult,
  McpInstanceInfo,
  McpProjects,
  McpServerInsight,
  McpServerLog,
  McpToolInfo,
} from '@shared/mcp-insight'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { toast } from '@renderer/components/ui/toast'
import { SettingSwitch } from '@renderer/features/settings/controls'
import { bytes, clockTime, mediumAgo, monthDayTime, tokens } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { useHostScope } from '@renderer/stores/host-scope'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { changeServer, goesTo, setServerAgents } from './actions'
import { McpToolChangesBanner, McpToolChangesDialog } from './mcp-tool-changes'
import { useAgentName, useMcpToolChanges } from './hooks'
import { McpSignIn } from './mcp-library'
import { homeShort } from './model'

const REFRESH_MS = 5_000

/** Overview's processes or connections of a command server, with Stop. */
export function McpRunning({ server }: { server: MarketServer }) {
  const { t } = useTranslation('marketplace')
  const { request } = useHostScope()
  const [instances, setInstances] = useState<McpInstanceInfo[] | null>(null)
  const read = useCallback(() => {
    request('market.mcpInstances', { serverId: server.id })
      .then(setInstances)
      .catch(() => setInstances([]))
  }, [request, server.id])
  useEffect(() => {
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => clearInterval(timer)
  }, [read])
  const running = (instances ?? []).filter((instance) => instance.running)
  const stop = (instance: McpInstanceInfo) => {
    request('market.mcpStop', { serverId: server.id, instance: instance.id })
      .catch((error: unknown) =>
        toast(t('mcp.page.stopFailed', { error: errorMessage(error) }), undefined, {
          tone: 'warning',
        }),
      )
      .finally(read)
  }
  return (
    <section className="k-mcp-server-card">
      <h2>{t('mcp.page.running')}</h2>
      {running.length === 0 ? (
        <p className="k-mcp-muted">{t('mcp.page.noneRunning')}</p>
      ) : (
        <ul className="k-mcp-rows">
          {running.map((instance) => (
            <InstanceRow key={instance.id} instance={instance} stop={() => stop(instance)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function InstanceRow({ instance, stop }: { instance: McpInstanceInfo; stop(): void }) {
  const { t } = useTranslation('marketplace')
  const session = useSessionsStore((s) =>
    instance.sessionId ? s.byId[instance.sessionId] : undefined,
  )
  const where =
    instance.sharing === 'all'
      ? t('mcp.page.sharedAll')
      : instance.sharing === 'folder'
        ? t('mcp.page.sharedFolder', { folder: homeShort(instance.folder) })
        : (session?.title ?? t('mcp.page.aSession'))
  const facts = [
    instance.sharing === 'session' || instance.sharing === 'link'
      ? homeShort(instance.folder)
      : null,
    instance.startedAt ? t('mcp.page.started', { time: clockTime(instance.startedAt) }) : null,
    instance.lastCallAt
      ? t('mcp.page.lastCall', { ago: mediumAgo(instance.lastCallAt) })
      : t('mcp.page.noCall'),
    instance.stopsAt ? t('mcp.page.stopsAt', { time: clockTime(instance.stopsAt) }) : null,
  ].filter(Boolean)
  return (
    <li className="k-mcp-row">
      <span className="k-mcp-row__main">
        <span className="k-mcp-row__title">{where}</span>
        <span className="k-mcp-row__facts">{facts.join(' · ')}</span>
      </span>
      <Button size="sm" variant="secondary" onClick={stop}>
        {t('mcp.page.stop')}
      </Button>
    </li>
  )
}

/** Overview's Who gets it: the projects, then each agent with what it pays per turn. */
export function McpWhoGets({
  server,
  insight,
}: {
  server: MarketServer
  insight: McpServerInsight | null
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const agentName = useAgentName()
  const agents = insight?.agents ?? []
  const toggle = (agentId: AgentId, on: boolean) => {
    const ids = agents.map((agent) => agent.agentId)
    const now = server.agents === 'all' ? ids : server.agents
    const next = on ? [...new Set([...now, agentId])] : now.filter((id) => id !== agentId)
    const all = ids.every((id) => next.includes(id))
    void setServerAgents(scope, server.id, all ? 'all' : next)
  }
  return (
    <section className="k-mcp-server-card">
      <h2>{t('mcp.page.whoGets')}</h2>
      <McpProjectsChoice server={server} />
      <ul className="k-mcp-rows">
        {agents.map((agent) => {
          const note =
            agent.carry === 'names'
              ? t('mcp.page.namesOnly')
              : agent.carry === 'gateway'
                ? t('mcp.page.gateway')
                : harnessOf(agent.agentId) === 'antigravity'
                  ? t('mcp.page.gatewayLarge')
                  : null
          return (
            <li key={agent.agentId} className="k-mcp-row">
              <AgentMark agent={agent.agentId} size={18} hostId={scope.hostId} dot={null} />
              <span className="k-mcp-row__main">
                <span className="k-mcp-row__title">{agentName(agent.agentId)}</span>
                {note && <span className="k-mcp-row__facts">{note}</span>}
              </span>
              {insight?.tools && (
                <span className="k-mcp-row__end">
                  {t('mcp.page.perTurn', { tokens: tokens(agent.tokens) })}
                </span>
              )}
              <SettingSwitch
                label={t('mcp.page.agentSwitch', { name: agentName(agent.agentId) })}
                checked={goesTo(server.agents, agent.agentId)}
                onChange={(on) => toggle(agent.agentId, on)}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

type ProjectsMode = 'all' | McpProjects['mode']

function McpProjectsChoice({ server }: { server: MarketServer }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const all = useProjectsStore((s) => s.projects)
  const projects = useMemo(
    () => all.filter((project) => hostOfPath(project.path) === scope.hostId),
    [all, scope.hostId],
  )
  const mode: ProjectsMode = server.projects?.mode ?? 'all'
  const paths = server.projects?.paths ?? []
  const save = (next: McpProjects | null) =>
    void changeServer(scope, server.id, (current) => {
      const rest = { ...current }
      delete rest.projects
      return next ? { ...rest, projects: next } : rest
    })
  return (
    <div className="k-mcp-projects">
      <SegmentedControl<ProjectsMode>
        size="sm"
        variant="tray"
        aria-label={t('mcp.page.projects')}
        value={mode}
        onChange={(next) => save(next === 'all' ? null : { mode: next, paths })}
        options={[
          { value: 'all', label: t('mcp.page.projectsAll') },
          { value: 'only', label: t('mcp.page.projectsOnly') },
          { value: 'except', label: t('mcp.page.projectsExcept') },
        ]}
      />
      {mode !== 'all' && (
        <ul className="k-mcp-project-list">
          {projects.length === 0 && <li className="k-mcp-muted">{t('mcp.page.noProjects')}</li>}
          {projects.map((project) => {
            const path = hostPath(project.path)
            return (
              <li key={project.path}>
                <label>
                  <Checkbox
                    checked={paths.includes(path)}
                    onCheckedChange={(checked) =>
                      save({
                        mode,
                        paths:
                          checked === true
                            ? [...paths, path]
                            : paths.filter((item) => item !== path),
                      })
                    }
                  />
                  <span>{project.name}</span>
                  <code className="k-mkt-mono">{homeShort(path)}</code>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

type ToolFilter = 'all' | 'on' | 'off' | 'held'

/** The tools a server listed last, each with its switch for every agent. */
export function McpToolsTab({
  server,
  insight,
}: {
  server: MarketServer
  insight: McpServerInsight | null
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ToolFilter>('all')
  const [reviewing, setReviewing] = useState(false)
  const changes = useMcpToolChanges(server.id)
  const tools = insight?.tools
  if (!tools) {
    return <p className="k-mcp-muted k-mcp-empty">{t('mcp.page.toolsUnknown')}</p>
  }
  const needle = query.trim().toLowerCase()
  const heldCount = tools.filter((tool) => tool.held).length
  const picked = (tool: McpToolInfo): boolean =>
    filter === 'all' ||
    (filter === 'held' ? tool.held === true : (filter === 'off') === tool.off && !tool.held)
  const shown = tools.filter(
    (tool) =>
      picked(tool) &&
      (needle === '' ||
        tool.name.toLowerCase().includes(needle) ||
        tool.summary.toLowerCase().includes(needle)),
  )
  const offCount = tools.filter((tool) => tool.off && !tool.held).length
  const set = (tool: McpToolInfo, on: boolean) =>
    void changeServer(scope, server.id, (current) => {
      const off = new Set(current.toolsOff ?? [])
      if (on) off.delete(tool.name)
      else off.add(tool.name)
      const rest = { ...current }
      delete rest.toolsOff
      return off.size > 0 ? { ...rest, toolsOff: [...off] } : rest
    })
  return (
    <section className="k-mcp-server-card">
      {changes && <McpToolChangesBanner changes={changes} review={() => setReviewing(true)} />}
      <div className="k-mcp-toolbar">
        <SearchField value={query} onChange={setQuery} label={t('mcp.page.searchTools')} />
        <SegmentedControl<ToolFilter>
          size="sm"
          variant="tray"
          aria-label={t('mcp.page.toolFilter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('mcp.page.all'), count: tools.length },
            { value: 'on', label: t('mcp.page.on'), count: tools.length - offCount - heldCount },
            { value: 'off', label: t('mcp.page.off'), count: offCount },
            ...(heldCount > 0
              ? [{ value: 'held' as const, label: t('mcp.page.held'), count: heldCount }]
              : []),
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <p className="k-mcp-muted">{t('mcp.page.noTools')}</p>
      ) : (
        <ul className="k-mcp-rows">
          {shown.map((tool) => (
            <li
              key={tool.name}
              className="k-mcp-row k-mcp-tool"
              data-off={tool.off ? '' : undefined}
              data-held={tool.held ? '' : undefined}
            >
              {tool.held ? (
                <span
                  className="k-mcp-tool-lock"
                  role="img"
                  aria-label={t('mcp.page.heldLock')}
                  title={t('mcp.page.heldLock')}
                >
                  <Icon icon={SquareLock02Icon} size={16} />
                </span>
              ) : (
                <SettingSwitch
                  label={t('mcp.page.toolSwitch', { name: tool.name })}
                  checked={!tool.off}
                  onChange={(on) => set(tool, on)}
                />
              )}
              <span className="k-mcp-row__main">
                <code className="k-mkt-mono k-mcp-row__title">{tool.name}</code>
                {tool.summary && <span className="k-mcp-row__facts">{tool.summary}</span>}
              </span>
              {tool.change && (
                <span className="k-mcp-tag" data-tag={tool.change}>
                  {t(`mcp.page.change.${tool.change}`)}
                </span>
              )}
              {tool.tags.map((tag) => (
                <span key={tag} className="k-mcp-tag" data-tag={tag}>
                  {t(`mcp.page.tag.${tag}`)}
                </span>
              ))}
              <span className="k-mcp-row__end">{bytes(tool.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      <McpToolChangesDialog
        server={server}
        changes={changes}
        open={reviewing}
        onOpenChange={setReviewing}
      />
    </section>
  )
}

function SearchField({
  value,
  onChange,
  label,
}: {
  value: string
  onChange(value: string): void
  label: string
}) {
  return (
    <label className="k-mcp-search">
      <Icon icon={Search01Icon} size={14} />
      <input
        type="search"
        value={value}
        placeholder={label}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

const RANGES = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 }
type Range = keyof typeof RANGES

/** A server's recent calls: metadata only, what was sent and returned staying in the session. */
export function McpCallsTab({ server }: { server: MarketServer }) {
  const { t } = useTranslation('marketplace')
  const { request } = useHostScope()
  const [failed, setFailed] = useState(false)
  const [range, setRange] = useState<Range>('day')
  const [query, setQuery] = useState('')
  const [calls, setCalls] = useState<McpCallRecord[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    const read = () =>
      request('market.mcpCalls', {
        serverId: server.id,
        failed,
        since: Date.now() - RANGES[range],
        ...(query.trim() ? { query: query.trim() } : {}),
      })
        .then((result) => live && setCalls(result.calls))
        .catch(() => live && setCalls([]))
    void read()
    const timer = setInterval(() => void read(), REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [request, server.id, failed, range, query])
  return (
    <section className="k-mcp-server-card">
      <div className="k-mcp-toolbar">
        <SegmentedControl<'all' | 'failed'>
          size="sm"
          variant="tray"
          aria-label={t('mcp.page.callFilter')}
          value={failed ? 'failed' : 'all'}
          onChange={(next) => setFailed(next === 'failed')}
          options={[
            { value: 'all', label: t('mcp.page.all') },
            { value: 'failed', label: t('mcp.page.failed') },
          ]}
        />
        <Select
          value={range}
          items={(Object.keys(RANGES) as Range[]).map((value) => ({
            value,
            label: t(`mcp.page.range.${value}`),
          }))}
          onValueChange={(next) => next && setRange(next as Range)}
        >
          <SelectTrigger aria-label={t('mcp.page.rangeLabel')} className="ui-ss-select k-select">
            <SelectValue>
              {(value: string | null) => t(`mcp.page.range.${(value ?? range) as Range}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              {(Object.keys(RANGES) as Range[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`mcp.page.range.${value}`)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <SearchField value={query} onChange={setQuery} label={t('mcp.page.searchCalls')} />
      </div>
      {calls === null ? null : calls.length === 0 ? (
        <p className="k-mcp-muted">{t(failed ? 'mcp.page.noFailed' : 'mcp.page.noCalls')}</p>
      ) : (
        <table className="k-mcp-calls">
          <thead>
            <tr>
              <th>{t('mcp.page.col.time')}</th>
              <th>{t('mcp.page.col.tool')}</th>
              <th>{t('mcp.page.col.session')}</th>
              <th className="k-mcp-num">{t('mcp.page.col.duration')}</th>
              <th className="k-mcp-num">{t('mcp.page.col.size')}</th>
              <th>{t('mcp.page.col.result')}</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call, i) => (
              <CallRow
                key={`${call.at}-${i}`}
                server={server}
                call={call}
                open={open === i}
                toggle={() => setOpen(open === i ? null : i)}
              />
            ))}
          </tbody>
        </table>
      )}
      <p className="k-mcp-muted k-mcp-foot">{t('mcp.page.callsKept')}</p>
    </section>
  )
}

function CallRow({
  server,
  call,
  open,
  toggle,
}: {
  server: MarketServer
  call: McpCallRecord
  open: boolean
  toggle(): void
}) {
  const { t } = useTranslation('marketplace')
  const { hostId } = useHostScope()
  const agentName = useAgentName()
  const session = useSessionsStore((s) => (call.sessionId ? s.byId[call.sessionId] : undefined))
  const failed = call.result !== 'ok'
  const signIn = /needs sign-in/.test(call.error ?? '')
  const goTo = session ? () => openSession(session.id, session.projectPath) : undefined
  return (
    <Fragment>
      <tr data-failed={failed ? '' : undefined}>
        <td title={monthDayTime(call.at)}>{clockTime(call.at)}</td>
        <td>
          <code className="k-mkt-mono">{call.tool}</code>
        </td>
        <td>
          {call.sessionId ? (
            <button
              type="button"
              className="k-mcp-session"
              disabled={!goTo}
              onClick={goTo}
              title={session?.title ?? undefined}
            >
              {call.agentId && (
                <AgentMark agent={call.agentId} size={14} hostId={hostId} dot={null} />
              )}
              <span>{session?.title ?? t('mcp.page.aSession')}</span>
            </button>
          ) : call.agentId ? (
            <span
              className="k-mcp-session k-mcp-muted"
              title={call.folder ? homeShort(call.folder) : undefined}
            >
              <AgentMark agent={call.agentId} size={14} hostId={hostId} dot={null} />
              <span>
                {call.folder
                  ? t('mcp.page.inTerminalAt', {
                      agent: agentName(call.agentId),
                      folder: homeShort(call.folder),
                    })
                  : t('mcp.page.inTerminal', { agent: agentName(call.agentId) })}
              </span>
            </span>
          ) : call.app ? (
            <span className="k-mcp-session k-mcp-muted">
              <span>{t('mcp.page.inApp', { app: MCP_TERMINAL_APPS[call.app] })}</span>
            </span>
          ) : (
            <span className="k-mcp-muted">{t('mcp.page.terminal')}</span>
          )}
        </td>
        <td className="k-mcp-num">{t('mcp.elapsed', { ms: call.ms })}</td>
        <td className="k-mcp-num">{bytes(call.bytes)}</td>
        <td>
          {failed ? (
            <button
              type="button"
              className="k-mcp-result"
              data-result={call.result}
              aria-expanded={open}
              onClick={toggle}
            >
              {t(`mcp.page.result.${call.result}`)}
              <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
            </button>
          ) : (
            <span className="k-mcp-result" data-result="ok">
              {t('mcp.page.result.ok')}
            </span>
          )}
        </td>
      </tr>
      {failed && open && (
        <tr className="k-mcp-call-detail">
          <td colSpan={6}>
            <p>{call.error ?? t(`mcp.page.why.${call.result as Exclude<McpCallResult, 'ok'>}`)}</p>
            {(call.result === 'error' || call.result === 'refused') && (
              <p className="k-mcp-call-next">{t(`mcp.page.next.${call.result}`)}</p>
            )}
            <div className="k-mcp-call-actions">
              {signIn && <McpSignIn server={server} />}
              {goTo && (
                <Button size="sm" variant="secondary" onClick={goTo}>
                  {t('mcp.page.openInSession')}
                </Button>
              )}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  )
}

const WARN = /\bwarn(ing)?\b/i
const ERROR = /\b(error|fatal|exception|panic|traceback)\b/i

/** A command server's stderr, per instance, the last 1 MB each, its keys masked. */
export function McpLogsTab({ server }: { server: MarketServer }) {
  const { t } = useTranslation('marketplace')
  const { request } = useHostScope()
  const [logs, setLogs] = useState<McpServerLog[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const read = () =>
      request('market.mcpLogs', { serverId: server.id })
        .then((found) => live && setLogs(found))
        .catch(() => live && setLogs([]))
    void read()
    const timer = setInterval(() => void read(), REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [request, server.id])
  const sessions = useSessionsStore((s) => s.byId)
  if (logs === null) return null
  if (logs.length === 0) return <p className="k-mcp-muted k-mcp-empty">{t('mcp.page.noLogs')}</p>
  const log = logs.find((item) => item.instance === chosen) ?? logs.at(-1)!
  const label = (item: McpServerLog) =>
    [
      (item.sessionId && sessions[item.sessionId]?.title) || homeShort(item.folder),
      item.running ? t('mcp.page.live') : t('mcp.page.ended'),
    ].join(' · ')
  const copy = () => {
    navigator.clipboard
      .writeText(log.text)
      .then(() => toast(t('mcp.page.copied'), undefined, { tone: 'success' }))
      .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
  }
  return (
    <section className="k-mcp-server-card">
      <div className="k-mcp-toolbar">
        <Select
          value={log.instance}
          items={logs.map((item) => ({ value: item.instance, label: label(item) }))}
          onValueChange={(next) => next && setChosen(next)}
        >
          <SelectTrigger aria-label={t('mcp.page.instance')} className="ui-ss-select k-select">
            <SelectValue>
              {(value: string | null) => label(logs.find((item) => item.instance === value) ?? log)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              {logs.map((item) => (
                <SelectItem key={item.instance} value={item.instance}>
                  {label(item)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button size="sm" variant="secondary" onClick={copy} disabled={log.text === ''}>
          {t('mcp.page.copy')}
        </Button>
      </div>
      {log.text === '' ? (
        <p className="k-mcp-muted">{t('mcp.page.emptyLog')}</p>
      ) : (
        <pre className="k-mcp-log k-mkt-mono">
          {log.text.split('\n').map((line, i) => (
            <span
              key={i}
              data-level={ERROR.test(line) ? 'error' : WARN.test(line) ? 'warn' : undefined}
            >
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      <p className="k-mcp-muted k-mcp-foot">{t('mcp.page.logsMasked')}</p>
    </section>
  )
}
