import { useMemo } from 'react'
import { PlusIcon } from 'lucide-react'
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
import { errorMessage } from '@renderer/lib/host'
import { useProjectsStore } from '@renderer/stores/projects'
import { chooseNewSessionProject } from '@renderer/stores/view'
import { nameHints } from '../project-names'

// The values of the No project and Open project… items, which no project's path can take.
const NO_PROJECT = '\0no-project'
const OPEN_PROJECT = '\0open-project'

interface ProjectGroup {
  value: 'none' | 'recent' | 'open'
  items: string[]
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
  const { contains } = useComboboxFilter()
  const byPath = useMemo(() => new Map(projects.map((p) => [p.path, p])), [projects])
  const hints = useMemo(() => nameHints(projects.map((p) => p.path)), [projects])
  const groups = useMemo<ProjectGroup[]>(
    () => [
      { value: 'none', items: [NO_PROJECT] },
      { value: 'recent', items: projects.map((p) => p.path) },
      { value: 'open', items: [OPEN_PROJECT] },
    ],
    [projects],
  )
  const label = (value: string) =>
    value === NO_PROJECT ? t('newSession.noProject') : (byPath.get(value)?.name ?? value)
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
        else if (value === NO_PROJECT) choose(null)
        else if (value) choose(value)
      }}
      itemToStringLabel={label}
      filter={(value: string, query: string) =>
        value === OPEN_PROJECT || contains(`${label(value)} ${hints.get(value) ?? ''}`, query)
      }
    >
      <ComboboxTrigger
        render={
          <Button
            variant="quiet"
            size="compact"
            aria-label={t('newSession.project')}
            title={noProject ? undefined : project?.path}
            className="min-w-12 shrink-10 gap-1 px-2"
          />
        }
      >
        <span className="truncate font-medium text-foreground">
          {noProject
            ? t('newSession.noProject')
            : (project?.name ?? t('newSession.chooseProjectShort'))}
        </span>
        {project?.missing && !noProject && (
          <span className="shrink-0 text-danger">{t('newSession.missing')}</span>
        )}
      </ComboboxTrigger>
      <ComboboxContent sideOffset={6} className="max-w-80">
        <ComboboxInput
          showTrigger={false}
          placeholder={t('newSession.searchProjects')}
          aria-label={t('newSession.searchProjectsLabel')}
          spellCheck={false}
        />
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
                    <ComboboxItem key={value} value={value}>
                      <PlusIcon className="size-3.5 text-icon" />
                      {t('newSession.openProject')}
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
    </Combobox>
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
