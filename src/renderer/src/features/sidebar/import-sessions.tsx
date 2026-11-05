import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
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
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
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
  withKeys,
} from './import-sessions-model'

/**
 * Sessions the agents already have for this folder, such as ones started in a terminal, one tab
 * per agent. Nothing is copied until the chosen ones are imported.
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(600px,85svh)] flex-col gap-0 p-0 sm:max-w-[470px]"
      >
        <DialogHeader className="gap-1.5 px-5.5 pt-5">
          <DialogTitle>{t('import.title', { project: project.name })}</DialogTitle>
          <DialogDescription>{t('import.description')}</DialogDescription>
        </DialogHeader>
        {agents.length === 0 || !shown ? (
          <p className="px-5.5 pt-3.5 text-ui text-secondary">{t('import.noAgents')}</p>
        ) : (
          <Tabs
            value={shown}
            onValueChange={(value: AgentId) => setChosen(value)}
            className="min-h-0 flex-1 px-5.5 pt-3.5"
          >
            <TabsList
              aria-label={t('import.agents')}
              className="justify-start gap-1.5 rounded-none bg-transparent p-0 shadow-none group-data-horizontal/tabs:h-auto"
            >
              {agents.map((agent) => {
                const list = lists[agent.id]
                const known = listed(list)
                const empty = known && list.sessions.length === 0 && !list.nextCursor
                return (
                  <TabsTrigger
                    key={agent.id}
                    value={agent.id}
                    disabled={empty && agent.id !== shown}
                    className="h-7 flex-none rounded-xl px-3 text-control font-medium text-secondary not-data-active:hover:bg-hover data-active:bg-subtle data-active:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-none dark:text-secondary"
                  >
                    {known
                      ? t(list.nextCursor ? 'import.tabMore' : 'import.tab', {
                          agent: agent.name,
                          count: list.sessions.length,
                        })
                      : agent.name}
                  </TabsTrigger>
                )
              })}
            </TabsList>
            <TabsContent value={shown} tabIndex={-1} className="min-h-0 overflow-y-auto">
              <SessionList
                agentId={shown}
                list={shownList}
                selected={selected}
                busy={busy}
                failed={failed}
                locked={running}
                onSelect={(key, on) => setSelected((s) => withKeys(s, [key], on))}
                onMore={(cursor) => loadMore(shown, cursor)}
              />
            </TabsContent>
          </Tabs>
        )}
        <p className="px-5.5 pt-2.5 text-hint text-tertiary">{t('import.footnote')}</p>
        <div className="flex items-center gap-2 px-5.5 py-4.5">
          {keys.length > 0 && (
            <label className="flex items-center gap-2 text-control text-secondary">
              <Checkbox
                checked={allSelected(keys, selected)}
                disabled={running}
                className="data-disabled:opacity-40"
                onCheckedChange={(on) => setSelected((s) => withKeys(s, keys, on))}
              />
              {t('import.selectAll', { count: keys.length })}
            </label>
          )}
          <span className="flex-1" />
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

/** One agent's sessions as rows to pick, each with when it last changed. */
function SessionList({
  agentId,
  list,
  selected,
  busy,
  failed,
  locked,
  onSelect,
  onMore,
}: {
  agentId: AgentId
  list: AgentList | undefined
  selected: ReadonlySet<string>
  busy: string | null
  failed: Record<string, string>
  locked: boolean
  onSelect: (key: string, on: boolean) => void
  onMore: (cursor: string) => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  if (list?.error) return <p className="py-2 text-ui text-danger">{list.error}</p>
  if (!listed(list)) {
    return (
      <div className="flex flex-col">
        {[0.62, 0.48, 0.55].map((width) => (
          <div key={width} className="flex h-10 items-center gap-2.5 border-b border-subtle px-1">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
          </div>
        ))}
      </div>
    )
  }
  if (list.sessions.length === 0) {
    return <p className="py-2 text-ui text-secondary">{t('import.noSessions')}</p>
  }
  return (
    <ul className="flex flex-col">
      {list.sessions.map((s) => {
        const key = importKey(agentId, s.acpSessionId)
        const failure = failed[key]
        const meta = [
          s.imported ? t('import.imported') : null,
          s.updatedAt ? sessionAgo(Date.parse(s.updatedAt)) : null,
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <li key={s.acpSessionId}>
            <label className="flex h-10 items-center gap-2.5 border-b border-subtle px-1">
              <Checkbox
                checked={s.imported || selected.has(key)}
                disabled={s.imported || locked}
                className="data-disabled:opacity-40"
                onCheckedChange={(on) => onSelect(key, on)}
              />
              <AgentMark agent={agentId} size={16} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13.5px]',
                  s.imported ? 'text-secondary' : 'text-foreground',
                )}
              >
                {s.title ?? t('common:untitledSession')}
              </span>
              {failure && (
                <span className="max-w-40 truncate text-meta text-danger" title={failure}>
                  {failure}
                </span>
              )}
              {busy === key ? (
                <Spinner className="size-3.5 text-tertiary" />
              ) : (
                meta && (
                  <span className="text-meta whitespace-nowrap text-tertiary tabular">{meta}</span>
                )
              )}
            </label>
          </li>
        )
      })}
      {list.nextCursor !== null || list.loading ? (
        <li className="pt-1.5">
          <Button
            variant="ghost"
            size="xs"
            className="text-tertiary"
            disabled={list.loading}
            onClick={() => list.nextCursor && onMore(list.nextCursor)}
          >
            {list.loading && <Spinner className="size-3" />}
            {t('import.showMore')}
          </Button>
        </li>
      ) : null}
    </ul>
  )
}
