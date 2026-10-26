import { useRef, useState } from 'react'
import { BotIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CacheChip } from '@renderer/features/prompt-cache/cache-chip'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import {
  DeleteSessionDialog,
  SessionMenuItems,
  SessionTitleField,
} from '@renderer/features/sidebar/session-menu'
import { runSessionMenuAccelerator } from '@renderer/features/sidebar/session-menu-model'
import { useRenaming } from '@renderer/features/sidebar/use-renaming'
import { agentName } from '@renderer/stores/agents'
import { useRoutinesStore } from '@renderer/stores/routines'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openRoutine, openSession } from '@renderer/stores/view'

/** A sub-session's parent at the start of the top bar, which opens it. */
export function ParentLink({ parent }: { parent: SessionSummary }) {
  return (
    <>
      <Button
        variant="quiet"
        size="compact"
        className="min-w-16 shrink-100 px-1.5"
        onClick={() => openSession(parent.id, parent.projectPath)}
      >
        <span className="truncate">{sessionTitle(parent)}</span>
      </Button>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
    </>
  )
}

/**
 * The session's top bar: its title, which a click renames, its menu, the prompt cache's time left,
 * and the project's git status.
 */
export function SessionHeader({
  summary,
  session,
}: {
  summary: SessionSummary
  session: SessionView | undefined
}) {
  const { t } = useTranslation('sidebar')
  const { t: ts } = useTranslation('session')
  const parent = useSessionsStore((s) => (summary.parentId ? s.byId[summary.parentId] : undefined))
  const routine = useRoutinesStore((s) =>
    summary.routine ? s.byId[summary.routine.routineId] : undefined,
  )
  const [deleting, setDeleting] = useState(false)
  const titleButton = useRef<HTMLButtonElement>(null)
  const rename = useRenaming(() => titleButton.current)
  // The field starts at the button's width, so a short title does not jump wider.
  const [titleWidth, setTitleWidth] = useState(0)
  const measureTitle = () => setTitleWidth(titleButton.current?.offsetWidth ?? 0)
  const title = sessionTitle(summary)

  return (
    <TopBar>
      {/* The title gives way last: the git status shrinks first (see HeaderTools). */}
      <NoDrag className="min-w-0 gap-0.5">
        {routine && summary.routine && (
          <>
            <Button
              variant="quiet"
              size="compact"
              className="min-w-16 shrink-100 px-1.5"
              aria-label={ts('routine.link', { name: routine.name })}
              onClick={() => openRoutine(summary.routine!.routineId)}
            >
              <span className="truncate">{routine.name}</span>
            </Button>
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
          </>
        )}
        {parent && <ParentLink parent={parent} />}
        {summary.origin === 'subagent' ? (
          <BotIcon className="ml-1.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <AgentMark agent={summary.agentId} size={14} className="ml-1.5 shrink-0" />
        )}
        {rename.renaming ? (
          <SessionTitleField
            summary={summary}
            onDone={rename.finish}
            // The ring's outer edge is the button's box (30 px tall, text 4 px in, 6 px radius), so
            // the hover fill and the ring match and the text does not move.
            style={{ minWidth: Math.max(titleWidth - 5, 0) }}
            className="mx-[5.5px] field-sizing-content h-[25px] rounded-sm bg-transparent px-[1.5px] py-0 font-heading text-subheading font-semibold outline-[1.5px] outline-offset-1 outline-edit-ring outline-solid selection:bg-edit-selection aria-invalid:outline-danger"
          />
        ) : (
          <Button
            ref={titleButton}
            variant="ghost"
            title={`${title} · ${agentName(summary.agentId)}`}
            className="mx-[3px] h-7.5 min-w-0 shrink rounded-md px-[3px] font-heading text-subheading font-semibold focus-visible:outline-[1.5px] focus-visible:-outline-offset-[1.5px] focus-visible:outline-edit-ring focus-visible:outline-solid active:not-aria-[haspopup]:translate-y-0"
            onClick={() => {
              measureTitle()
              rename.start()
            }}
          >
            <span className="truncate">{title}</span>
          </Button>
        )}
        <DropdownMenu onOpenChangeComplete={rename.menu.onOpenChangeComplete}>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-compact"
                      aria-label={t('row.more')}
                      className="text-muted-foreground"
                    />
                  }
                />
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{t('row.more')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            finalFocus={rename.menu.finalFocus}
            onKeyDown={runSessionMenuAccelerator}
          >
            <SessionMenuItems
              summary={summary}
              onRename={() => {
                measureTitle()
                rename.menu.onRename()
              }}
              onNewSubSession={rename.menu.onLeave}
              onDelete={() => setDeleting(true)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        {session && <CacheChip session={session} />}
      </NoDrag>
      <span className="flex-1" />
      <HeaderTools projectPath={summary.projectPath} />
      <DeleteSessionDialog
        sessionId={summary.id}
        title={title}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </TopBar>
  )
}
