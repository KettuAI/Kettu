import { useEffect, useRef, useState } from 'react'
import { Alert02Icon, ComputerTerminal01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ImportableSession, Project } from '@shared/agent-host'
import type { AgentId, PromptCache } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { readiness } from '@renderer/features/agents/readiness'
import { useCacheLeft } from '@renderer/features/prompt-cache/cache-phase'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import {
  allSelected,
  type AgentList,
  type AgentLists,
  importableKeys,
  importInOrder,
  importKey,
  listed,
  markImported,
  selectedSessions,
  sessionAgo,
  shownAgent,
  type SourceCount,
  sourceCount,
  withKeys,
} from './import-sessions-model'

/**
 * Sessions the agents already have for this folder, such as ones started in a terminal: the agents
 * in a rail, the shown agent's sessions beside it. Nothing is copied until the chosen ones are
 * imported.
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
  const agentIds = agents.map((a) => a.id)
  const [lists, setLists] = useState<AgentLists>({})
  const [chosen, setChosen] = useState<AgentId | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  // The session being imported, and why the ones that failed did.
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  // Each opening and closing starts a new run, so an import still going stops at its next session.
  const run = useRef(0)

  // Requests only: the loading marker is set by whoever starts a load, never inside an effect.
  const request = (agentId: AgentId, cursor?: string) => {
    // A page for an earlier opening, maybe of another project, is dropped.
    const at = run.current
    host('agents.listSessions', {
      agentId,
      projectPath: project.path,
      ...(cursor ? { cursor } : {}),
    })
      .then((page) => {
        if (run.current !== at) return
        setLists((l) => ({
          ...l,
          [agentId]: {
            sessions: [...(cursor ? (l[agentId]?.sessions ?? []) : []), ...page.sessions],
            nextCursor: page.nextCursor,
            loading: false,
            error: null,
          },
        }))
      })
      .catch((error: unknown) => {
        if (run.current !== at) return
        setLists((l) => ({
          ...l,
          [agentId]: {
            sessions: l[agentId]?.sessions ?? [],
            nextCursor: null,
            loading: false,
            error: errorMessage(error),
          },
        }))
      })
  }

  const reload = (agentId: AgentId) => {
    setLists((l) => ({
      ...l,
      [agentId]: { sessions: [], nextCursor: null, loading: true, error: null },
    }))
    request(agentId)
  }

  const loadMore = (agentId: AgentId, cursor: string) => {
    setLists((l) => ({
      ...l,
      [agentId]: {
        sessions: l[agentId]?.sessions ?? [],
        nextCursor: null,
        loading: true,
        error: null,
      },
    }))
    request(agentId, cursor)
  }

  // Each opening starts over, with the agents that can list sessions at that moment.
  const [shownOpen, setShownOpen] = useState(false)
  if (open !== shownOpen) {
    setShownOpen(open)
    if (open) {
      setLists({})
      setChosen(null)
      setSelected(new Set())
      setBusy(null)
      setFailed({})
      setRunning(false)
    }
  }

  useEffect(() => {
    run.current += 1
    if (!open) return
    for (const agent of agents) request(agent.id)
    // Reload only when the dialog opens; the agent list is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const shown = shownAgent(agentIds, lists, chosen)
  const shownList = shown ? lists[shown] : undefined
  const keys = shown ? importableKeys(shown, shownList) : []
  const toImport = selectedSessions(agentIds, lists, selected)
  const sources = new Set(toImport.map((s) => s.agentId)).size

  const importSelected = async () => {
    const token = run.current
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
            projectPath: project.path,
            acpSessionId,
          })
          useSessionsStore.getState().upsert(summary)
          setLists((l) => markImported(l, agentId, acpSessionId))
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
        projectPath: project.path,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(560px,85svh)] flex-col gap-0 p-0 sm:max-w-[700px]"
      >
        <DialogHeader className="gap-1.5 px-5.5 pt-5 pb-4">
          <DialogTitle>{t('import.title', { project: project.name })}</DialogTitle>
          <DialogDescription>{t('import.description')}</DialogDescription>
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
              className="w-56 shrink-0 scroll-fade-y justify-start overflow-y-auto overscroll-contain p-2 group-data-vertical/tabs:h-auto phone:max-h-30 phone:w-full"
            >
              {agents.map((agent) => (
                <SourceRow
                  key={agent.id}
                  agentId={agent.id}
                  name={agent.name}
                  count={sourceCount(agent.id, lists[agent.id], selected)}
                  failed={!!lists[agent.id]?.error}
                />
              ))}
            </TabsList>
            <TabsContent
              value={shown}
              tabIndex={-1}
              className="flex min-h-0 min-w-0 flex-col border-l border-subtle phone:border-t phone:border-l-0"
            >
              <SessionList
                agentId={shown}
                agentName={agents.find((a) => a.id === shown)?.name ?? ''}
                list={shownList}
                keys={keys}
                selected={selected}
                busy={busy}
                failed={failed}
                locked={running}
                onSelect={(picked, on) => setSelected((s) => withKeys(s, picked, on))}
                onMore={(cursor) => loadMore(shown, cursor)}
                onFork={(acpSessionId) => void forkSession(shown, acpSessionId)}
                onRetry={() => reload(shown)}
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

/** One agent's sessions: the ones to pick under a row that picks them all, the rest as plain rows. */
function SessionList({
  agentId,
  agentName,
  list,
  keys,
  selected,
  busy,
  failed,
  locked,
  onSelect,
  onMore,
  onFork,
  onRetry,
}: {
  agentId: AgentId
  agentName: string
  list: AgentList | undefined
  /** The sessions of the list that can be picked. */
  keys: readonly string[]
  selected: ReadonlySet<string>
  busy: string | null
  failed: Record<string, string>
  locked: boolean
  onSelect: (keys: readonly string[], on: boolean) => void
  onMore: (cursor: string) => void
  onFork: (acpSessionId: string) => void
  onRetry: () => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  if (list?.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-ui text-balance text-danger">{list.error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('common:actions.retry')}
        </Button>
      </div>
    )
  }
  if (!listed(list)) {
    return (
      <div className="flex flex-col px-2 pt-2">
        {[0.62, 0.48, 0.55, 0.4].map((width) => (
          <div key={width} className="flex h-9 items-center gap-2.5 px-2">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
          </div>
        ))}
      </div>
    )
  }
  if (list.sessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="text-ui text-secondary">{t('import.noSessions', { agent: agentName })}</p>
      </div>
    )
  }
  const picked = keys.filter((key) => selected.has(key)).length
  const inKettu = list.sessions.filter((s) => s.imported).length
  const more = list.nextCursor !== null || list.loading
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-subtle px-4 text-control">
        {keys.length > 0 ? (
          <label className="flex min-w-0 items-center gap-2.5 text-secondary">
            <Checkbox
              checked={allSelected(keys, selected)}
              indeterminate={picked > 0 && picked < keys.length}
              disabled={locked}
              onCheckedChange={(on) => onSelect(keys, on)}
            />
            <span className="truncate">
              {t(more ? 'import.selectShown' : 'import.selectAll', { count: keys.length })}
            </span>
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
        {list.sessions.map((s) => {
          const key = importKey(agentId, s.acpSessionId)
          return (
            <li key={s.acpSessionId}>
              <SessionRow
                session={s}
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
  )
}

/**
 * A listed session. Only one that can be imported has a checkbox; one already in Kettu and one a
 * terminal still has open show a quiet mark in its place.
 */
function SessionRow({
  session,
  checked,
  busy,
  failure,
  locked,
  onSelect,
  onFork,
}: {
  session: ImportableSession
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
  const state = session.imported ? t('import.imported') : held ? t('import.held') : null
  const Row = pickable ? 'label' : 'div'
  return (
    <Row
      className={cn(
        'flex min-h-9 items-center gap-2.5 rounded-md px-2',
        pickable && 'hover:bg-hover',
      )}
      title={held ? t('import.heldTip') : undefined}
    >
      {pickable ? (
        <Checkbox checked={checked} disabled={locked} onCheckedChange={onSelect} />
      ) : (
        <HugeiconsIcon
          icon={session.imported ? Tick02Icon : ComputerTerminal01Icon}
          strokeWidth={1.9}
          aria-hidden
          className="size-4 shrink-0 text-tertiary"
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col py-1.5">
        <span
          className={cn(
            'truncate text-ui',
            session.imported ? 'text-tertiary' : held ? 'text-secondary' : 'text-foreground',
          )}
        >
          {session.title ?? t('common:untitledSession')}
        </span>
        {failure && <span className="line-clamp-2 text-meta text-danger">{failure}</span>}
      </span>
      {busy ? (
        <Spinner className="size-3.5 text-tertiary" />
      ) : (
        <>
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
        </>
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
