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
import { CacheChip } from '@renderer/features/prompt-cache/cache-chip'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import {
  DeleteSessionDialog,
  SessionMenuItems,
  SessionTitleField,
} from '@renderer/features/sidebar/session-menu'
import { useRenaming } from '@renderer/features/sidebar/use-renaming'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'

/** A sub-session's parent at the start of the top bar, which opens it. */
export function ParentLink({ parent, className }: { parent: SessionSummary; className?: string }) {
  return (
    <>
      <Button
        variant="quiet"
        size="compact"
        className={cn('min-w-0 max-w-[30%] shrink px-1.5', className)}
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
  const parent = useSessionsStore((s) => (summary.parentId ? s.byId[summary.parentId] : undefined))
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
        {parent && <ParentLink parent={parent} />}
        {summary.origin === 'subagent' ? (
          <BotIcon className="ml-1.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <AgentMark agent={summary.agentId} size={14} className="ml-1.5 shrink-0" />
        )}
        {rename.renaming ? (
          // Sits where the button's text was, so the title does not move.
          <SessionTitleField
            summary={summary}
            onDone={rename.finish}
            style={{ minWidth: titleWidth }}
            className="field-sizing-content h-control rounded-lg border border-strong bg-background px-1.5 text-control font-medium aria-invalid:border-destructive dark:bg-input/30 dark:aria-invalid:border-destructive/50"
          />
        ) : (
          <Button
            ref={titleButton}
            variant="ghost"
            size="compact"
            title={`${title} · ${agentName(summary.agentId)}`}
            className="min-w-0 shrink px-1.5"
            onClick={() => {
              measureTitle()
              rename.start()
            }}
          >
            <span className="truncate">{title}</span>
          </Button>
        )}
        <DropdownMenu onOpenChangeComplete={rename.menu.onOpenChangeComplete}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={t('row.more')}
                className="text-muted-foreground"
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent finalFocus={rename.menu.finalFocus}>
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
