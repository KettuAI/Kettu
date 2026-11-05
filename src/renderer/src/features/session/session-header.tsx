import { useRef, useState } from 'react'
import { BotIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { backTo } from '@renderer/app/history'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { usePane } from '@renderer/features/split/pane-context'
import { usePaneDragSource } from '@renderer/features/split/session-drag-model'
import { SessionGitChips } from '@renderer/features/git/git-status'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { HostChip } from './host-chip'
import { PlanChip } from './plan-chip'
import { ViewersChip } from './viewers-chip'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { SessionTitleField } from '@renderer/features/sidebar/session-menu'
import { useRenaming } from '@renderer/features/sidebar/use-renaming'
import { agentName } from '@renderer/stores/agents'
import { cn } from '@renderer/lib/utils'
import { useRoutinesStore } from '@renderer/stores/routines'
import {
  hostOfSession,
  sessionArchived,
  sessionTitle,
  useSessionsStore,
} from '@renderer/stores/sessions'
import { openRoutine, openSession } from '@renderer/stores/view'

/** A sub-session's parent at the start of the top bar, then a slash: back to the parent. */
export function ParentLink({ parent }: { parent: SessionSummary }) {
  const { t } = useTranslation('session')
  const title = sessionTitle(parent)
  const label = t('subSession.back', { title })
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="compact"
              aria-label={label}
              className="h-6.5 min-w-16 shrink-1000 gap-1.5 pr-2 pl-1 font-normal text-tertiary"
              onClick={() =>
                backTo({ kind: 'session', sessionId: parent.id }, () =>
                  openSession(parent.id, parent.projectPath),
                )
              }
            />
          }
        >
          <ChevronLeftIcon aria-hidden strokeWidth={1.6} className="size-[13px]" />
          {parent.origin === 'subagent' ? (
            <BotIcon aria-hidden className="size-3.5" />
          ) : (
            <AgentMark agent={parent.agentId} size={14} hostId={hostOfSession(parent)} />
          )}
          <span className="max-w-24 truncate">{title}</span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <span aria-hidden className="mx-1.5 shrink-0 text-ui text-border-strong">
        /
      </span>
    </>
  )
}

/**
 * The session's top bar: its title, which a click renames and which drags its pane, its menu, who
 * else has it in front, the project's git status and the agent's plan.
 */
export function SessionHeader({
  summary,
  session,
}: {
  summary: SessionSummary
  session: SessionView | undefined
}) {
  const { t: ts } = useTranslation('session')
  const parent = useSessionsStore((s) => (summary.parentId ? s.byId[summary.parentId] : undefined))
  const routine = useRoutinesStore((s) =>
    summary.routine ? s.byId[summary.routine.routineId] : undefined,
  )
  const titleButtonRef = useRef<HTMLButtonElement>(null)
  const rename = useRenaming(() => titleButtonRef.current)
  // The field starts at the button's width, so a short title does not jump wider.
  const [titleWidth, setTitleWidth] = useState(0)
  const measureTitle = () => setTitleWidth(titleButtonRef.current?.offsetWidth ?? 0)
  const title = sessionTitle(summary)
  const pane = usePane()
  const archived = useSessionsStore((s) => sessionArchived(s.byId, summary.id))

  return (
    <TopBar cornered={pane?.cornered}>
      {/* The title gives way before the git chips (see SessionGitChips). What is left once the
          title reaches its least width is cut at the group's edge, not under the tools. Only the
          sides are cut, so the rename field's ring is not clipped above and below. */}
      <NoDrag className="min-w-0 gap-0.5 overflow-x-clip">
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
        <span className="grid w-4 shrink-0 place-items-center">
          {summary.origin === 'subagent' ? (
            <BotIcon className="size-4 text-secondary" />
          ) : (
            <AgentMark agent={summary.agentId} size={16} hostId={hostOfSession(summary)} />
          )}
        </span>
        <HostChip projectPath={summary.projectPath} />
        {rename.renaming ? (
          <SessionTitleField
            summary={summary}
            onDone={rename.finish}
            // The ring's outer edge is the button's box (30 px tall, text 4 px in, 6 px radius), so
            // the hover fill and the ring match and the text does not move.
            style={{ minWidth: Math.max(titleWidth - 5, 0) }}
            className="mx-[5.5px] field-sizing-content h-[25px] rounded-sm bg-transparent px-[1.5px] py-0 font-sans text-subheading font-semibold outline-[1.5px] outline-offset-1 outline-edit-ring outline-solid selection:bg-edit-selection aria-invalid:outline-danger"
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
        <ViewersChip sessionId={summary.id} projectPath={summary.projectPath} />
      </NoDrag>
      <SessionGitChips projectPath={summary.projectPath} />
      <span className="flex-1" />
      {session && !archived && summary.origin !== 'subagent' && (
        <PlanChip sessionId={summary.id} status={session.status} />
      )}
      <HeaderTools
        projectPath={summary.projectPath}
        panel={summary.id}
        summary={summary}
        session={session}
        onRename={() => {
          measureTitle()
          rename.menu.onRename()
        }}
        onNewSubSession={rename.menu.onLeave}
        menu={rename.menu}
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
        'mx-[3px] h-7.5 min-w-16 shrink-10 rounded-md px-[3px] font-sans text-subheading font-semibold text-foreground focus-visible:outline-[1.5px] focus-visible:-outline-offset-[1.5px] focus-visible:outline-edit-ring focus-visible:outline-solid active:not-aria-[haspopup]:translate-y-0',
        !focused && 'text-secondary hover:text-primary',
      )}
      onClick={onRename}
    >
      <span className="truncate">{title}</span>
    </Button>
  )
}
