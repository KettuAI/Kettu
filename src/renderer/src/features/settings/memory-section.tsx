import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryEntry, MemoryScope } from '@shared/memory'
import { MEMORY_GLYPH } from '@renderer/features/session/entries/tool-call-model'
import { useHostContext } from '@renderer/lib/host-features'
import { useHostScope } from '@renderer/stores/host-scope'
import { useMemoryProject } from '@renderer/stores/memory'
import { openSettingsItem } from '@renderer/stores/view'
import { useMemoryEntries, useMemoryOverview } from './memory-data'
import { memoryItemKey } from './memory-items'
import { MemoryEntryPage, ReadFailed } from './memory-page'
import {
  AddButton,
  EmptyLayer,
  EntryRow,
  ImportNotice,
  ListFailed,
  MemoryPending,
  MemorySwitch,
  MemorySearch,
  NoMatches,
  NoProjects,
  PendingRow,
  ProjectPicker,
  ShowMoreRow,
} from './memory-rows'
import type { GroupDef, RowDef, SectionDef } from './model'

const GLOBAL: MemoryScope = { layer: 'global' }
/** A layer longer than this lists its latest `SHORT` entries and a row that shows the rest. */
const LONG = 12
const SHORT = 10

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

/**
 * Settings › Memory: the switch, then global memory and one project's, each entry opening a page
 * of its own; an offer to import what the agents remember on their own while there is any.
 */
export function useMemorySection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const { hostId } = useHostScope()
  const overview = useMemoryOverview()
  const projects = overview.value?.projects ?? []
  const chosen = useMemoryProject(hostId)
  const project =
    projects.find((p) => p.path === chosen) ??
    projects.find((p) => p.count > 0) ??
    projects[0] ??
    null
  const path = project?.path ?? null
  const projectScope = useMemo<MemoryScope | null>(
    () => (path === null ? null : { layer: 'project', project: path }),
    [path],
  )
  const list = useMemoryEntries(projectScope)
  const [query, setQuery] = useState('')
  // Kept per project, so another project's list starts short again.
  const [allOf, setAllOf] = useState<string | null>(null)
  const needle = query.trim().toLowerCase()
  const matches = (entry: MemoryEntry): boolean =>
    needle === '' ||
    `${entry.title}\n${entry.description}\n${entry.body}`.toLowerCase().includes(needle)

  const base = {
    id: 'memory' as const,
    title: t('sections.memory'),
    description: t('pages.memory', onHost),
    icon: MEMORY_GLYPH,
    itemPage: (item: string) => <MemoryEntryPage item={item} />,
  }
  const switchRow = { id: 'enabled', setting: 'memory.enabled' as const }
  const read = overview.value
  if (read === null) {
    return {
      ...base,
      rows: [{ ...switchRow, searchOnly: true, render: () => null }],
      footer:
        overview.error === null ? (
          <MemoryPending />
        ) : (
          <ReadFailed error={overview.error} onRetry={overview.retry} />
        ),
    }
  }

  const entryRow = (scope: MemoryScope, entry: MemoryEntry, within: GroupDef): RowDef => {
    const item = memoryItemKey(scope, entry.id)
    return {
      id: `entry:${item}`,
      setting: 'memory.entries',
      item: { name: entry.title, description: entry.description },
      group: within,
      layout: 'custom',
      render: () => <EntryRow item={item} entry={entry} />,
      open: () => openSettingsItem('memory', item),
    }
  }
  // Entries the page leaves out, cut short or filtered away, stay findable in Settings' search.
  const hiddenRow = (scope: MemoryScope, entry: MemoryEntry, within: GroupDef): RowDef => ({
    ...entryRow(scope, entry, within),
    searchOnly: true,
    render: () => null,
  })

  const rows: RowDef[] = [
    {
      ...switchRow,
      description: t(read.enabled ? 'memory.switch.on' : 'memory.switch.off'),
      group: group('state', t('memory.switch.name'), {
        unlabeled: true,
        note: read.importable > 0 ? <ImportNotice importable={read.importable} /> : undefined,
      }),
      render: () => <MemorySwitch enabled={read.enabled} />,
    },
  ]

  const searchGroup = group('search', t('memory.search.placeholder'), {
    unlabeled: true,
    plain: true,
  })
  rows.push({
    id: 'search',
    setting: 'memory.entries',
    item: { name: t('memory.search.placeholder') },
    group: searchGroup,
    layout: 'custom',
    render: () => <MemorySearch value={query} onChange={setQuery} />,
  })
  const globalGroup = group('global', t('memory.global.group'), {
    count: read.global.length > 0 ? read.global.length : undefined,
    actions: read.global.length > 0 && <AddButton scope={GLOBAL} />,
  })
  rows.push(
    ...read.global.map((entry) =>
      matches(entry) ? entryRow(GLOBAL, entry, globalGroup) : hiddenRow(GLOBAL, entry, globalGroup),
    ),
  )
  if (read.global.length === 0 && needle === '')
    rows.push({
      id: 'global-add',
      setting: 'memory.entries',
      item: { name: t('memory.add') },
      group: globalGroup,
      layout: 'custom',
      render: () => <EmptyLayer scope={GLOBAL} projectName="" />,
    })
  const entries = list.value
  const projectGroup = group('project', t('memory.project.group'), {
    count: entries && entries.length > 0 ? entries.length : undefined,
    actions: project && (
      <>
        <ProjectPicker projects={projects} value={project.path} />
        {projectScope && entries && entries.length > 0 && <AddButton scope={projectScope} />}
      </>
    ),
  })
  if (!project || !projectScope) {
    rows.push({
      id: 'no-projects',
      setting: 'memory.entries',
      item: { name: t('memory.empty.noProjectsTitle') },
      group: projectGroup,
      layout: 'custom',
      render: () => <NoProjects />,
    })
    return { ...base, rows }
  }
  if (entries === null) {
    rows.push({
      id: 'project-state',
      setting: 'memory.entries',
      item: { name: project.name },
      group: projectGroup,
      layout: 'custom',
      render: () =>
        list.error === null ? (
          <PendingRow />
        ) : (
          <ListFailed error={list.error} onRetry={list.retry} />
        ),
    })
    return { ...base, rows }
  }
  if (entries.length === 0) {
    rows.push({
      id: 'project-add',
      setting: 'memory.entries',
      item: { name: t('memory.add') },
      group: projectGroup,
      layout: 'custom',
      render: () => <EmptyLayer scope={projectScope} projectName={project.name} />,
    })
    return { ...base, rows }
  }
  const found = entries.filter(matches)
  // The project's group stays while searching, so its picker can switch to another project.
  const hidden = (some: MemoryEntry[]): RowDef[] =>
    some.map((entry) => hiddenRow(projectScope, entry, projectGroup))
  if (found.length === 0 && needle !== '') {
    rows.push(...hidden(entries))
    rows.push({
      id: 'no-matches',
      setting: 'memory.entries',
      item: { name: t('memory.search.none', { query: query.trim() }) },
      group: projectGroup,
      layout: 'custom',
      render: () => <NoMatches query={query.trim()} />,
    })
    return { ...base, rows }
  }
  const short = needle === '' && allOf !== project.path && found.length > LONG
  const shown = short ? found.slice(0, SHORT) : found
  rows.push(...shown.map((entry) => entryRow(projectScope, entry, projectGroup)))
  rows.push(...hidden(entries.filter((entry) => !shown.includes(entry))))
  if (short)
    rows.push({
      id: 'project-more',
      setting: 'memory.entries',
      item: { name: t('memory.showMore', { count: found.length - shown.length }) },
      group: projectGroup,
      layout: 'custom',
      render: () => (
        <ShowMoreRow count={found.length - shown.length} onClick={() => setAllOf(project.path)} />
      ),
    })
  return { ...base, rows }
}
