import { WorkflowSquare03Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SopSummary } from '@shared/tasks'
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
import { hostOfPath } from '@renderer/lib/host-paths'
import { hostKey, useTasksStore } from '@renderer/stores/tasks'
import { sopKey, sopOrigin, sopUsable } from './model'

const JUST_CHAT = ''

/**
 * New session's SOP: Just chat, a plain session, or one of the host's SOPs, which makes the send
 * create a task. A task needs a project, so without one there is no choice. One the person has
 * not approved, or that did not read, is listed but cannot be chosen.
 */
export function SopMenu({
  projectPath,
  sop,
  onChoose,
}: {
  /** The project chosen, null for none or No project. */
  projectPath: string | null
  sop: SopSummary | null
  onChoose: (sop: SopSummary | null) => void
}) {
  const { t } = useTranslation('tasks')
  const hostId = projectPath ? hostOfPath(projectPath) : null
  const list = useTasksStore((s) => (projectPath ? s.sops[hostKey(hostId)] : undefined))
  const label = sop?.name ?? t('sop.justChat')

  if (!projectPath) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-disabled
              aria-label={t('sop.label')}
              className="ui-as-tray-link kettu-tray-link--agent opacity-50"
              data-static=""
            />
          }
        >
          <Glyph icon={WorkflowSquare03Icon} size={13} className="shrink-0" />
          <span className="kettu-tray-link__text">{label}</span>
        </TooltipTrigger>
        <TooltipContent>{t('sop.needsProject')}</TooltipContent>
      </Tooltip>
    )
  }

  const items = list?.value ?? []
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void useTasksStore.getState().loadSops(hostId)
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('sop.label')}
            title={t('sop.label')}
            className="ui-as-tray-link kettu-tray-link--agent"
          />
        }
      >
        <Glyph icon={WorkflowSquare03Icon} size={13} className="shrink-0" />
        <span className="kettu-tray-link__text">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-80">
        <DropdownMenuRadioGroup
          value={sop ? sopKey(sop) : JUST_CHAT}
          onValueChange={(value) => {
            const chosen = items.find((item) => sopKey(item) === value)
            onChoose(chosen && sopUsable(chosen) ? chosen : null)
          }}
        >
          {/* A radio item keeps its menu open unless told to close it. */}
          <DropdownMenuRadioItem value={JUST_CHAT} closeOnClick>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{t('sop.justChat')}</span>
              <span className="truncate text-xs text-muted-foreground">
                {t('sop.justChatNote')}
              </span>
            </span>
          </DropdownMenuRadioItem>
          {(items.length > 0 || list?.loading || list?.error) && <DropdownMenuSeparator />}
          {items.map((item) => {
            const why = item.problem ?? (item.status === 'pending' ? t('sop.pending') : null)
            return (
              <DropdownMenuRadioItem
                key={sopKey(item)}
                value={sopKey(item)}
                closeOnClick
                disabled={!sopUsable(item)}
                // The reason shows on hover, which a disabled item otherwise takes no part in.
                className="data-disabled:pointer-events-auto"
                title={why ?? item.description}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate">{item.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t(`sop.origin.${sopOrigin(item)}`)}
                    </span>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {why ?? item.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
        {list?.loading && items.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('sop.loading')}</p>
        )}
        {list?.error && (
          <p role="alert" className="px-2 py-1.5 text-xs text-danger">
            {t('sop.failed', { error: list.error })}
          </p>
        )}
        {list?.value && items.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('sop.none')}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Where the agent and model pickers stand while an SOP is chosen: tiers pick them. */
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
        <span className="kettu-tray-link__text">{t('sop.byTier')}</span>
      </TooltipTrigger>
      <TooltipContent>{t('sop.byTierTooltip')}</TooltipContent>
    </Tooltip>
  )
}
