import { useRef, useState } from 'react'
import { BotIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { usePane } from '@renderer/features/split/pane-context'
import { usePaneDragSource } from '@renderer/features/split/session-drag-model'
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
import { cn } from '@renderer/lib/utils'
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
        className="min-w-16 shrink-1000 px-1.5"
        onClick={() => openSession(parent.id, parent.projectPath)}
      >
        <span className="truncate">{sessionTitle(parent)}</span>
      </Button>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
    </>
  )
}

/**
 * The session's top bar: its title, which a click renames and which drags its pane, its menu, the
 * prompt cache's time left, and the project's git status.
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
  const titleButtonRef = useRef<HTMLButtonElement>(null)
  const rename = useRenaming(() => titleButtonRef.current)
  // The field starts at the button's width, so a short title does not jump wider.
  const [titleWidth, setTitleWidth] = useState(0)
  const measureTitle = () => setTitleWidth(titleButtonRef.current?.offsetWidth ?? 0)
  const title = sessionTitle(summary)
  const pane = usePane()

  return (
    <TopBar cornered={pane?.cornered}>
      {/* The title gives way last: the git status shrinks first (see HeaderTools). What is left
          once the title reaches its least width is cut at the group's edge, not under the tools. */}
      <NoDrag className="min-w-0 gap-0.5 overflow-clip">
        {routine && summary.routine && (
          <>
            <Button
              variant="quiet"
              size="compact"
              className="min-w-16 shrink-1000 px-1.5"
              aria-label={ts('routine.link', { name: routine.name })}
              onClick={() => openRoutine(summary.routine!.routineId)}
            >
              <span className="truncate">{routine.name}</span>
            </Button>
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
          </>
        )}
        {parent && <ParentLink parent={parent} />}
        <span className="mr-[3px] grid w-4 shrink-0 place-items-center">
          {summary.origin === 'subagent' ? (
            <BotIcon className="size-3.5 text-secondary" />
          ) : (
            <AgentMark agent={summary.agentId} size={14} />
          )}
        </span>
        {rename.renaming ? (
          <SessionTitleField
            summary={summary}
            onDone={rename.finish}
            // The ring's outer edge is the button's box (30 px tall, text 4 px in, 6 px radius), so
            // the hover fill and the ring match and the text does not move.
            style={{ minWidth: Math.max(titleWidth - 5, 0) }}
            className="mx-[5.5px] field-sizing-content h-[25px] rounded-sm bg-transparent px-[1.5px] py-0 font-heading text-ui font-medium outline-[1.5px] outline-offset-1 outline-edit-ring outline-solid selection:bg-edit-selection aria-invalid:outline-danger"
          />
        ) : (
          <TitleButton
            buttonRef={titleButtonRef}
            paneId={pane?.paneId ?? null}
            sessionId={summary.id}
            title={title}
            description={agentName(summary.agentId)}
            focused={pane?.focused ?? true}
            onRename={() => {
              measureTitle()
              rename.start()
            }}
          />
        )}
        <DropdownMenu onOpenChangeComplete={rename.menu.onOpenChangeComplete}>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('row.more')}
                      className="-ml-0.5 text-secondary"
                    />
                  }
                />
              }
            >
              <ChevronDownIcon />
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

/**
 * The title: a click renames it, and a press drags its pane to another place. Out of focus its text
 * is `--text-secondary`, `--text-primary` under the pointer.
 */
function TitleButton({
  buttonRef,
  paneId,
  sessionId,
  title,
  description,
  focused,
  onRename,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  paneId: string | null
  sessionId: string
  title: string
  description: string
  focused: boolean
  onRename: () => void
}) {
  const drag = usePaneDragSource(paneId ?? '', sessionId, !paneId)
  return (
    <Button
      ref={(element) => {
        buttonRef.current = element
        drag.ref(element)
      }}
      variant="ghost"
      title={`${title} · ${description}`}
      className={cn(
        'mx-[3px] h-7.5 min-w-16 shrink-10 rounded-md px-[3px] font-heading text-ui font-medium focus-visible:outline-[1.5px] focus-visible:-outline-offset-[1.5px] focus-visible:outline-edit-ring focus-visible:outline-solid active:not-aria-[haspopup]:translate-y-0',
        !focused && 'text-secondary hover:text-primary',
      )}
      onClick={onRename}
    >
      <span className="truncate">{title}</span>
    </Button>
  )
}
