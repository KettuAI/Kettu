import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/components/ui/combobox'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { basename } from '@renderer/lib/format'
import { useProjectsStore } from '@renderer/stores/projects'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useOtherHosts } from '@renderer/stores/hosts'
import { openSession, showSearch, useViewStore } from '@renderer/stores/view'
import { searchSessions, type SessionSearchInput } from './search-sessions'

/** A session the dialog can open, with the fields Search matches. */
interface Hit extends SessionSearchInput {
  agentId: AgentId
  projectPath: string
  hostId: string | null
}

/**
 * Session search over the window, from the sidebar or Mod+K. An empty field lists the recent
 * sessions; typing narrows by title, project, host and branch. What was said is not searched.
 */
export function SearchDialog() {
  const { t } = useTranslation('sidebar')
  const open = useViewStore((s) => s.searchOpen)
  return (
    <Dialog open={open} onOpenChange={showSearch}>
      <DialogContent className="flex max-h-[min(600px,85svh)] flex-col gap-3 sm:max-w-[440px]">
        <DialogTitle>{t('nav.search')}</DialogTitle>
        {open && <SearchList />}
      </DialogContent>
    </Dialog>
  )
}

function SearchList() {
  const { t } = useTranslation('sidebar')
  const candidates = useCandidates()
  const [query, setQuery] = useState('')
  const hits = useMemo(() => searchSessions(candidates, query), [candidates, query])
  const trimmed = query.trim()

  const open = (hit: Hit | null) => {
    if (!hit) return
    openSession(hit.id, hit.projectPath)
    showSearch(false)
  }

  return (
    <Combobox<Hit>
      inline
      open
      autoHighlight
      items={hits}
      filter={null}
      value={null}
      onValueChange={open}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(hit) => hit.title}
    >
      <ComboboxInput showTrigger={false} autoFocus placeholder={t('search.placeholder')} />
      <ComboboxEmpty className="flex justify-center py-6 text-tertiary empty:hidden">
        {trimmed ? t('search.noMatch', { query: trimmed }) : t('search.none')}
      </ComboboxEmpty>
      <ComboboxList
        aria-label={t('nav.search')}
        className="-mx-1 max-h-[min(440px,60svh)] p-0 data-empty:hidden"
      >
        {(hit: Hit) => (
          <ComboboxItem key={hit.id} value={hit} className="gap-2.25 pr-2">
            <span aria-hidden className="grid size-4 shrink-0 place-items-center">
              <AgentMark agent={hit.agentId} size={16} hostId={hit.hostId} />
            </span>
            <span className="min-w-0 flex-1 truncate">{hit.title}</span>
            <span className="max-w-[46%] shrink-0 truncate pl-3 text-hint text-tertiary">
              {[hit.project, hit.host, hit.branch].filter(Boolean).join(' · ')}
            </span>
          </ComboboxItem>
        )}
      </ComboboxList>
    </Combobox>
  )
}

/** Sessions Search can find: not archived, not prepared, and not a subagent the replay never named. */
function useCandidates(): Hit[] {
  const { t } = useTranslation('sidebar')
  const byId = useSessionsStore((s) => s.byId)
  const projects = useProjectsStore(useShallow((s) => s.projects))
  const others = useOtherHosts()
  const noProject = t('project.noProject')
  const thisComputer = t('hosts.thisComputer')
  const unknown = t('hosts.unknown')

  return useMemo(() => {
    const names = new Map(projects.map((project) => [project.path, project.name]))
    const hostName = (id: string | null) =>
      id === null ? thisComputer : (others.find((host) => host.id === id)?.name ?? unknown)
    return Object.values(byId)
      .filter((summary) => !summary.archivedAt && !summary.prepared && !summary.missing)
      .map((summary) => {
        const hostId = hostOfSession(summary)
        return {
          id: summary.id,
          title: sessionTitle(summary),
          project: summary.scratch
            ? noProject
            : (names.get(summary.projectPath) ?? basename(summary.projectPath)),
          host: others.length > 0 ? hostName(hostId) : null,
          branch: summary.branch,
          detail: summary.description,
          updatedAt: summary.updatedAt,
          agentId: summary.agentId,
          projectPath: summary.projectPath,
          hostId,
        }
      })
  }, [byId, projects, others, noProject, thisComputer, unknown])
}
