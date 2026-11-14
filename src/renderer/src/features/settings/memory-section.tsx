import { useMemo } from 'react'
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
  AddRow,
  EmptyLayer,
  EntryRow,
  ImportNotice,
  ListFailed,
  MemoryPending,
  MemorySwitch,
  NoProjects,
  PendingRow,
  ProjectPicker,
} from './memory-rows'
import { english, type GroupDef, type RowDef, type SectionDef } from './model'

const GLOBAL: MemoryScope = { layer: 'global' }

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

/**
 * Settings › Memory: the switch, then global memory and one project's, each entry opening a page
 * of its own; an offer to import what the agents remember on their own while there is any.
 */
export function useMemorySection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
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

  const base = {
    id: 'memory' as const,
    title: t('sections.memory'),
    description: t('pages.memory', onHost),
    icon: MEMORY_GLYPH,
    itemPage: (item: string) => <MemoryEntryPage item={item} />,
  }
  const switchRow = {
    id: 'enabled',
    name: t('memory.switch.name'),
    english: en('memory.switch.name'),
    keywords: `${t('memory.keywords')} ${t('memory.switch.keywords')}`,
  }
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
      name: entry.title,
      description: entry.description,
      group: within,
      layout: 'custom',
      render: () => <EntryRow item={item} entry={entry} />,
      open: () => openSettingsItem('memory', item),
    }
  }

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

  const globalGroup = group('global', t('memory.global.group'), {
    count: read.global.length > 0 ? read.global.length : undefined,
  })
  rows.push(...read.global.map((entry) => entryRow(GLOBAL, entry, globalGroup)))
  rows.push({
    id: 'global-add',
    name: t('memory.add'),
    group: globalGroup,
    layout: 'custom',
    render: () =>
      read.global.length === 0 ? (
        <EmptyLayer scope={GLOBAL} projectName="" />
      ) : (
        <AddRow scope={GLOBAL} projectName="" />
      ),
  })

  const entries = list.value
  const projectGroup = group('project', t('memory.project.group'), {
    count: entries && entries.length > 0 ? entries.length : undefined,
    actions: project && <ProjectPicker projects={projects} value={project.path} />,
  })
  if (!project || !projectScope) {
    rows.push({
      id: 'no-projects',
      name: t('memory.empty.noProjectsTitle'),
      group: projectGroup,
      layout: 'custom',
      render: () => <NoProjects />,
    })
    return { ...base, rows }
  }
  if (entries === null) {
    rows.push({
      id: 'project-state',
      name: project.name,
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
  rows.push(...entries.map((entry) => entryRow(projectScope, entry, projectGroup)))
  rows.push({
    id: 'project-add',
    name: t('memory.add'),
    group: projectGroup,
    layout: 'custom',
    render: () =>
      entries.length === 0 ? (
        <EmptyLayer scope={projectScope} projectName={project.name} />
      ) : (
        <AddRow scope={projectScope} projectName={project.name} />
      ),
  })
  return { ...base, rows }
}
