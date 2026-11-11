import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircleIcon, Folder01Icon, GitBranchIcon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Glyph } from '@renderer/features/shell/glyph'
import { basename } from '@renderer/lib/format'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { hostPath } from '@renderer/lib/host-paths'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import {
  closeRemoval,
  removalChoice,
  removeWorktree,
  useWorktreeRemoval,
  type Inspected,
  type RemovalQuestion,
} from './remove-worktree-model'

/** The question `askRemoveWorktree` asks, mounted once for the window. */
export function RemoveWorktreeDialog() {
  const question = useWorktreeRemoval((s) => s.question)
  const busy = useWorktreeRemoval((s) => s.busy)
  // The last question stays drawn while the dialog closes.
  const [shown, setShown] = useState(question)
  if (question && question !== shown) setShown(question)
  return (
    <AlertDialog open={!!question} onOpenChange={(open) => !open && !busy && closeRemoval()}>
      {shown && <RemovalForm key={shown.id} question={shown} />}
    </AlertDialog>
  )
}

type Failure =
  { kind: 'conflict' } | { kind: 'git'; message: string } | { kind: 'other'; message: string }

function RemovalForm({ question }: { question: RemovalQuestion }) {
  const { t } = useTranslation(['sidebar', 'common'])
  const { summary, reason } = question
  const worktree = summary.worktree
  const title = sessionTitle(summary)
  const [inspected, setInspected] = useState<Inspected | null>(question.inspected)
  const [readError, setReadError] = useState<string | null>(null)
  // Each check of the worktree; 0 while the one handed in is still current.
  const [attempt, setAttempt] = useState(question.inspected ? 0 : 1)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [stopOthers, setStopOthers] = useState(false)
  const [doing, setDoing] = useState<'keep' | 'delete' | null>(null)
  const keep = useRef<HTMLButtonElement>(null)
  const others = useSessionsStore(
    useShallow((s) =>
      (inspected?.others ?? []).map((id) => {
        const other = s.byId[id]
        return other ? sessionTitle(other) : id
      }),
    ),
  )

  useEffect(() => {
    if (attempt === 0) return
    let live = true
    host('worktrees.inspect', { sessionId: summary.id }).then(
      (read) => live && setInspected(read),
      (error: unknown) => live && setReadError(errorMessage(error)),
    )
    return () => {
      live = false
    }
  }, [summary.id, attempt])

  const checkAgain = () => {
    setInspected(null)
    setReadError(null)
    setFailure(null)
    setStopOthers(false)
    setAttempt((n) => n + 1)
  }

  const remove = async (branch: 'keep' | 'delete') => {
    if (!inspected) return
    setDoing(branch)
    setFailure(null)
    useWorktreeRemoval.setState({ busy: true })
    try {
      const next = await removeWorktree(summary, branch, inspected)
      closeRemoval()
      const name = worktree?.branch ?? ''
      toast(
        next.worktree?.state === 'gone'
          ? t('worktree.removedWithBranch', { branch: name })
          : branch === 'delete'
            ? t('worktree.branchKept', { branch: name })
            : t('worktree.removed', { title }),
      )
    } catch (error) {
      const code = errorCode(error)
      setFailure(
        code === 'conflict'
          ? { kind: 'conflict' }
          : code === 'git_error'
            ? { kind: 'git', message: errorMessage(error) }
            : { kind: 'other', message: errorMessage(error) },
      )
    } finally {
      setDoing(null)
      useWorktreeRemoval.setState({ busy: false })
    }
  }

  if (!worktree) return null
  const choice = inspected ? removalChoice(inspected) : null
  const shared = others.length > 0
  const busy = doing !== null
  // A conflict needs a fresh look before anything is removed.
  const ready = inspected !== null && failure?.kind !== 'conflict' && (!shared || stopOthers)
  const spinner = (branch: 'keep' | 'delete') =>
    doing === branch && <Spinner data-icon="inline-start" />

  return (
    <AlertDialogContent
      initialFocus={keep}
      className="gap-3.5 px-5.5 data-[size=default]:sm:max-w-132"
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{t('worktree.removeTitle')}</AlertDialogTitle>
      </AlertDialogHeader>
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-control text-secondary"
        title={hostPath(worktree.path)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Glyph icon={Folder01Icon} size={14} className="size-3.5 shrink-0 text-icon" />
          <span className="truncate font-mono text-xs text-primary">
            {basename(hostPath(worktree.path))}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <Glyph icon={GitBranchIcon} size={14} className="size-3.5 shrink-0 text-icon" />
          <span className="truncate font-mono text-xs text-primary">{worktree.branch}</span>
        </span>
      </div>
      <AlertDialogDescription className="text-small text-tertiary">
        {reason === 'archived'
          ? t('worktree.afterArchive', { title })
          : reason === 'deleting'
            ? t('worktree.afterDelete', { title })
            : t('worktree.keepsConversation')}
      </AlertDialogDescription>

      {inspected === null && readError === null && (
        <div aria-busy className="flex flex-col gap-2 py-1">
          <span className="sr-only">{t('worktree.checking')}</span>
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
      )}
      {readError !== null && (
        <Note tone="danger">{t('worktree.inspectFailed', { error: readError })}</Note>
      )}

      {inspected && shared && (
        <Note>
          <span>{t('worktree.others', { count: others.length })}</span>
          <ul className="mt-1 list-none">
            {others.map((name, index) => (
              <li key={inspected.others[index]} className="truncate text-primary">
                {name}
              </li>
            ))}
          </ul>
          <label className="mt-2 flex items-center gap-2.25 text-primary">
            <Checkbox checked={stopOthers} onCheckedChange={setStopOthers} disabled={busy} />
            {t('worktree.stopOthers', { count: others.length })}
          </label>
        </Note>
      )}

      {inspected && choice === 'atStake' && (
        <Note>
          {inspected.uncommitted > 0 && (
            <span className="block">
              <Trans
                t={t}
                i18nKey="worktree.uncommitted"
                count={inspected.uncommitted}
                components={{ files: <b className="font-semibold text-primary" /> }}
              />
            </span>
          )}
          {inspected.unpushed > 0 && !inspected.merged && (
            <span className="block">
              <Trans
                t={t}
                i18nKey="worktree.unpushed"
                count={inspected.unpushed}
                components={{ files: <b className="font-semibold text-primary" /> }}
              />
            </span>
          )}
        </Note>
      )}
      {inspected && choice === 'branch' && (
        <p className="text-small text-tertiary">{t('worktree.merged', { base: worktree.base })}</p>
      )}
      {inspected && choice === 'worktree' && inspected.branchExists && (
        <p className="text-small text-tertiary">
          {t('worktree.notMerged', { base: worktree.base })}
        </p>
      )}

      {failure?.kind === 'conflict' && <Note tone="danger">{t('worktree.conflict')}</Note>}
      {failure?.kind === 'git' && (
        <Note tone="danger">
          <span className="block">{t('worktree.gitRefused')}</span>
          <span className="mt-1 block font-mono text-xs break-words whitespace-pre-wrap text-primary">
            {failure.message}
          </span>
          <span className="mt-1 block">{t('worktree.inUse')}</span>
        </Note>
      )}
      {failure?.kind === 'other' && <Note tone="danger">{failure.message}</Note>}

      <AlertDialogFooter className="pt-1 sm:flex-wrap">
        {choice === 'branch' && failure?.kind !== 'conflict' && (
          <Button
            variant="ghost"
            className="mr-auto text-secondary"
            disabled={!ready || busy}
            onClick={() => void remove('keep')}
          >
            {spinner('keep')}
            {t('worktree.removeKeepBranch')}
          </Button>
        )}
        <AlertDialogCancel ref={keep} disabled={busy}>
          {t('worktree.keep')}
        </AlertDialogCancel>
        {(readError !== null || failure?.kind === 'conflict') && (
          <Button size="dialog" variant="outline" onClick={checkAgain}>
            {t('worktree.checkAgain')}
          </Button>
        )}
        {failure?.kind !== 'conflict' && readError === null && (
          <Button
            size="dialog"
            // Clean and unshared, removing loses nothing; otherwise it reads as the risk it is.
            variant={choice !== null && choice !== 'atStake' && !shared ? 'default' : 'destructive'}
            disabled={!ready || busy}
            onClick={() => void remove(choice === 'branch' ? 'delete' : 'keep')}
          >
            {spinner(choice === 'branch' ? 'delete' : 'keep')}
            {choice === 'branch'
              ? t('worktree.removeAll')
              : choice === 'worktree'
                ? t('worktree.removeKeepBranch')
                : t('worktree.remove')}
          </Button>
        )}
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

/** A note in the style of the delete dialog's: what is at stake, or why removing stopped. */
function Note({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className="flex gap-2.5 rounded-[10px] bg-(--shell-chip) px-3 py-2.5 text-control leading-normal text-secondary"
    >
      <Glyph
        icon={tone === 'danger' ? AlertCircleIcon : GitBranchIcon}
        size={15}
        className={
          tone === 'danger'
            ? 'mt-0.5 size-3.75 shrink-0 text-danger'
            : 'mt-0.5 size-3.75 shrink-0 text-icon'
        }
      />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
    </div>
  )
}
