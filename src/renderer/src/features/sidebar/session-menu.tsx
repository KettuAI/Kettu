import { type CSSProperties, useEffect, useRef, useState } from 'react'
import {
  Archive01Icon,
  ArrowMoveDownRightIcon,
  CodeIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  Delete02Icon,
  FolderOpenIcon,
  GitBranchIcon,
  Layout2ColumnIcon,
  LinkSquare02Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  RefreshIcon,
  SidebarBottomIcon,
  SidebarRightIcon,
  SlidersHorizontalIcon,
  StopCircleIcon,
  Tick02Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { EditorList } from '@shared/editors'
import type { SessionView } from '@shared/thread'
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
import { ForkIcon } from '@renderer/components/fork-icon'
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
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { PrIcon } from '@renderer/features/git/pr-icon'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { basename, tokens } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { fileManagerName, formatShortcut, isMac, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentsOn, isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useGitStore } from '@renderer/stores/git'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { clearSelection } from '@renderer/stores/session-selection'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import {
  allPanes,
  canSplit,
  focusedPane,
  paneWithSession,
  type SplitReason,
} from '@renderer/features/split/layout'
import { splitSize } from '@renderer/features/split/session-drag-model'
import {
  openInSplit,
  openNewSubSession,
  openSession,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'
import {
  ACCELERATORS,
  canDeleteAtOnce,
  isRunning,
  MULTI_ACCELERATORS,
  multiSessionMenuGroups,
  QUICK_DELETE,
  resumeCommand,
  runSessionMenuAccelerator,
  sessionMenuGroups,
  settle,
  SPLIT_ACCELERATORS,
  type SessionMenuItem,
  type SessionMenuPlace,
} from './session-menu-model'
import { confirmArchive } from './archive-confirm-model'
import { dissolveRows } from './row-dust'
import { markReturning } from './row-exit'
import { sessionPullRequests } from './session-prs'

/** An accelerator as the menu shows it: macOS's symbols, or the key names elsewhere. */
function shortcutLabel(shortcut: string): string {
  if (shortcut === 'Backspace') return isMac ? '⌫' : 'Backspace'
  return formatShortcut(shortcut)
}

/** Whether a session in a pane in view shows the given session, which keeps it read. */
function useInFront(sessionId: string): boolean {
  return useViewStore(
    (s) =>
      !s.settings.open &&
      allPanes(s.layout).some(
        (pane) =>
          s.visiblePanes.includes(pane.id) &&
          pane.view.kind === 'session' &&
          pane.view.sessionId === sessionId,
      ),
  )
}

/**
 * Archives with a toast that undoes it for six seconds, once confirmed when their terminals run a
 * command. Undo takes back the ones that archived; the toast names the failure when some did not,
 * since a second toast would replace it.
 */
function archiveWithUndo(ids: readonly string[], title: string): void {
  void confirmArchive(ids).then((archive) => {
    if (archive) archiveNow(ids, title)
  })
}

function archiveNow(ids: readonly string[], title: string): void {
  void settle(ids, archiveSession).then(({ done, errors }) => {
    const failure = errors.length > 0 ? errorMessage(errors[0]) : null
    if (done.length === 0) {
      if (failure) toast(failure)
      return
    }
    const archived = failure
      ? i18n.t('sidebar:row.archivedSome', { done: done.length, total: ids.length, error: failure })
      : title
    toast(
      archived,
      {
        label: i18n.t('sidebar:row.undo'),
        onClick: () => {
          markReturning(done)
          void settle(done, unarchiveSession).then(({ errors: failed }) => {
            if (failed.length > 0) toast(errorMessage(failed[0]))
          })
        },
      },
      { icon: Archive01Icon },
    )
  })
}

/** Copies the text and says so in a toast. */
function copyWithToast(text: string, done: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast(done),
    (error: unknown) => toast(errorMessage(error)),
  )
}

/**
 * A session's actions. A context menu is a Base UI menu, so the same items serve the row's context
 * menu and the top bar's More menu (`place`); each passes `runSessionMenuAccelerator` as its
 * popup's `onKeyDown`.
 */
export function SessionMenuItems({
  summary,
  place = 'row',
  onRename,
  onNewSubSession,
  onDelete,
}: {
  summary: SessionSummary
  place?: SessionMenuPlace
  /** Left out where nothing renames the session, which leaves Rename out of the menu. */
  onRename?: () => void
  /** New session opens for a sub-session, and its composer takes the focus from the menu. */
  onNewSubSession: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  // The agents of the session's host that can run one now; More options opens New session with
  // every agent.
  const hostId = hostOfSession(summary)
  const agents = useAgentsStore(
    useShallow((s) => {
      const { order, byId } = agentsOn(s, hostId)
      return usableAgents(order, byId).filter((a) => isInstalled(a) && !a.hidden && !a.disabled)
    }),
  )
  const canFork = useAgentsStore(
    (s) => !!agentsOn(s, hostId).byId[summary.agentId]?.capabilities?.forkSession,
  )
  const inFront = useInFront(summary.id)
  // A session a pane shows already, in view or folded, has no Open in split view.
  const inSplit = useViewStore((s) => !!paneWithSession(s.layout, summary.id))
  const terminal = useTerminalAllowed(summary.projectPath)
  const unread = summary.attention === 'unread'
  const running = isRunning(summary)
  // Only this computer's folders open in its file manager and its editors.
  const local = !isWeb && hostOfPath(summary.projectPath) === null
  const resume = resumeCommand(summary, hostPath(summary.projectPath))
  const { id } = summary

  const item = (name: SessionMenuItem) => {
    const accelerator = ACCELERATORS[name]
    const shortcut = accelerator && (
      <DropdownMenuShortcut>{shortcutLabel(accelerator)}</DropdownMenuShortcut>
    )
    const props = { key: name, 'data-accelerator': accelerator }
    switch (name) {
      case 'stop':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() => void host('sessions.cancel', { sessionId: id })}
          >
            <MenuGlyph icon={StopCircleIcon} />
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
            <MenuGlyph icon={RefreshIcon} />
            {t('row.retry')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'open':
        return (
          <DropdownMenuItem
            {...props}
            disabled={inFront}
            onClick={() => openSession(id, summary.projectPath)}
          >
            <MenuGlyph icon={LinkSquare02Icon} />
            {t('row.open')}
            {/* What opens it from its row; in the menu Enter runs the highlighted item. */}
            <DropdownMenuShortcut>{formatShortcut('Enter')}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )
      case 'pin':
        return (
          <DropdownMenuItem {...props} onClick={() => void pinSession(id, !summary.pinnedAt)}>
            {summary.pinnedAt ? <MenuGlyph icon={PinOffIcon} /> : <MenuGlyph icon={PinIcon} />}
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
            <MenuGlyph icon={ViewIcon} />
            {unread ? t('row.markRead') : t('row.markUnread')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'rename':
        return (
          <DropdownMenuItem {...props} onClick={onRename}>
            <MenuGlyph icon={PencilEdit02Icon} />
            {t('row.rename')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'fork':
        return (
          <DropdownMenuItem {...props} onClick={() => void forkSession(id)}>
            <ForkIcon />
            {place === 'more' ? t('row.forkFromHere') : t('row.fork')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'newSubSession':
        return (
          <DropdownMenuSub key={name}>
            <DropdownMenuSubTrigger>
              <MenuGlyph icon={ArrowMoveDownRightIcon} />
              {t('row.newSubSession')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-59">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('row.runItWith')}</DropdownMenuLabel>
                {agents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.id}
                    onClick={() => {
                      onNewSubSession()
                      openNewSubSession(summary, agent.id)
                    }}
                  >
                    <AgentMark agent={agent.id} size={15} hostId={hostId} />
                    <span className="min-w-0 flex-1 truncate">{agent.harnessName}</span>
                    {agent.name !== agent.harnessName && (
                      <span className="max-w-24 shrink-0 truncate pl-4 text-hint text-tertiary">
                        {agent.name}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  onNewSubSession()
                  openNewSubSession(summary, summary.agentId)
                }}
              >
                <MenuGlyph icon={SlidersHorizontalIcon} />
                {t('row.moreOptions')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      case 'openInSplit':
        return <OpenInSplit summary={summary} key={name} />
      case 'pullRequest': {
        const prs = sessionPullRequests(summary)
        if (prs.length === 1) {
          const pr = prs[0]!
          return (
            <DropdownMenuItem
              {...props}
              render={<a href={pr.url} target="_blank" rel="noreferrer" />}
            >
              <PrIcon state={pr.state} />
              {t('row.openPullRequest', { number: pr.number })}
              {shortcut}
            </DropdownMenuItem>
          )
        }
        return (
          prs.length > 1 && (
            <DropdownMenuSub key={name}>
              <DropdownMenuSubTrigger>
                <PrIcon state={null} />
                {t('row.pullRequests')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-80">
                {prs.map((pr) => (
                  <DropdownMenuItem
                    key={pr.url}
                    render={<a href={pr.url} target="_blank" rel="noreferrer" />}
                  >
                    <PrIcon state={pr.state} />
                    <span className="shrink-0 text-tertiary tabular-nums">
                      {pr.repo}#{pr.number}
                    </span>
                    <PrTitle url={pr.url} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        )
      }
      case 'openInEditor':
        return <OpenInEditor key={name} path={summary.projectPath} />
      case 'showInFolder':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() => void window.kettu.shell.showItem(summary.projectPath)}
          >
            <MenuGlyph icon={FolderOpenIcon} />
            {t('row.showIn', { name: fileManagerName() })}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'openTerminal':
        return (
          <DropdownMenuItem {...props} onClick={() => toggleTerminal(summary.id, true)}>
            <MenuGlyph icon={ComputerTerminal01Icon} />
            {t('row.openTerminal')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'copyResume':
        return (
          resume && (
            <DropdownMenuItem
              {...props}
              onClick={() => copyWithToast(resume, t('row.copiedResume'))}
            >
              {place === 'more' ? (
                <MenuGlyph icon={Copy01Icon} />
              ) : (
                <MenuGlyph icon={ComputerTerminal01Icon} />
              )}
              {t('row.copyResume')}
            </DropdownMenuItem>
          )
        )
      case 'copySessionId':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() =>
              copyWithToast(summary.acpSessionId ?? summary.id, t('row.copiedSessionId'))
            }
          >
            <MenuGlyph icon={Copy01Icon} />
            {t('row.copySessionId')}
          </DropdownMenuItem>
        )
      case 'showInParent':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() => {
              const parent = summary.parentId
                ? useSessionsStore.getState().byId[summary.parentId]
                : undefined
              if (parent) openSession(parent.id, parent.projectPath)
            }}
          >
            <MenuGlyph icon={ArrowMoveDownRightIcon} />
            {t('row.showInParent')}
          </DropdownMenuItem>
        )
      case 'archive':
        return (
          <DropdownMenuItem
            {...props}
            onClick={() =>
              archiveWithUndo([id], t('row.archived', { title: sessionTitle(summary) }))
            }
          >
            <MenuGlyph icon={Archive01Icon} />
            {t('row.archive')}
            {shortcut}
          </DropdownMenuItem>
        )
      case 'delete':
        return (
          <DropdownMenuItem
            {...props}
            data-quick-accelerator={QUICK_DELETE}
            variant="destructive"
            // A session cannot be removed mid-write; Stop comes first.
            disabled={running}
            // As drawn, a disabled Delete keeps its color and fades only its icon.
            className="data-disabled:opacity-100 data-disabled:[&>svg]:opacity-50"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey) void deleteUnlessAtStake([summary], onDelete)
              else onDelete()
            }}
          >
            <Glyph icon={Delete02Icon} size={15} />
            {t('row.deleteMenu')}
            {shortcut}
          </DropdownMenuItem>
        )
    }
  }

  const context = {
    canFork,
    shown: inSplit,
    place,
    local,
    terminal,
    resume: resume !== null,
    rename: onRename !== undefined,
  }
  return sessionMenuGroups(summary, context).map((group, index) => (
    <DropdownMenuGroup key={group[0]}>
      {index > 0 && <DropdownMenuSeparator />}
      {group.map(item)}
    </DropdownMenuGroup>
  ))
}

/**
 * The More menu's head: the agent that runs the session, its model and the tokens the session has
 * used, as far as the agent reports them.
 */
export function SessionMenuHeader({
  summary,
  session,
}: {
  summary: SessionSummary
  session: SessionView | undefined
}) {
  const { t } = useTranslation('sidebar')
  const hostId = hostOfSession(summary)
  const agent = useAgentsStore((s) => agentsOn(s, hostId).byId[summary.agentId])
  const harness = agent?.harnessName ?? agent?.name ?? ''
  const name =
    agent && agent.name !== agent.harnessName
      ? t('row.agentOf', { harness, agent: agent.name })
      : harness
  const model = modelName(session)
  const used = session?.usage?.tokens?.total
  const detail = [
    model,
    used !== undefined && used > 0 ? t('row.tokensUsed', { tokens: tokens(used) }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <div className="flex gap-2.5 px-2 pt-2 pb-2.5">
        <AgentMark agent={summary.agentId} size={28} hostId={hostId} />
        <div className="min-w-0">
          <div className="truncate text-ui font-semibold text-primary">{name}</div>
          {detail && <div className="mt-0.5 truncate text-meta text-tertiary">{detail}</div>}
        </div>
      </div>
      <DropdownMenuSeparator />
    </>
  )
}

function modelName(session: SessionView | undefined): string | null {
  const option = session?.config.find((o) => o.category === 'model' && o.type === 'select')
  if (!option) return null
  return option.choices?.find((choice) => choice.value === option.value)?.name ?? null
}

/**
 * **Open in editor**: the editors installed on this computer with their own icons, the last one
 * used checked and named on the item, and **Choose app…** for one Kettu does not know.
 */
function OpenInEditor({ path }: { path: string }) {
  const { t } = useTranslation('sidebar')
  const [list, setList] = useState<EditorList | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.kettu.editors.list().then(
      (next) => !cancelled && setList(next),
      (failure: unknown) => !cancelled && setError(errorMessage(failure)),
    )
    return () => {
      cancelled = true
    }
  }, [])

  const current = list?.editors.find((editor) => editor.id === list.last) ?? null
  const open = (editorId: string) =>
    void window.kettu.editors
      .open(editorId, path)
      .catch((failure: unknown) => toast(errorMessage(failure)))
  const choose = () =>
    void window.kettu.editors.choose(path).catch((failure: unknown) => toast(errorMessage(failure)))

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={CodeIcon} />
        <span className="min-w-0 flex-1 truncate">{t('row.openInEditor')}</span>
        {current && (
          <span className="max-w-24 shrink-0 truncate pl-4 text-hint text-tertiary">
            {current.name}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-50">
        {error ? (
          <DropdownMenuItem disabled>{error}</DropdownMenuItem>
        ) : list === null ? (
          <DropdownMenuItem disabled>{t('row.findingEditors')}</DropdownMenuItem>
        ) : list.editors.length === 0 ? (
          <DropdownMenuItem disabled>{t('row.noEditors')}</DropdownMenuItem>
        ) : (
          list.editors.map((editor) => (
            <DropdownMenuItem key={editor.id} onClick={() => open(editor.id)}>
              {editor.icon ? (
                <img src={editor.icon} alt="" className="size-4 shrink-0" draggable={false} />
              ) : (
                <MenuGlyph icon={ComputerIcon} />
              )}
              <span className="min-w-0 truncate">{editor.name}</span>
              {editor.id === current?.id && (
                <Glyph icon={Tick02Icon} size={12} className="ml-auto size-3" />
              )}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={choose}>
          <MenuGlyph icon={FolderOpenIcon} />
          {t('row.chooseApp')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * The menu for several sessions picked together: only the actions that apply to every one of them,
 * each acting on all of them.
 */
export function MultiSessionMenuItems({
  ids,
  onDelete,
}: {
  ids: readonly string[]
  onDelete: () => void
}) {
  const { t } = useTranslation('sidebar')
  const summaries = useSessionsStore(
    useShallow((s) => ids.map((id) => s.byId[id]).filter((x): x is SessionSummary => !!x)),
  )
  const front = useViewStore(
    useShallow((s) =>
      summaries.map(
        (summary) =>
          !s.settings.open &&
          allPanes(s.layout).some(
            (pane) =>
              s.visiblePanes.includes(pane.id) &&
              pane.view.kind === 'session' &&
              pane.view.sessionId === summary.id,
          ),
      ),
    ),
  )
  const count = summaries.length
  const each = (run: (summary: SessionSummary) => Promise<unknown>) => () => {
    clearSelection()
    void Promise.all(summaries.map(run)).catch((error: unknown) => toast(errorMessage(error)))
  }
  const groups = multiSessionMenuGroups(summaries, (index) => front[index] ?? false)
  const shortcut = (accelerator: string | undefined) =>
    accelerator && <DropdownMenuShortcut>{shortcutLabel(accelerator)}</DropdownMenuShortcut>

  return (
    <>
      {groups.map((group, index) => (
        <DropdownMenuGroup key={group[0]}>
          {index > 0 ? (
            <DropdownMenuSeparator />
          ) : (
            <DropdownMenuLabel>{t('row.sessionsCount', { count })}</DropdownMenuLabel>
          )}
          {group.map((name) => {
            const accelerator = MULTI_ACCELERATORS[name]
            const props = { key: name, 'data-accelerator': accelerator }
            switch (name) {
              case 'stop':
                return (
                  <DropdownMenuItem
                    {...props}
                    onClick={each((s) => host('sessions.cancel', { sessionId: s.id }))}
                  >
                    <MenuGlyph icon={StopCircleIcon} />
                    {t('row.stopCount', { count })}
                    {shortcut(accelerator)}
                  </DropdownMenuItem>
                )
              case 'read':
              case 'unread':
                return (
                  <DropdownMenuItem
                    {...props}
                    onClick={each((s) => markSessionUnread(s.id, name === 'unread'))}
                  >
                    <MenuGlyph icon={ViewIcon} />
                    {name === 'read' ? t('row.markRead') : t('row.markUnread')}
                  </DropdownMenuItem>
                )
              case 'pin':
              case 'unpin':
                return (
                  <DropdownMenuItem
                    {...props}
                    onClick={each((s) => pinSession(s.id, name === 'pin'))}
                  >
                    {name === 'pin' ? (
                      <MenuGlyph icon={PinIcon} />
                    ) : (
                      <MenuGlyph icon={PinOffIcon} />
                    )}
                    {name === 'pin' ? t('row.pin') : t('row.unpin')}
                  </DropdownMenuItem>
                )
              case 'archive':
                return (
                  <DropdownMenuItem
                    {...props}
                    onClick={() => {
                      clearSelection()
                      archiveWithUndo(
                        summaries.map((s) => s.id),
                        t('row.archivedCount', { count }),
                      )
                    }}
                  >
                    <MenuGlyph icon={Archive01Icon} />
                    {t('row.archiveCount', { count })}
                    {shortcut(accelerator)}
                  </DropdownMenuItem>
                )
              case 'delete':
                return (
                  <DropdownMenuItem
                    {...props}
                    variant="destructive"
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey) {
                        void deleteUnlessAtStake(summaries, onDelete)
                      } else onDelete()
                    }}
                  >
                    <Glyph icon={Delete02Icon} size={15} />
                    {t('row.deleteCount', { count })}
                  </DropdownMenuItem>
                )
            }
          })}
        </DropdownMenuGroup>
      ))}
    </>
  )
}

/**
 * **Open in split view** with its sides, each disabled, saying why, when the split cannot take
 * that side: a tenth pane, or no room in the window.
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
        <MenuGlyph icon={Layout2ColumnIcon} />
        {t('row.openInSplit')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-49"
        onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
      >
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
  const accelerator = SPLIT_ACCELERATORS[side]
  return (
    <DropdownMenuItem disabled={reason !== null} onClick={onClick} data-accelerator={accelerator}>
      {side === 'right' ? (
        <MenuGlyph icon={SidebarRightIcon} />
      ) : (
        <MenuGlyph icon={SidebarBottomIcon} />
      )}
      {label}
      {reason ? (
        <span className="ml-auto pl-3 text-xs text-tertiary">{t(`row.noRoom.${reason}`)}</span>
      ) : (
        <DropdownMenuShortcut>{shortcutLabel(accelerator)}</DropdownMenuShortcut>
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

/** Uncommitted work in a session's folder, and whether that folder is a linked git worktree. */
interface AtStake {
  /** Null when the host could not read the folder. */
  files: number | null
  worktree: boolean
}

/**
 * Reads what deleting would leave behind: the folder's uncommitted files, from a one-off look that
 * starts no watch. A folder outside git has none.
 */
async function readAtStake(projectPath: string): Promise<AtStake> {
  const files = await host('git.changes', { projectPath }).then(
    (changes) => changes.length,
    () => null,
  )
  const gitDir = useGitStore.getState().status[projectPath]?.repo?.gitDir ?? ''
  return { files, worktree: /[\\/]worktrees[\\/][^\\/]+$/.test(gitDir) }
}

function useAtStake(paths: readonly string[], open: boolean): Map<string, AtStake> | null {
  const key = paths.join('\n')
  // Kept with the paths it was read for, so a dialog for other sessions never shows it.
  const [read, setRead] = useState<{ key: string; stake: Map<string, AtStake> } | null>(null)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const unique = [...new Set(key.split('\n'))]
    void Promise.all(unique.map(async (path) => [path, await readAtStake(path)] as const)).then(
      (entries) => !cancelled && setRead({ key, stake: new Map(entries) }),
    )
    return () => {
      cancelled = true
    }
  }, [key, open])
  return open && read?.key === key ? read.stake : null
}

/** Deletes one by one: their rows in sight turn to dust, and one whose delete fails comes back. */
async function deleteAll(ids: readonly string[]): Promise<void> {
  const dust = await dissolveRows(ids)
  for (const [i, id] of ids.entries()) {
    try {
      await deleteSession(id)
    } catch (error) {
      dust.restore(ids.slice(i))
      throw error
    }
  }
}

/** The Delete item's second key or a Mod-click: deletes at once when nothing is at stake. */
async function deleteUnlessAtStake(
  summaries: readonly SessionSummary[],
  confirm: () => void,
): Promise<void> {
  const paths = [...new Set(summaries.map((s) => s.projectPath))]
  const stakes = await Promise.all(paths.map(readAtStake))
  const files = stakes.map((stake) => stake.files)
  const withChildren = summaries.some((s) => descendantCount(s.id) > 0)
  if (!canDeleteAtOnce(files, withChildren)) return confirm()
  clearSelection()
  try {
    await deleteAll(summaries.map((summary) => summary.id))
  } catch (error) {
    toast(errorMessage(error))
  }
}

/**
 * Deletes one session or several after one confirmation, which calls out the uncommitted files in
 * their folders and offers to archive instead, which keeps them.
 */
export function DeleteSessionDialog({
  sessionId,
  title,
  open,
  onOpenChange,
  onDeleted,
  ids,
}: {
  sessionId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
  /** Several sessions picked together, this one among them. */
  ids?: readonly string[]
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const targets = useSessionsStore(
    useShallow((s) =>
      (ids ?? [sessionId]).map((id) => s.byId[id]).filter((x): x is SessionSummary => !!x),
    ),
  )
  const several = targets.length > 1
  const count = open ? targets.reduce((sum, s) => sum + descendantCount(s.id), 0) : 0
  const stake = useAtStake(
    targets.map((s) => s.projectPath),
    open,
  )
  // Archive keeps what it archives; a sub-session goes with its parent.
  const canArchive = targets.length > 0 && targets.every((s) => s.parentId === null)
  const remove = async () => {
    // Closed first: the rows turn to dust once nothing covers them.
    onOpenChange(false)
    clearSelection()
    try {
      await deleteAll(targets.map((target) => target.id))
      onDeleted?.()
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-105">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {several
              ? t('row.deleteCountTitle', { count: targets.length })
              : t('row.deleteTitle', { title })}
          </AlertDialogTitle>
        </AlertDialogHeader>
        {stake &&
          [...stake.entries()]
            .filter(([, { files }]) => files !== 0)
            .map(([path, { files, worktree }]) => (
              <div
                key={path}
                className="flex gap-2.5 rounded-[10px] bg-(--shell-chip) px-3 py-2.5 text-control leading-normal text-secondary"
              >
                <Glyph
                  icon={GitBranchIcon}
                  size={15}
                  className="mt-0.5 size-3.75 shrink-0 text-icon"
                />
                <span>
                  {/* A folder the host could not read says so, as the reason this asks. */}
                  <Trans
                    t={t}
                    i18nKey={
                      files === null
                        ? 'row.atStakeUnknown'
                        : worktree
                          ? 'row.atStakeWorktree'
                          : 'row.atStakeFolder'
                    }
                    count={files ?? undefined}
                    values={{ name: basename(path) }}
                    components={{
                      name: <span className="font-mono text-xs text-primary" />,
                      files: <b className="font-semibold text-primary" />,
                    }}
                  />
                </span>
              </div>
            ))}
        <AlertDialogDescription className="text-small text-tertiary">
          {count > 0
            ? t('row.deleteBodyWithSub', { count })
            : several
              ? t('row.deleteBodyCount')
              : t('row.deleteBody')}
        </AlertDialogDescription>
        <AlertDialogFooter className="pt-1">
          {canArchive && (
            <Button
              variant="ghost"
              className="mr-auto text-secondary"
              onClick={() => {
                onOpenChange(false)
                clearSelection()
                archiveWithUndo(
                  targets.map((s) => s.id),
                  several
                    ? t('row.archivedCount', { count: targets.length })
                    : t('row.archived', { title }),
                )
              }}
            >
              {t('row.archiveInstead')}
            </Button>
          )}
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void remove()}>
            {t('row.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** A pull request's title in the menu, once its details have loaded somewhere. */
function PrTitle({ url }: { url: string }) {
  const title = useGitStore((s) => s.pullRequests[url]?.title ?? '')
  return <span className="min-w-0 flex-1 truncate">{title}</span>
}
