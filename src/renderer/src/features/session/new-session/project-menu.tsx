import { useMemo, useState } from 'react'
import { FolderIcon, LaptopIcon, SearchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import { addProjectFromDialog } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import { InputGroupAddon } from '@renderer/components/ui/input-group'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { formatShortcut } from '@renderer/lib/platform'
import { isAway, useOtherHost, useOtherHosts, type OtherHost } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { chooseNewSessionProject } from '@renderer/stores/view'
import { nameHints } from '../project-names'
import { HostFolderDialog } from './host-folder-dialog'

// The values of the No project and Open project… items, which no project's path can take.
const NO_PROJECT = '\0no-project'
const OPEN_PROJECT = '\0open-project'
// Open project on <host>..., followed by the host's id.
const OPEN_ON = '\0open-on:'

interface ProjectGroup {
  value: 'none' | 'recent' | 'open' | `host:${string}`
  /** With other hosts added, the host of a group of projects, null being this computer. */
  hostId?: string | null
  items: string[]
}

/** The groups of the menu: No project, the projects, by host once there are others, and Open. */
function projectGroups(projects: readonly Project[], hosts: readonly OtherHost[]): ProjectGroup[] {
  if (hosts.length === 0) {
    return [
      { value: 'none', items: [NO_PROJECT] },
      { value: 'recent', items: projects.map((p) => p.path) },
      { value: 'open', items: [OPEN_PROJECT] },
    ]
  }
  const of = (hostId: string | null) =>
    projects.filter((p) => hostOfPath(p.path) === hostId).map((p) => p.path)
  const byHost: ProjectGroup[] = [
    { value: 'host:', hostId: null, items: of(null) },
    ...hosts.map((h): ProjectGroup => ({ value: `host:${h.id}`, hostId: h.id, items: of(h.id) })),
  ]
  return [
    { value: 'none', items: [NO_PROJECT] },
    ...byHost.filter((group) => group.items.length > 0),
    {
      value: 'open',
      items: [
        OPEN_PROJECT,
        ...hosts.filter((h) => h.connection.state === 'online').map((h) => `${OPEN_ON}${h.id}`),
      ],
    },
  ]
}

/**
 * The route line's project: No project, then the projects by name, most recently opened first,
 * with a search field over them and Open project… last. The items are paths. A failure to add a
 * project shows in the error line the screen passes in. `onChoose` takes the choice instead of
 * New session, for a routine's own project row.
 */
export function ProjectMenu({
  project,
  noProject,
  onError,
  onChoose,
}: {
  project: Project | null
  noProject: boolean
  onError: (message: string | null) => void
  onChoose?: (projectPath: string | null) => void
}) {
  const { t } = useTranslation('session')
  const choose = onChoose ?? chooseNewSessionProject
  const projects = useProjectsStore((s) => s.projects)
  const hosts = useOtherHosts()
  const { contains } = useComboboxFilter()
  const byPath = useMemo(() => new Map(projects.map((p) => [p.path, p])), [projects])
  // Each host tells its own projects of one name apart, by the paths it writes.
  const hints = useMemo(() => {
    const hosted = new Map<string, string>()
    for (const hostId of new Set(projects.map((p) => hostOfPath(p.path)))) {
      const paths = projects.map((p) => p.path).filter((path) => hostOfPath(path) === hostId)
      const found = nameHints(paths.map(hostPath))
      for (const path of paths) {
        const hint = found.get(hostPath(path))
        if (hint) hosted.set(path, hint)
      }
    }
    return hosted
  }, [projects])
  const groups = useMemo(() => projectGroups(projects, hosts), [projects, hosts])
  const [browsing, setBrowsing] = useState<{ hostId: string; open: boolean } | null>(null)
  const hostName = (hostId: string | null) =>
    hostId === null
      ? t('newSession.thisComputer')
      : (hosts.find((h) => h.id === hostId)?.name ?? hostId)
  const projectHost = project ? hostOfPath(project.path) : null
  const label = (value: string) =>
    value === NO_PROJECT
      ? t('newSession.noProject')
      : value === OPEN_PROJECT
        ? t(hosts.length > 0 ? 'newSession.openProjectHere' : 'newSession.openProject')
        : value.startsWith(OPEN_ON)
          ? t('newSession.openProjectOn', { host: hostName(value.slice(OPEN_ON.length)) })
          : (byPath.get(value)?.name ?? value)
  const add = async () => {
    onError(null)
    try {
      const path = await addProjectFromDialog()
      if (path) choose(path)
    } catch (e) {
      onError(errorMessage(e))
    }
  }

  return (
    <Combobox
      items={groups}
      value={noProject ? NO_PROJECT : (project?.path ?? null)}
      onValueChange={(value: string | null) => {
        if (value === OPEN_PROJECT) void add()
        else if (value?.startsWith(OPEN_ON)) {
          onError(null)
          setBrowsing({ hostId: value.slice(OPEN_ON.length), open: true })
        } else if (value === NO_PROJECT) choose(null)
        else if (value) choose(value)
      }}
      itemToStringLabel={label}
      filter={(value: string, query: string) =>
        value === OPEN_PROJECT ||
        value.startsWith(OPEN_ON) ||
        contains(
          `${label(value)} ${hints.get(value) ?? ''} ${hosts.length > 0 ? hostName(hostOfPath(value)) : ''}`,
          query,
        )
      }
    >
      <ComboboxTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            aria-label={
              !noProject && project && projectHost
                ? t('newSession.projectOnHost', { name: project.name, host: hostName(projectHost) })
                : t('newSession.project')
            }
            title={noProject || !project ? undefined : hostPath(project.path)}
            className="min-w-13 shrink-10 gap-1 px-2.25 text-control font-normal has-data-[icon=inline-end]:pr-2.25"
          />
        }
      >
        <FolderIcon />
        <span className="truncate text-foreground">
          {noProject
            ? t('newSession.noProject')
            : (project?.name ?? t('newSession.chooseProjectShort'))}
        </span>
        {!noProject && projectHost && (
          <span className="min-w-0 shrink-5 truncate text-muted-foreground">
            {hostName(projectHost)}
          </span>
        )}
        {project?.missing && !noProject && (
          <span className="shrink-0 text-danger">{t('newSession.missing')}</span>
        )}
      </ComboboxTrigger>
      <ComboboxContent sideOffset={6} className="max-w-80 min-w-60">
        <ComboboxInput
          showTrigger={false}
          placeholder={t('newSession.searchProjects')}
          aria-label={t('newSession.searchProjectsLabel')}
          spellCheck={false}
        >
          <InputGroupAddon>
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
        </ComboboxInput>
        <ComboboxList className="max-h-none overflow-y-visible">
          {(group: ProjectGroup, index: number) =>
            group.value === 'none' ? (
              <ComboboxGroup key={group.value} items={group.items}>
                <ComboboxCollection>
                  {(value: string) => (
                    <ComboboxItem key={value} value={value}>
                      {t('newSession.noProject')}
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            ) : group.value.startsWith('host:') ? (
              <HostProjects key={group.value} group={group} byPath={byPath} hints={hints} />
            ) : group.value === 'recent' ? (
              <ComboboxGroup key={group.value} items={group.items}>
                {index > 0 && <ComboboxSeparator />}
                <ComboboxLabel>{t('newSession.recent')}</ComboboxLabel>
                {/* Only the projects scroll, leaving room for the search field and Open project… */}
                <div className="relative -mx-1.5 max-h-[min(--spacing(72),calc(var(--available-height)---spacing(28)))] scroll-fade-y overflow-y-auto overscroll-contain px-1.5">
                  <ComboboxCollection>
                    {(path: string) => {
                      const p = byPath.get(path)
                      return (
                        p && (
                          <ComboboxItem key={path} value={path} disabled={p.missing} title={path}>
                            <ProjectName name={p.name} hint={hints.get(path)} />
                            {p.missing && (
                              <span className="ml-auto text-xs text-muted-foreground">
                                {t('newSession.missing')}
                              </span>
                            )}
                          </ComboboxItem>
                        )
                      )
                    }}
                  </ComboboxCollection>
                </div>
              </ComboboxGroup>
            ) : (
              <ComboboxGroup key={group.value} items={group.items}>
                {index > 0 ? (
                  <ComboboxSeparator />
                ) : (
                  projects.length > 0 && (
                    <div className="flex min-h-row items-center px-2 text-ui text-muted-foreground">
                      {t('newSession.noMatchingProjects')}
                    </div>
                  )
                )}
                <ComboboxCollection>
                  {(value: string) => (
                    <ComboboxItem key={value} value={value} className="pr-2">
                      {label(value)}
                      {value === OPEN_PROJECT && (
                        <span className="ml-auto pl-4 text-xs text-muted-foreground tabular">
                          {formatShortcut('Mod+O')}
                        </span>
                      )}
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            )
          }
        </ComboboxList>
        {/* Sized by every project, so the menu keeps its width while the list filters. */}
        <div aria-hidden className="invisible h-0 overflow-hidden px-1.5">
          {projects.map((p) => (
            <div key={p.path} className="flex gap-2 pr-8 pl-2 text-ui whitespace-nowrap">
              <ProjectName name={p.name} hint={hints.get(p.path)} />
            </div>
          ))}
        </div>
      </ComboboxContent>
      <HostFolderDialog
        hostId={browsing?.hostId ?? null}
        open={browsing?.open ?? false}
        onOpenChange={(open) => setBrowsing((b) => (b ? { ...b, open } : b))}
        onOpened={(path) => {
          setBrowsing((b) => (b ? { ...b, open: false } : b))
          choose(path)
        }}
      />
    </Combobox>
  )
}

/** One host's projects under its name; an offline host's are listed but cannot be chosen. */
function HostProjects({
  group,
  byPath,
  hints,
}: {
  group: ProjectGroup
  byPath: Map<string, Project>
  hints: Map<string, string>
}) {
  const { t } = useTranslation('session')
  const host = useOtherHost(group.hostId ?? null)
  const away = isAway(host?.connection ?? null)
  const name = group.hostId === null ? t('newSession.thisComputer') : (host?.name ?? '')
  const Icon = group.hostId === null ? LaptopIcon : null
  return (
    <ComboboxGroup items={group.items}>
      <ComboboxSeparator />
      <ComboboxLabel className="flex items-center gap-1.5">
        {Icon ? (
          <Icon aria-hidden className="size-3" />
        ) : (
          <HostIcon platform={host?.platform ?? 'linux'} className="size-3" />
        )}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {away && <span className="shrink-0">{t('newSession.hostOffline')}</span>}
      </ComboboxLabel>
      {/* Only the projects scroll, a host's at a time. */}
      <div className="relative -mx-1.5 max-h-[min(--spacing(56),calc(var(--available-height)---spacing(28)))] scroll-fade-y overflow-y-auto overscroll-contain px-1.5">
        <ComboboxCollection>
          {(path: string) => {
            const p = byPath.get(path)
            return (
              p && (
                <ComboboxItem
                  key={path}
                  value={path}
                  disabled={p.missing || away}
                  title={hostPath(path)}
                >
                  <ProjectName name={p.name} hint={hints.get(path)} />
                  {p.missing && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t('newSession.missing')}
                    </span>
                  )}
                </ComboboxItem>
              )
            )
          }}
        </ComboboxCollection>
      </div>
    </ComboboxGroup>
  )
}

/** A project's name, with the parent folders that tell it from another of the same name. */
function ProjectName({ name, hint }: { name: string; hint: string | undefined }) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="truncate">{name}</span>
      {hint && <span className="min-w-0 shrink-3 truncate text-muted-foreground">{hint}</span>}
    </span>
  )
}
