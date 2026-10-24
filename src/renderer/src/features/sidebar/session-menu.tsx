import { useRef, useState } from 'react'
import {
  ArchiveIcon,
  CircleDotIcon,
  CircleIcon,
  FolderIcon,
  GitForkIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCwIcon,
  SquareIcon,
  TrashIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import {
  archiveSession,
  deleteSession,
  descendantCount,
  forkSession,
  markSessionUnread,
  pinSession,
  renameSession,
} from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { PrIcon } from '@renderer/features/git/pr-icon'
import { errorMessage, host } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { sessionTitle } from '@renderer/stores/sessions'
import { openNewSubSession, useViewStore } from '@renderer/stores/view'
import { ACCELERATORS, sessionMenuGroups, type SessionMenuItem } from './session-menu-model'

/**
 * A session's actions. A context menu is a Base UI menu, so the same items serve the row's
 * context menu, its More button and the top bar's title menu; each passes
 * `runSessionMenuAccelerator` as its popup's `onKeyDown`.
 */
export function SessionMenuItems({
  summary,
  onRename,
  onNewSubSession,
  onDelete,
}: {
  summary: SessionSummary
  onRename: () => void
  /** New session opens for a sub-session, and its composer takes the focus from the menu. */
  onNewSubSession: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const canFork = useAgentsStore((s) => !!s.byId[summary.agentId]?.capabilities?.forkSession)
  const inFront = useViewStore(
    (s) => s.main.kind === 'session' && s.main.sessionId === summary.id && !s.settings.open,
  )
  const unread = summary.attention === 'unread'
  const { id } = summary

  const item = (name: SessionMenuItem) => {
    const accelerator = ACCELERATORS[name]
    const shortcut = accelerator && <DropdownMenuShortcut>{accelerator}</DropdownMenuShortcut>
    const props = { key: name, 'data-accelerator': accelerator }
    switch (name) {
      case 'stop':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() => void host('sessions.cancel', { sessionId: id })}
          >
            <SquareIcon className="fill-current" />
            {t('row.stop')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'retry':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() => void host('sessions.retry', { sessionId: id })}
          >
            <RotateCwIcon />
            {t('row.retry')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'pin':
        return (
          <DropdownMenuItem {...props} onClick={() => void pinSession(id, !summary.pinnedAt)}>
            {summary.pinnedAt ? <PinOffIcon /> : <PinIcon />}
            {summary.pinnedAt ? t('row.unpin') : t('row.pin')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'unread':
        return (
          <DropdownMenuItem
            {...props}
            disabled={inFront}
            onClick={() => void markSessionUnread(id, !unread)}
          >
            {unread ? <CircleIcon /> : <CircleDotIcon />}
            {unread ? t('row.markRead') : t('row.markUnread')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'rename':
        return (
          <DropdownMenuItem {...props} onClick={onRename}>
            <PencilIcon />
            {t('row.rename')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'fork':
        return (
          <DropdownMenuItem {...props} onClick={() => void forkSession(id)}>
            <GitForkIcon />
            {t('row.fork')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'newSubSession':
        return (
          <DropdownMenuSub key={name}>
            <DropdownMenuSubTrigger>
              <PlusIcon />
              {t('row.newSubSession')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {agents.map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  disabled={!isInstalled(agent)}
                  onClick={() => {
                    onNewSubSession()
                    openNewSubSession(summary, agent.id)
                  }}
                >
                  <AgentMark agent={agent.id} size={14} mono={!isInstalled(agent)} />
                  {agent.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      case 'pullRequest':
        return (
          summary.pr && (
            <DropdownMenuItem
              {...props}
              render={<a href={summary.pr.url} target="_blank" rel="noreferrer" />}
            >
              <PrIcon state={summary.pr.state} />
              {t('row.openPullRequest', { number: summary.pr.number })}
              {shortcut}
            </DropdownMenuItem>
          )
        )
      case 'showInFolder':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() => void window.overbench.shell.showItem(summary.projectPath)}
          >
            <FolderIcon />
            {t('row.showIn', { name: fileManagerName() })}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'archive':
        return (
          <DropdownMenuItem {...props} onClick={() => void archiveSession(id)}>
            <ArchiveIcon />
            {t('row.archive')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'delete':
        return (
          <DropdownMenuItem {...props} variant="destructive" onClick={onDelete}>
            <TrashIcon />
            {t('row.deleteMenu')}
            {shortcut}
          </DropdownMenuItem>
        )
    }
  }

  return sessionMenuGroups(summary, canFork).map((group, index) => (
    <DropdownMenuGroup key={group[0]}>
      {index > 0 && <DropdownMenuSeparator />}
      {group.map(item)}
    </DropdownMenuGroup>
  ))
}

/**
 * The session's title as a text field. Enter or a blur saves, Esc cancels, and an empty title
 * returns to the agent's. The field stays until the host has the new title, so the old one never
 * flashes back.
 */
export function SessionTitleField({
  summary,
  onDone,
  className,
}: {
  summary: SessionSummary
  onDone: (restoreFocus: boolean) => void
  className?: string
}) {
  const { t } = useTranslation('sidebar')
  const current = sessionTitle(summary)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  // Enter, Esc and the blur that follows can all land on one edit; only the first counts.
  const settled = useRef(false)

  const finish = async (value: string | null, restoreFocus: boolean) => {
    if (settled.current) return
    settled.current = true
    const title = value?.trim() ?? null
    if (title === null || title === current) return onDone(restoreFocus)
    try {
      await renameSession(summary.id, title || null)
      onDone(restoreFocus)
    } catch (err) {
      settled.current = false
      setError(errorMessage(err))
      field.current?.focus()
    }
  }

  return (
    <input
      ref={field}
      autoFocus
      aria-label={t('row.renameTitle')}
      aria-invalid={error !== null}
      title={error ?? undefined}
      defaultValue={current}
      maxLength={200}
      autoComplete="off"
      spellCheck={false}
      className={cn('min-w-0 outline-none', className)}
      onFocus={(event) => event.currentTarget.select()}
      onChange={() => setError(null)}
      // Leaving a field that failed to save gives up instead of trying again.
      onBlur={(event) => void finish(error ? null : event.currentTarget.value, false)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') {
          event.preventDefault()
          void finish(event.currentTarget.value, true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          void finish(null, true)
        }
      }}
    />
  )
}

export function DeleteSessionDialog({
  sessionId,
  title,
  open,
  onOpenChange,
}: {
  sessionId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const count = open ? descendantCount(sessionId) : 0
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('row.deleteTitle', { title })}</AlertDialogTitle>
          <AlertDialogDescription>
            {count > 0 ? t('row.deleteBodyWithSub', { count }) : t('row.deleteBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void deleteSession(sessionId)}>
            {t('row.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
