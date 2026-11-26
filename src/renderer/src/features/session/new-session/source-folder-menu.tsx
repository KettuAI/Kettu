import { useMemo } from 'react'
import { Folder01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Glyph } from '@renderer/features/shell/glyph'
import { basename } from '@renderer/lib/format'
import { hostPath } from '@renderer/lib/host-paths'
import { isFolderMissing, projectFolders } from '@renderer/stores/projects'
import { nameHints } from '../project-names'

/**
 * Source folder selector shown on New session's tray only when the chosen project has more than
 * one associated source folder, keeping single-folder projects uncluttered.
 */
export function SourceFolderMenu({
  project,
  folder,
  onChoose,
}: {
  project: Project | null
  folder: string | null
  onChoose: (folderPath: string) => void
}) {
  const { t } = useTranslation('session')
  const folders = useMemo(() => (project ? projectFolders(project) : []), [project])
  const hints = useMemo(() => nameHints(folders.map(hostPath)), [folders])

  if (!project || folders.length <= 1) return null

  const active = folder && folders.includes(folder) ? folder : project.path
  const activeHostPath = hostPath(active)
  const activeLabel = basename(activeHostPath)
  const activeHint = hints.get(activeHostPath)
  const activeMissing = isFolderMissing(project, active)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('newSession.sourceFolder')}
            title={activeHostPath}
            className="ui-as-tray-link kettu-tray-link--folder"
          />
        }
      >
        <Glyph icon={Folder01Icon} size={13} />
        <span className="kettu-tray-link__text">
          {activeHint ? `${activeLabel} (${activeHint})` : activeLabel}
        </span>
        {activeMissing && (
          <span className="kettu-tray-link__danger">{t('newSession.missing')}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-60 max-w-88">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('newSession.sourceFolderLabel')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={active}
            onValueChange={(value) => {
              const next = String(value)
              if (next && next !== active) onChoose(next)
            }}
          >
            {folders.map((item) => {
              const display = hostPath(item)
              const label = basename(display)
              const hint = hints.get(display)
              const missing = isFolderMissing(project, item)
              const primary = item === project.path
              return (
                <DropdownMenuRadioItem
                  key={item}
                  value={item}
                  disabled={missing}
                  title={display}
                  className="items-start py-1.5"
                >
                  <Glyph icon={Folder01Icon} size={14} className="mt-0.5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate font-medium">{label}</span>
                      {hint && (
                        <span className="truncate text-xs text-muted-foreground">{hint}</span>
                      )}
                      {primary && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {t('newSession.sourceFolderPrimary')}
                        </span>
                      )}
                    </span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {display}
                    </span>
                  </span>
                  {missing && (
                    <span className="ml-auto shrink-0 text-xs text-danger">
                      {t('newSession.missing')}
                    </span>
                  )}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
