import { WorkflowSquare03Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { WorkflowSummary } from '@shared/tasks'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { useTasksStore } from '@renderer/stores/tasks'

const JUST_CHAT = ''

/** A workflow's key in the menu: no two sources share one. */
function workflowKey(workflow: Pick<WorkflowSummary, 'source' | 'id'>): string {
  return `${workflow.source}:${workflow.id}`
}

/**
 * New session's workflow: Just chat, a plain session, or one of the project's workflows, which
 * makes the send create a task. A workflow needs a project, so without one there is no choice.
 */
export function WorkflowMenu({
  projectPath,
  workflow,
  onChoose,
}: {
  /** The project chosen, null for none or No project. */
  projectPath: string | null
  workflow: WorkflowSummary | null
  onChoose: (workflow: WorkflowSummary | null) => void
}) {
  const { t } = useTranslation('tasks')
  const list = useTasksStore((s) => (projectPath ? s.workflows[projectPath] : undefined))
  const label = workflow?.name ?? t('workflow.justChat')

  if (!projectPath) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-disabled
              aria-label={t('workflow.label')}
              className="ui-as-tray-link kettu-tray-link--agent opacity-50"
              data-static=""
            />
          }
        >
          <Glyph icon={WorkflowSquare03Icon} size={13} className="shrink-0" />
          <span className="kettu-tray-link__text">{label}</span>
        </TooltipTrigger>
        <TooltipContent>{t('workflow.needsProject')}</TooltipContent>
      </Tooltip>
    )
  }

  const items = list?.value ?? []
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void useTasksStore.getState().loadWorkflows(projectPath)
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('workflow.label')}
            title={t('workflow.label')}
            className="ui-as-tray-link kettu-tray-link--agent"
          />
        }
      >
        <Glyph icon={WorkflowSquare03Icon} size={13} className="shrink-0" />
        <span className="kettu-tray-link__text">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-80">
        <DropdownMenuRadioGroup
          value={workflow ? workflowKey(workflow) : JUST_CHAT}
          onValueChange={(value) =>
            onChoose(items.find((item) => workflowKey(item) === value) ?? null)
          }
        >
          <DropdownMenuRadioItem value={JUST_CHAT}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{t('workflow.justChat')}</span>
              <span className="truncate text-xs text-muted-foreground">
                {t('workflow.justChatNote')}
              </span>
            </span>
          </DropdownMenuRadioItem>
          {(items.length > 0 || list?.loading || list?.error) && <DropdownMenuSeparator />}
          {items.map((item) => (
            <DropdownMenuRadioItem
              key={workflowKey(item)}
              value={workflowKey(item)}
              disabled={item.problem !== null}
              // The reason shows on hover, which a disabled item otherwise takes no part in.
              className="data-disabled:pointer-events-auto"
              title={item.problem ?? undefined}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate">{item.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(`workflow.source.${item.source}`)}
                  </span>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {item.problem ?? item.stages.map((stage) => stage.name).join(' → ')}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {list?.loading && items.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('workflow.loading')}</p>
        )}
        {list?.error && (
          <p role="alert" className="px-2 py-1.5 text-xs text-danger">
            {t('workflow.failed', { error: list.error })}
          </p>
        )}
        {list?.value && items.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('workflow.none')}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Where the agent and model pickers stand while a workflow is chosen: tiers pick them. */
export function ByTierChip() {
  const { t } = useTranslation('tasks')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="ui-as-tray-link kettu-tray-link--agent text-muted-foreground"
            data-static=""
          />
        }
      >
        <span className="kettu-tray-link__text">{t('workflow.byTier')}</span>
      </TooltipTrigger>
      <TooltipContent>{t('workflow.byTierTooltip')}</TooltipContent>
    </Tooltip>
  )
}
