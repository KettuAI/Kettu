import { type CSSProperties, useRef, useState } from 'react'
import {
  ArchiveIcon,
  CircleDotIcon,
  CircleIcon,
  Columns2Icon,
  FolderIcon,
  PanelBottomIcon,
  PanelRightIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCwIcon,
  SplitIcon,
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
  unarchiveSession,
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
import { toast } from '@renderer/components/ui/toast'
import { PrIcon } from '@renderer/features/git/pr-icon'
import { errorMessage, host } from '@renderer/lib/host'
import { fileManagerName, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { sessionTitle } from '@renderer/stores/sessions'
import {
  allPanes,
  canSplit,
  focusedPane,
  paneWithSession,
  type SplitReason,
} from '@renderer/features/split/layout'
import { splitSize } from '@renderer/features/split/session-drag-model'
import { openInSplit, openNewSubSession, useViewStore } from '@renderer/stores/view'
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
    (s) =>
      !s.settings.open &&
      allPanes(s.layout).some(
        (pane) =>
          s.visiblePanes.includes(pane.id) &&
          pane.view.kind === 'session' &&
          pane.view.sessionId === summary.id,
      ),
  )
  // A session a pane shows already, in view or folded, has no Open in split view.
  const inSplit = useViewStore((s) => !!paneWithSession(s.layout, summary.id))
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
            <SplitIcon />
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
      case 'openInSplit':
        return <OpenInSplit summary={summary} key={name} />
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
        if (isWeb) return null
        return (
          <DropdownMenuItem
            {...props}
            onClick={() => void window.kettu.shell.showItem(summary.projectPath)}
          >
            <FolderIcon />
            {t('row.showIn', { name: fileManagerName() })}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'archive':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() =>
              void archiveSession(id).then(() =>
                toast(t('row.archived', { title: sessionTitle(summary) }), {
                  label: t('row.undo'),
                  onClick: () => void unarchiveSession(id),
                }),
              )
            }
          >
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

  return sessionMenuGroups(summary, canFork, inSplit).map((group, index) => (
    <DropdownMenuGroup key={group[0]}>
      {index > 0 && <DropdownMenuSeparator />}
      {group.map(item)}
    </DropdownMenuGroup>
  ))
}

/**
 * **Open in split view** with its two sides, each disabled, saying why, when the split cannot take
 * that side: a third column, a fourth pane, or no room in the window.
 */
function OpenInSplit({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation('sidebar')
  const layout = useViewStore((s) => s.layout)
  const size = splitSize()
  const beside = size ? canSplit(layout, focusedPane(layout).id, 'right', size) : null
  const below = size ? canSplit(layout, focusedPane(layout).id, 'bottom', size) : null
  const open = (side: 'right' | 'bottom') => {
    if (!size) return
    openInSplit(
      { kind: 'session', sessionId: summary.id, projectPath: summary.projectPath },
      side,
      size,
    )
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Columns2Icon />
        {t('row.openInSplit')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <OpenInSplitItem
          side="right"
          label={t('row.splitRight')}
          reason={beside?.ok ? null : (beside?.reason ?? 'room')}
          onClick={() => open('right')}
        />
        <OpenInSplitItem
          side="below"
          label={t('row.splitBelow')}
          reason={below?.ok ? null : (below?.reason ?? 'room')}
          onClick={() => open('bottom')}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function OpenInSplitItem({
  side,
  label,
  reason,
  onClick,
}: {
  side: 'right' | 'below'
  label: string
  /** Why the split cannot take that side; null when it can. */
  reason: SplitReason | null
  onClick: () => void
}) {
  const { t } = useTranslation('sidebar')
  return (
    <DropdownMenuItem disabled={reason !== null} onClick={onClick}>
      {side === 'right' ? <PanelRightIcon /> : <PanelBottomIcon />}
      {label}
      {reason && (
        <span className="ml-auto pl-3 text-xs text-tertiary">{t(`row.noRoom.${reason}`)}</span>
      )}
    </DropdownMenuItem>
  )
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
  style,
}: {
  summary: SessionSummary
  onDone: (restoreFocus: boolean) => void
  className?: string
  style?: CSSProperties
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
      style={style}
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
  onDeleted,
}: {
  sessionId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
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
          <AlertDialogAction
            variant="destructive"
            onClick={() => void deleteSession(sessionId).then(onDeleted)}
          >
            {t('row.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
