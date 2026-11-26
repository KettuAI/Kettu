import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert02Icon,
  Cancel01Icon,
  ComputerTerminal01Icon,
  Folder01Icon,
  Search01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ImportableSession, Project } from '@shared/agent-host'
import type { AgentId, PromptCache } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@renderer/components/ui/input-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { readiness } from '@renderer/features/agents/readiness'
import { useCacheLeft } from '@renderer/features/prompt-cache/cache-phase'
import { projectNameHints } from '@renderer/features/session/project-names'
import { basename } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession, useViewStore } from '@renderer/stores/view'
import {
  allSelected,
  appendSessions,
  emptyScopedLists,
  filterImportSessions,
  formatImportCwd,
  importableKeys,
  importInOrder,
  importKey,
  listed,
  markImported,
  sameFolder,
  selectedCountForAgent,
  selectedSessions,
  sessionAgo,
  shownAgent,
  sourceCount,
  withKeys,
  type AgentList,
  type ImportScope,
  type ScopedAgentLists,
  type SourceCount,
} from './import-sessions-model'

/**
 * Sessions the agents already have for this folder or other paths (moved repos, worktrees), with
 * the agents in a rail and the shown agent's sessions beside it. Nothing is copied until the
 * chosen ones are imported into the target project.
 */
export function ImportSessionsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const agents = useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId).filter(
        (a) => !a.disabled && a.capabilities.listSessions && readiness(a).kind !== 'missing',
      ),
    ),
  )
  const storedProjects = useProjectsStore(
    useShallow((s) => s.projects.filter((p) => hostOfPath(p.path) === null && !p.missing)),
  )
  const localProjects = useMemo(
    () =>
      storedProjects.some((p) => p.path === project.path)
        ? storedProjects
        : [project, ...storedProjects],
    [storedProjects, project],
  )
  const projectHints = useMemo(
    () => projectNameHints(localProjects.map((p) => p.path)),
    [localProjects],
  )
  const projectNames = useMemo(
    () => new Map(localProjects.map((p) => [p.path, p.name])),
    [localProjects],
  )

  const agentIds = agents.map((a) => a.id)
  const [targetPath, setTargetPath] = useState(project.path)
  const [scopedLists, setScopedLists] = useState<ScopedAgentLists>(emptyScopedLists)
  const [scopes, setScopes] = useState<Partial<Record<AgentId, ImportScope>>>({})
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<AgentId | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  // The session being imported, and why the ones that failed did.
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  // Each opening and closing starts a new run, so an import still going stops at its next session.
  const run = useRef(0)
  // Each target project switch bumps projectRun so stale project-scoped pages are dropped.
  const projectRun = useRef(0)
  // Agents already requested for the current opening and target project, so agents that finish
  // initializing while the dialog is open load right away instead of staying on skeletons.
  const requestedProject = useRef<Set<AgentId>>(new Set())

  const targetProject = localProjects.find((p) => p.path === targetPath) ?? project

  // Requests only: the loading marker is set by whoever starts a load, never inside an effect.
  const request = (
    agentId: AgentId,
    scope: ImportScope,
    forProjectPath: string,
    cursor?: string,
  ) => {
    const at = run.current
    const atProject = projectRun.current
    host('agents.listSessions', {
      agentId,
      projectPath: forProjectPath,
      ...(cursor ? { cursor } : {}),
      ...(scope === 'all' ? { allFolders: true } : {}),
    })
      .then((page) => {
        if (run.current !== at) return
        if (scope === 'project' && projectRun.current !== atProject) return
        setScopedLists((s) => {
          const prev = s[scope][agentId]
          return {
            ...s,
            [scope]: {
              ...s[scope],
              [agentId]: {
                sessions: cursor
                  ? appendSessions(prev?.sessions ?? [], page.sessions)
                  : page.sessions,
                nextCursor: page.nextCursor,
                loading: false,
                error: null,
              },
            },
          }
        })
      })
      .catch((error: unknown) => {
        if (run.current !== at) return
        if (scope === 'project' && projectRun.current !== atProject) return
        setScopedLists((s) => ({
          ...s,
          [scope]: {
            ...s[scope],
            [agentId]: {
              sessions: s[scope][agentId]?.sessions ?? [],
              nextCursor: null,
              loading: false,
              error: errorMessage(error),
            },
          },
        }))
      })
  }

  const reload = (agentId: AgentId, scope: ImportScope) => {
    setScopedLists((s) => ({
      ...s,
      [scope]: {
        ...s[scope],
        [agentId]: { sessions: [], nextCursor: null, loading: true, error: null },
      },
    }))
    request(agentId, scope, targetProject.path)
  }

  const loadMore = (agentId: AgentId, scope: ImportScope, cursor: string) => {
    setScopedLists((s) => ({
      ...s,
      [scope]: {
        ...s[scope],
        [agentId]: {
          sessions: s[scope][agentId]?.sessions ?? [],
          nextCursor: null,
          loading: true,
          error: null,
        },
      },
    }))
    request(agentId, scope, targetProject.path, cursor)
  }

  // Each opening starts over, with the agents that can list sessions at that moment.
  const [shownOpen, setShownOpen] = useState(false)
  if (open !== shownOpen) {
    setShownOpen(open)
    if (open) {
      setTargetPath(project.path)
      setScopedLists(emptyScopedLists())
      setScopes({})
      setQuery('')
      setChosen(null)
      setSelected(new Set())
      setBusy(null)
      setFailed({})
      setRunning(false)
    }
  }

  const agentIdsKey = agentIds.join('\n')

  useEffect(() => {
    run.current += 1
    projectRun.current += 1
    requestedProject.current = new Set()
    if (!open) return
    for (const agent of agents) {
      requestedProject.current.add(agent.id)
      request(agent.id, 'project', project.path)
    }
    // Reset only when the dialog opens or closes; late-ready agents are picked up below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    for (const agent of agents) {
      if (requestedProject.current.has(agent.id)) continue
      requestedProject.current.add(agent.id)
      request(agent.id, 'project', targetProject.path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentIdsKey, targetProject.path])

  const changeTarget = (nextPath: string | null) => {
    if (!nextPath || nextPath === targetProject.path || running) return
    projectRun.current += 1
    requestedProject.current = new Set()
    setTargetPath(nextPath)
    // Keep all-folders lists and any selections from them; refresh project-scoped lists for the new target.
    setScopedLists((s) => ({ ...s, project: {} }))
    setSelected((prev) => {
      const keep = new Set<string>()
      for (const agent of agents) {
        for (const item of scopedLists.all[agent.id]?.sessions ?? []) {
          const key = importKey(agent.id, item.acpSessionId)
          if (prev.has(key)) keep.add(key)
        }
      }
      return keep
    })
    for (const agent of agents) {
      requestedProject.current.add(agent.id)
      request(agent.id, 'project', nextPath)
    }
  }

  const changeScope = (agentId: AgentId, next: ImportScope) => {
    setChosen(agentId)
    setScopes((s) => ({ ...s, [agentId]: next }))
    if (next === 'all' && !scopedLists.all[agentId]) {
      reload(agentId, 'all')
    }
  }

  const shown = shownAgent(agentIds, scopedLists.project, chosen)
  const shownStatus = shown ? agents.find((a) => a.id === shown) : undefined
  const canListAll = shownStatus?.capabilities.listAllSessions === true
  const shownScope: ImportScope = shown && canListAll ? (scopes[shown] ?? 'project') : 'project'
  const shownList = shown ? scopedLists[shownScope][shown] : undefined
  const visibleSessions = useMemo(
    () => (shownList ? filterImportSessions(shownList.sessions, canListAll ? query : '') : []),
    [shownList, query, canListAll],
  )
  const keys = shown ? importableKeys(shown, visibleSessions) : []
  const toImport = selectedSessions(agentIds, scopedLists, selected)
  const sources = new Set(toImport.map((s) => s.agentId)).size

  const importSelected = async () => {
    const token = run.current
    const destination = targetProject.path
    setRunning(true)
    setFailed({})
    const failures = await importInOrder(
      toImport,
      async ({ agentId, acpSessionId }) => {
        const key = importKey(agentId, acpSessionId)
        setBusy(key)
        try {
          const summary = await host('sessions.import', {
            agentId,
            projectPath: destination,
            acpSessionId,
          })
          useSessionsStore.getState().upsert(summary)
          setScopedLists((s) => markImported(s, agentId, acpSessionId, destination))
          setSelected((s) => withKeys(s, [key], false))
          return true
        } catch (error) {
          setFailed((f) => ({ ...f, [key]: errorMessage(error) }))
          return false
        }
      },
      () => run.current === token,
    )
    if (run.current !== token) return
    // Expand the target project in the sidebar so newly imported sessions are immediately visible.
    if (failures.length < toImport.length) {
      useViewStore.setState((s) => {
        if (!s.collapsedProjects[destination]) return s
        const collapsedProjects = { ...s.collapsedProjects }
        delete collapsedProjects[destination]
        return { collapsedProjects }
      })
    }
    setBusy(null)
    setRunning(false)
    // The failed ones stay selected beside their reasons, to try again.
    if (failures.length === 0) onOpenChange(false)
  }

  // A session a terminal still has open is not attached; a copy of it is imported and opened.
  const forkSession = async (agentId: AgentId, acpSessionId: string) => {
    const key = importKey(agentId, acpSessionId)
    setBusy(key)
    setRunning(true)
    try {
      const summary = await host('sessions.import', {
        agentId,
        projectPath: targetProject.path,
        acpSessionId,
        fork: true,
      })
      useSessionsStore.getState().upsert(summary)
      onOpenChange(false)
      openSession(summary.id, summary.projectPath)
    } catch (error) {
      setFailed((f) => ({ ...f, [key]: errorMessage(error) }))
    } finally {
      setBusy(null)
      setRunning(false)
    }
  }

  const projectLabel = (folderPath: string): string =>
    projectNames.get(folderPath) ?? basename(folderPath)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(600px,85svh)] flex-col gap-0 p-0 sm:max-w-[740px]"
      >
        <DialogHeader className="flex-row items-start justify-between gap-4 px-5.5 pt-5 pb-4 phone:flex-col phone:gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <DialogTitle>{t('import.title', { project: targetProject.name })}</DialogTitle>
            <DialogDescription>{t('import.description')}</DialogDescription>
          </div>
          {localProjects.length > 1 && (
            <div className="flex shrink-0 items-center gap-2 phone:w-full">
              <span className="text-meta text-tertiary">{t('import.targetLabel')}</span>
              <Select value={targetProject.path} onValueChange={changeTarget} disabled={running}>
                <SelectTrigger
                  size="sm"
                  aria-label={t('import.targetProject')}
                  className="max-w-[200px] phone:flex-1 phone:max-w-none"
                >
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    strokeWidth={1.9}
                    aria-hidden
                    className="size-3.5 text-icon"
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{targetProject.name}</span>
                </SelectTrigger>
                <SelectContent align="end" className="max-w-[280px]">
                  <SelectGroup>
                    {localProjects.map((p) => {
                      const hint = projectHints.get(p.path)
                      return (
                        <SelectItem key={p.path} value={p.path} title={p.path}>
                          <HugeiconsIcon
                            icon={Folder01Icon}
                            strokeWidth={1.9}
                            aria-hidden
                            className="size-3.5 text-icon"
                          />
                          <span className="truncate">{p.name}</span>
                          {hint && <span className="truncate text-meta text-tertiary">{hint}</span>}
                        </SelectItem>
                      )
                    })}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          )}
        </DialogHeader>
        {agents.length === 0 || !shown ? (
          <div className="flex min-h-0 flex-1 items-center justify-center border-y border-subtle px-5.5">
            <p className="text-ui text-secondary">{t('import.noAgents')}</p>
          </div>
        ) : (
          <Tabs
            orientation="vertical"
            value={shown}
            onValueChange={(value: AgentId) => setChosen(value)}
            className="min-h-0 flex-1 flex-row gap-0 border-y border-subtle phone:flex-col"
          >
            <TabsList
              variant="rail"
              aria-label={t('import.agents')}
              className="w-52 shrink-0 scroll-fade-y justify-start overflow-y-auto overscroll-contain p-2 group-data-vertical/tabs:h-auto phone:max-h-30 phone:w-full"
            >
              {agents.map((agent) => {
                const agentScope: ImportScope =
                  agent.capabilities.listAllSessions === true
                    ? (scopes[agent.id] ?? 'project')
                    : 'project'
                const activeList = scopedLists[agentScope][agent.id]
                const picked = selectedCountForAgent(agent.id, scopedLists, selected)
                return (
                  <SourceRow
                    key={agent.id}
                    agentId={agent.id}
                    name={agent.name}
                    count={sourceCount(agent.id, activeList, selected, picked)}
                    failed={!!activeList?.error}
                  />
                )
              })}
            </TabsList>
            <TabsContent
              value={shown}
              tabIndex={-1}
              className="flex min-h-0 min-w-0 flex-col border-l border-subtle phone:border-t phone:border-l-0"
            >
              <SessionList
                agentId={shown}
                agentName={shownStatus?.name ?? ''}
                list={shownList}
                sessions={visibleSessions}
                keys={keys}
                selected={selected}
                busy={busy}
                failed={failed}
                locked={running}
                canListAll={canListAll}
                scope={shownScope}
                query={query}
                targetProjectPath={targetProject.path}
                projectLabel={projectLabel}
                onScopeChange={(next) => changeScope(shown, next)}
                onQueryChange={setQuery}
                onSelect={(picked, on) => setSelected((s) => withKeys(s, picked, on))}
                onMore={(cursor) => loadMore(shown, shownScope, cursor)}
                onFork={(acpSessionId) => void forkSession(shown, acpSessionId)}
                onRetry={() => reload(shown, shownScope)}
              />
            </TabsContent>
          </Tabs>
        )}
        <div className="flex items-center gap-2 px-5.5 py-3.5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-control',
              toImport.length > 0 ? 'text-foreground' : 'text-tertiary',
            )}
          >
            {toImport.length === 0
              ? t('import.selectedNone')
              : sources > 1
                ? t('import.selectedAcross', { count: toImport.length, sources })
                : t('import.selected', { count: toImport.length })}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button disabled={running || toImport.length === 0} onClick={() => void importSelected()}>
            {running ? (
              <>
                <Spinner className="size-3.5" />
                {t('import.importing')}
              </>
            ) : toImport.length > 0 ? (
              t('import.importCount', { count: toImport.length })
            ) : (
              t('import.import')
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** An agent in the rail, with how many of its sessions can be imported, or are picked of those. */
function SourceRow({
  agentId,
  name,
  count,
  failed,
}: {
  agentId: AgentId
  name: string
  count: SourceCount | null
  failed: boolean
}) {
  const { t } = useTranslation('sidebar')
  const says = !count
    ? null
    : count.selected > 0
      ? t('import.sourcePicked', { selected: count.selected, count: count.importable })
      : count.importable > 0
        ? t(count.more ? 'import.sourceCanMore' : 'import.sourceCan', { count: count.importable })
        : t(count.empty ? 'import.sourceEmpty' : 'import.sourceNone')
  return (
    <TabsTrigger
      value={agentId}
      title={says ? `${name} · ${says}` : name}
      className="justify-start gap-2 rounded-md group-data-[variant=rail]/tabs-list:data-active:bg-selected dark:group-data-[variant=rail]/tabs-list:data-active:bg-selected"
    >
      <AgentMark agent={agentId} size={14} />
      <span className={cn('min-w-0 flex-1 truncate text-left', count?.empty && 'text-tertiary')}>
        {name}
      </span>
      {says && <span className="sr-only">{says}</span>}
      {failed ? (
        <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.9} className="size-3.5 text-danger" />
      ) : !count ? (
        <Spinner className="size-3 text-tertiary" />
      ) : count.selected > 0 ? (
        <span aria-hidden className="shrink-0 text-xs font-medium text-control-on tabular">
          {count.selected}/{count.importable}
          {count.more && '+'}
        </span>
      ) : count.importable > 0 ? (
        <span aria-hidden className="shrink-0 text-xs text-tertiary tabular">
          {count.importable}
          {count.more && '+'}
        </span>
      ) : count.empty ? null : (
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={1.9} className="size-3.5 text-tertiary" />
      )}
    </TabsTrigger>
  )
}

/** One agent's sessions: optional scope/filter bar, bulk select bar, and session rows. */
function SessionList({
  agentId,
  agentName,
  list,
  sessions,
  keys,
  selected,
  busy,
  failed,
  locked,
  canListAll,
  scope,
  query,
  targetProjectPath,
  projectLabel,
  onScopeChange,
  onQueryChange,
  onSelect,
  onMore,
  onFork,
  onRetry,
}: {
  agentId: AgentId
  agentName: string
  list: AgentList | undefined
  /** Visible sessions after any search filter. */
  sessions: readonly ImportableSession[]
  /** The visible sessions that can be picked. */
  keys: readonly string[]
  selected: ReadonlySet<string>
  busy: string | null
  failed: Record<string, string>
  locked: boolean
  canListAll: boolean
  scope: ImportScope
  query: string
  targetProjectPath: string
  projectLabel: (folderPath: string) => string
  onScopeChange: (scope: ImportScope) => void
  onQueryChange: (query: string) => void
  onSelect: (keys: readonly string[], on: boolean) => void
  onMore: (cursor: string) => void
  onFork: (acpSessionId: string) => void
  onRetry: () => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const trimmedQuery = query.trim()
  const filterBar = canListAll ? (
    <div className="flex flex-wrap items-center gap-2 border-b border-subtle px-4 py-2">
      <SegmentedControl
        size="small"
        value={scope}
        onChange={onScopeChange}
        aria-label={t('import.scopeLabel')}
        segments={[
          { value: 'project', label: t('import.scopeProject') },
          { value: 'all', label: t('import.scopeAll') },
        ]}
      />
      <InputGroup className="h-7 min-w-[150px] flex-1">
        <InputGroupAddon align="inline-start" className="pr-0">
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3.5 text-tertiary"
          />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          disabled={locked}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('import.searchPlaceholder')}
          aria-label={t('import.searchPlaceholder')}
          className="h-7 text-hint"
        />
        {query !== '' && (
          <InputGroupAddon align="inline-end" className="pl-0">
            <InputGroupButton
              size="icon-xs"
              disabled={locked}
              aria-label={t('import.clearSearch')}
              onClick={() => onQueryChange('')}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.9} className="size-3" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </div>
  ) : null

  if (list?.error) {
    return (
      <>
        {filterBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-ui text-balance text-danger">{list.error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common:actions.retry')}
          </Button>
        </div>
      </>
    )
  }
  if (!listed(list)) {
    return (
      <>
        {filterBar}
        <div className="flex flex-col px-2 pt-2">
          {[0.62, 0.48, 0.55, 0.4].map((width) => (
            <div key={width} className="flex h-9 items-center gap-2.5 px-2">
              <Skeleton className="size-4 rounded-sm" />
              <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
            </div>
          ))}
        </div>
      </>
    )
  }
  if (list.sessions.length === 0) {
    return (
      <>
        {filterBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-ui text-secondary">
            {t(scope === 'all' ? 'import.noSessionsAll' : 'import.noSessions', {
              agent: agentName,
            })}
          </p>
          {canListAll && scope === 'project' && (
            <Button variant="outline" size="sm" onClick={() => onScopeChange('all')}>
              {t('import.browseAllFolders')}
            </Button>
          )}
        </div>
      </>
    )
  }

  const picked = keys.filter((key) => selected.has(key)).length
  const inKettu = sessions.filter((s) => s.imported).length
  const more = list.nextCursor !== null || list.loading
  const selectLabel = trimmedQuery
    ? t('import.selectMatching', { count: keys.length })
    : t(more ? 'import.selectShown' : 'import.selectAll', { count: keys.length })

  return (
    <>
      {filterBar}
      {sessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-ui text-secondary">{t('import.noMatch', { query: trimmedQuery })}</p>
          <div className="flex items-center gap-2">
            {more && list.nextCursor && (
              <Button
                variant="outline"
                size="sm"
                disabled={list.loading}
                onClick={() => list.nextCursor && onMore(list.nextCursor)}
              >
                {list.loading && <Spinner className="size-3" />}
                {t('import.showMore')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onQueryChange('')}>
              {t('import.clearSearch')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex h-9.5 shrink-0 items-center gap-2.5 border-b border-subtle px-4 text-control">
            {keys.length > 0 ? (
              <label className="flex min-w-0 items-center gap-2.5 text-secondary">
                <Checkbox
                  checked={allSelected(keys, selected)}
                  indeterminate={picked > 0 && picked < keys.length}
                  disabled={locked}
                  onCheckedChange={(on) => onSelect(keys, on)}
                />
                <span className="truncate">{selectLabel}</span>
              </label>
            ) : (
              <span className="truncate text-tertiary">{t('import.nothingLeft')}</span>
            )}
            <span className="flex-1" />
            {inKettu > 0 && keys.length > 0 && (
              <span className="shrink-0 text-meta text-tertiary tabular">
                {t('import.inKettu', { count: inKettu })}
              </span>
            )}
          </div>
          <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-2">
            {sessions.map((s) => {
              const key = importKey(agentId, s.acpSessionId)
              const showCwd =
                Boolean(s.cwd) && (scope === 'all' || !sameFolder(s.cwd, targetProjectPath))
              return (
                <li key={s.acpSessionId}>
                  <SessionRow
                    session={s}
                    showCwd={showCwd}
                    targetProjectPath={targetProjectPath}
                    projectLabel={projectLabel}
                    checked={selected.has(key)}
                    busy={busy === key}
                    failure={failed[key]}
                    locked={locked}
                    onSelect={(on) => onSelect([key], on)}
                    onFork={() => onFork(s.acpSessionId)}
                  />
                </li>
              )
            })}
            {more ? (
              <li className="px-0.5 pt-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-secondary"
                  disabled={list.loading}
                  onClick={() => list.nextCursor && onMore(list.nextCursor)}
                >
                  {list.loading && <Spinner className="size-3" />}
                  {t('import.showMore')}
                </Button>
              </li>
            ) : null}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * A listed session. Only one that can be imported has a checkbox; one already in Kettu and one a
 * terminal still has open show a quiet mark in its place.
 */
function SessionRow({
  session,
  showCwd,
  targetProjectPath,
  projectLabel,
  checked,
  busy,
  failure,
  locked,
  onSelect,
  onFork,
}: {
  session: ImportableSession
  showCwd: boolean
  targetProjectPath: string
  projectLabel: (folderPath: string) => string
  checked: boolean
  busy: boolean
  failure: string | undefined
  locked: boolean
  onSelect: (on: boolean) => void
  onFork: () => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const held = !session.imported && (session.held ?? false)
  const pickable = !session.imported && !held
  const ago = session.updatedAt ? sessionAgo(Date.parse(session.updatedAt)) : null
  const state = session.imported
    ? session.importedProjectPath && !sameFolder(session.importedProjectPath, targetProjectPath)
      ? t('import.importedIn', { project: projectLabel(session.importedProjectPath) })
      : t('import.imported')
    : held
      ? t('import.held')
      : null
  const Row = pickable ? 'label' : 'div'
  return (
    <Row
      className={cn(
        'flex min-h-9 gap-2.5 rounded-md px-2',
        showCwd ? 'items-start py-1.5' : 'items-center',
        pickable && 'hover:bg-hover',
      )}
      title={held ? t('import.heldTip') : undefined}
    >
      {pickable ? (
        <Checkbox
          checked={checked}
          disabled={locked}
          onCheckedChange={onSelect}
          className={showCwd ? 'mt-0.5' : undefined}
        />
      ) : (
        <HugeiconsIcon
          icon={session.imported ? Tick02Icon : ComputerTerminal01Icon}
          strokeWidth={1.9}
          aria-hidden
          className={cn('size-4 shrink-0 text-tertiary', showCwd && 'mt-0.5')}
        />
      )}
      <span className={cn('flex min-w-0 flex-1 flex-col', showCwd ? 'gap-0.5' : 'py-1.5')}>
        <span
          className={cn(
            'truncate text-ui',
            session.imported ? 'text-tertiary' : held ? 'text-secondary' : 'text-foreground',
          )}
        >
          {session.title ?? t('common:untitledSession')}
        </span>
        {showCwd && session.cwd && (
          <span
            className="flex min-w-0 items-center gap-1 text-meta text-tertiary"
            title={session.cwd}
          >
            <HugeiconsIcon
              icon={Folder01Icon}
              strokeWidth={1.9}
              aria-hidden
              className="size-3 shrink-0 opacity-70"
            />
            <span className="min-w-0 truncate font-mono">{formatImportCwd(session.cwd)}</span>
          </span>
        )}
        {failure && <span className="line-clamp-2 text-meta text-danger">{failure}</span>}
      </span>
      {busy ? (
        <Spinner className={cn('size-3.5 text-tertiary', showCwd && 'mt-0.5')} />
      ) : (
        <span className={cn('flex shrink-0 items-center gap-2', showCwd && 'mt-0.5')}>
          {pickable && session.cache?.ttl ? <CacheLeft cache={session.cache} /> : null}
          {(state ?? ago) && (
            <span
              className={cn(
                'shrink-0 text-meta whitespace-nowrap text-tertiary tabular',
                // On a phone the terminal mark and Fork say it, and the title needs the room.
                held && 'phone:hidden',
              )}
            >
              {[state, held ? null : ago].filter(Boolean).join(' · ')}
            </span>
          )}
          {held && (
            <Button variant="outline" size="xs" disabled={locked} onClick={onFork}>
              {t('import.fork')}
            </Button>
          )}
        </span>
      )}
    </Row>
  )
}

/** The time left on a listed session's prompt cache, while it lasts. */
function CacheLeft({ cache }: { cache: PromptCache }) {
  const { t } = useTranslation('sidebar')
  const expiresAt = cache.ttl ? cache.lastRequestAt + cache.ttl : null
  const minutes = useCacheLeft(expiresAt, (left) => Math.ceil(left / 60_000))
  if (!minutes) return null
  return (
    <span className="shrink-0 rounded-md bg-subtle px-1.5 py-0.5 text-meta whitespace-nowrap text-secondary tabular">
      {t('import.cacheLeft', { count: minutes })}
    </span>
  )
}
