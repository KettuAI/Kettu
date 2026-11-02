import { useEffect, useMemo, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import {
  ArrowLeftIcon,
  ArrowUpToLineIcon,
  CheckIcon,
  GitBranchIcon,
  GlobeIcon,
  LockIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import {
  isRepositoryName,
  type ChangedFile,
  type GitRemote,
  type GitStatus,
  type RepositoryVisibility,
} from '@shared/git'
import { SegmentedControl } from '@renderer/components/segmented-control'
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
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Spinner } from '@renderer/components/ui/spinner'
import { Textarea } from '@renderer/components/ui/textarea'
import { errorMessage, host } from '@renderer/lib/host'
import { isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import {
  closeGitDialog,
  createPullRequest,
  runGitOperation,
  useGitStore,
  type GitDialog,
} from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import { LineCounts } from './rows'
import { pushNow, pushRequest, runStep, showCreatedPr } from './steps'
import { failureOf, lastLine, pullRequestHead, pushTargetOf, suggestPullRequest } from './sync'
import { isBranchName } from './switcher-model'
import { loadCommit, useChanges } from './use-git-data'

type ReturnFocus = RefObject<HTMLElement | null>

/**
 * The branch popover's and the Files pane's dialogs, kept outside them so they can close under
 * a dialog. The opener's button may be gone when one closes, so focus goes back to `returnFocus`.
 */
export function GitDialogs({
  status,
  returnFocus,
}: {
  status: GitStatus
  returnFocus?: ReturnFocus
}) {
  const dialog = useGitStore((s) => s.dialogs[status.projectPath] ?? null)
  const close = (): void => closeGitDialog(status.projectPath)
  const shown = (kind: GitDialog['kind']) => dialog?.kind === kind
  const onOpenChange = (open: boolean) => !open && close()
  return (
    <>
      <ConfirmPushDialog
        status={status}
        dialog={dialog}
        returnFocus={returnFocus}
        onClose={close}
      />
      <DiscardDialog status={status} dialog={dialog} returnFocus={returnFocus} onClose={close} />
      <Dialog open={shown('publishRepo')} onOpenChange={onOpenChange}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false}>
          {dialog?.kind === 'publishRepo' && <PublishRepoForm status={status} onClose={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={shown('publishBranch')} onOpenChange={onOpenChange}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false} className={SHEET_100}>
          {dialog?.kind === 'publishBranch' && (
            <PublishBranchForm status={status} onClose={close} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={shown('commit')} onOpenChange={onOpenChange}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false} className={SHEET_115}>
          {dialog?.kind === 'commit' && (
            <CommitForm status={status} dialog={dialog} onClose={close} />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={shown('createPr')} onOpenChange={onOpenChange}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false} className={SHEET_120}>
          {dialog?.kind === 'createPr' && <CreatePrForm status={status} onClose={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={shown('newBranch')} onOpenChange={onOpenChange}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false} className={SHEET_100}>
          {dialog?.kind === 'newBranch' && <NewBranchForm status={status} onClose={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={shown('log')} onOpenChange={onOpenChange}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false} className="sm:max-w-160">
          {dialog?.kind === 'log' && <LogView projectPath={status.projectPath} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

// The git dialogs lay out their own padding: a title, the fields under it, the buttons apart.
const SHEET = 'gap-0 p-0'
const SHEET_100 = cn(SHEET, 'sm:max-w-100')
const SHEET_115 = cn(SHEET, 'sm:max-w-115')
const SHEET_120 = cn(SHEET, 'sm:max-w-120')

function Head({ children }: { children: ReactNode }) {
  return (
    <DialogHeader className="px-5.5 pt-5">
      <DialogTitle className="truncate">{children}</DialogTitle>
    </DialogHeader>
  )
}

function Body({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-col px-5.5 pt-3.5">{children}</div>
}

function Foot({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-5.5 py-4.5">
      <span className="min-w-0 flex-1 truncate text-hint text-tertiary">{note}</span>
      {children}
    </div>
  )
}

/** A field's label, with an action at its end. */
function Label({
  htmlFor,
  children,
  action,
}: {
  htmlFor?: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="mt-3 mb-1.5 flex items-center first:mt-0">
      <label htmlFor={htmlFor} className="flex-1 text-control font-medium text-primary">
        {children}
      </label>
      {action}
    </div>
  )
}

function FailureText({ log }: { log: string }) {
  return (
    <p
      role="alert"
      className="mt-3 text-small leading-normal text-danger [overflow-wrap:anywhere]"
      title={log}
    >
      {lastLine(log)}
    </p>
  )
}

function ConfirmPushDialog({
  status,
  dialog,
  returnFocus,
  onClose,
}: {
  status: GitStatus
  dialog: GitDialog | null
  returnFocus?: ReturnFocus
  onClose: () => void
}) {
  const { t } = useTranslation(['git', 'common'])
  const confirm = dialog?.kind === 'confirmPush' ? dialog : null
  // The branch it lands on, which is the default branch, not the one checked out.
  const branch = confirm?.operation.branch ?? ''
  const count = confirm?.count ?? 0
  return (
    <AlertDialog open={!!confirm} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent finalFocus={returnFocus} className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('dialog.confirmPush.title', { branch })}</AlertDialogTitle>
          <AlertDialogDescription>
            {count > 0
              ? t('dialog.confirmPush.description', { branch, count })
              : t('dialog.confirmPush.descriptionUncounted', { branch })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (!confirm) return
              onClose()
              void runStep(status.projectPath, confirm.operation)
            }}
          >
            {t('dialog.confirmPush.action', { branch })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function DiscardDialog({
  status,
  dialog,
  returnFocus,
  onClose,
}: {
  status: GitStatus
  dialog: GitDialog | null
  returnFocus?: ReturnFocus
  onClose: () => void
}) {
  const { t } = useTranslation(['git', 'common'])
  const discard = dialog?.kind === 'discard' ? dialog : null
  const paths = discard?.paths ?? []
  const name = paths.length === 1 ? paths[0]!.slice(paths[0]!.lastIndexOf('/') + 1) : ''
  return (
    <AlertDialog open={!!discard} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent finalFocus={returnFocus} className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {paths.length === 1
              ? t('dialog.discard.titleOne', { name })
              : t('dialog.discard.title', { count: paths.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('dialog.discard.description', { count: paths.length })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (!discard) return
              onClose()
              void runStep(status.projectPath, { kind: 'discard', paths: discard.paths })
            }}
          >
            {t('dialog.discard.action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The files a commit can take: everything changed but a conflicted file. */
function committable(files: readonly ChangedFile[]): ChangedFile[] {
  return files.filter((file) => file.status !== 'conflicted')
}

function CommitForm({
  status,
  dialog,
  onClose,
}: {
  status: GitStatus
  dialog: Extract<GitDialog, { kind: 'commit' }>
  onClose: () => void
}) {
  const { t } = useTranslation(['git', 'common'])
  const { projectPath } = status
  const { data, error: loadError } = useChanges(projectPath, true)
  const files = useMemo(() => committable(data ?? []), [data])
  const [message, setMessage] = useState('')
  // Null until the changes load: then the files the opener chose, or all of them.
  const [ticked, setTicked] = useState<ReadonlySet<string> | null>(null)
  if (data && ticked === null) {
    const all = files.map((file) => file.path)
    setTicked(new Set(dialog.paths ? all.filter((path) => dialog.paths!.includes(path)) : all))
  }
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const chosen = files.filter((file) => ticked?.has(file.path))
  const ready = message.trim() !== '' && chosen.length > 0 && !busy

  const toggle = (path: string, on: boolean): void => {
    const next = new Set(ticked ?? [])
    if (on) next.add(path)
    else next.delete(path)
    setTicked(next)
  }

  const commit = async (andPush: boolean): Promise<void> => {
    if (!ready) return
    setBusy(andPush ? 'push' : 'commit')
    setError(null)
    const done = await runStep(
      projectPath,
      { kind: 'commit', message: message.trim(), paths: chosen.map((file) => file.path) },
      { quietFailure: true },
    )
    setBusy(null)
    if (!done) {
      setError(useGitStore.getState().failed[projectPath]?.log ?? '')
      return
    }
    onClose()
    if (andPush) pushNow(projectPath)
  }

  return (
    <form
      className="contents"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void commit(false)
      }}
    >
      <Head>{t('dialog.commit.title', { branch: status.head.branch ?? 'HEAD' })}</Head>
      <Body>
        <Label htmlFor="commit-message">{t('dialog.commit.message')}</Label>
        <Textarea
          id="commit-message"
          value={message}
          autoFocus
          rows={4}
          placeholder={t('dialog.commit.placeholder')}
          className="max-h-60 min-h-27.5 text-control leading-[1.55]"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter' && isMod(event)) {
              event.preventDefault()
              void commit(false)
            }
          }}
        />
        <Label>
          {ticked
            ? t('dialog.commit.filesChosen', { count: files.length, chosen: chosen.length })
            : t('dialog.commit.files')}
        </Label>
        <div className="-mx-1 max-h-50 overflow-y-auto px-1">
          {loadError && <p className="text-small text-danger">{loadError.split('\n')[0]}</p>}
          {files.map((file) => (
            <label key={file.path} className="flex h-7.5 items-center gap-2.25" title={file.path}>
              <Checkbox
                checked={ticked?.has(file.path) ?? false}
                onCheckedChange={(on) => toggle(file.path, on)}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-code text-primary">
                {file.path}
              </span>
              <LineCounts insertions={file.insertions} deletions={file.deletions} />
            </label>
          ))}
        </div>
        {error !== null && <FailureText log={error} />}
      </Body>
      <Foot>
        <DialogClose render={<Button variant="outline" size="compact" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" variant="outline" size="compact" disabled={!ready}>
          {busy === 'commit' && <Spinner data-icon="inline-start" />}
          {t('dialog.commit.commit')}
        </Button>
        <Button
          type="button"
          size="compact"
          disabled={!ready || status.push === null}
          onClick={() => void commit(true)}
        >
          {busy === 'push' && <Spinner data-icon="inline-start" />}
          {t('dialog.commit.commitAndPush')}
        </Button>
      </Foot>
    </form>
  )
}

/** The repository's remotes, loaded while a dialog that picks one shows. */
function useRemotes(projectPath: string): { remotes: GitRemote[] | null; error: string | null } {
  const [state, setState] = useState<{ remotes: GitRemote[] | null; error: string | null }>({
    remotes: null,
    error: null,
  })
  useEffect(() => {
    let live = true
    host('git.branches', { projectPath }).then(
      (list) => live && setState({ remotes: list.remotes, error: null }),
      (error: unknown) => live && setState({ remotes: null, error: errorMessage(error) }),
    )
    return () => {
      live = false
    }
  }, [projectPath])
  return state
}

/** "github.com/owner/repo" for a GitHub remote, else its URL. */
function remoteWhere(remote: GitRemote): string {
  return remote.github ? `github.com/${remote.github.owner}/${remote.github.repo}` : remote.url
}

function PublishBranchForm({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation(['git', 'common'])
  const { projectPath } = status
  const branch = status.head.branch ?? ''
  const { remotes, error: loadError } = useRemotes(projectPath)
  const [picked, setPicked] = useState<string | null>(null)
  const remote = picked ?? pushTargetOf(status)?.remote ?? remotes?.[0]?.name ?? null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!remote || busy) return
    setBusy(true)
    setError(null)
    const done = await runStep(
      projectPath,
      { kind: 'publishBranch', remote },
      { quietFailure: true },
    )
    setBusy(false)
    if (done) onClose()
    else setError(useGitStore.getState().failed[projectPath]?.log ?? '')
  }

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <Head>{t('dialog.publishBranch.title', { branch })}</Head>
      <Body>
        <p className="text-control leading-normal text-secondary">
          <Trans
            t={t}
            i18nKey="dialog.publishBranch.description"
            values={{ remote: remote ?? 'origin' }}
            components={{ remote: <span className="font-mono text-command text-primary" /> }}
          />
        </p>
        <Label htmlFor="publish-remote">{t('dialog.publishBranch.remote')}</Label>
        {loadError ? (
          <p className="text-small text-danger">{loadError.split('\n')[0]}</p>
        ) : (
          <Select
            value={remote}
            items={(remotes ?? []).map((r) => ({ value: r.name, label: r.name }))}
            onValueChange={(next) => next && setPicked(next as string)}
          >
            <SelectTrigger id="publish-remote" className="h-8.5 w-full text-control">
              <SelectValue>
                {(name: string | null) => {
                  const r = remotes?.find((item) => item.name === name)
                  return r ? <RemoteLabel remote={r} /> : name
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(remotes ?? []).map((r) => (
                  <SelectItem key={r.name} value={r.name}>
                    <RemoteLabel remote={r} />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {error !== null && <FailureText log={error} />}
      </Body>
      <Foot>
        <DialogClose render={<Button variant="outline" size="compact" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" size="compact" disabled={!remote || busy}>
          {busy ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ArrowUpToLineIcon data-icon="inline-start" />
          )}
          {t('dialog.publishBranch.action')}
        </Button>
      </Foot>
    </form>
  )
}

function RemoteLabel({ remote }: { remote: GitRemote }) {
  return (
    <span className="min-w-0 truncate">
      {remote.name} <span className="text-tertiary">· {remoteWhere(remote)}</span>
    </span>
  )
}

function NewBranchForm({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation(['git', 'common'])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const typed = name.trim()
  const valid = isBranchName(typed)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const done = await runStep(
      status.projectPath,
      { kind: 'switch', branch: typed, create: true },
      { quietFailure: true },
    )
    setBusy(false)
    if (done) onClose()
    else setError(useGitStore.getState().failed[status.projectPath]?.log ?? '')
  }

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <Head>{t('dialog.newBranch.title')}</Head>
      <Body>
        <p className="text-control leading-normal text-secondary">
          {status.head.detached
            ? t('dialog.newBranch.fromCommit', { commit: status.head.oid?.slice(0, 7) ?? 'HEAD' })
            : t('dialog.newBranch.from', { branch: status.head.branch ?? 'HEAD' })}
        </p>
        <Label htmlFor="new-branch">{t('dialog.newBranch.name')}</Label>
        <Input
          id="new-branch"
          value={name}
          autoFocus
          spellCheck={false}
          aria-invalid={(typed !== '' && !valid) || undefined}
          className="h-8.5 text-control"
          onChange={(event) => setName(event.target.value)}
        />
        {typed !== '' && !valid && (
          <p className="mt-1.5 text-small text-danger">{t('dialog.newBranch.invalid')}</p>
        )}
        {error !== null && <FailureText log={error} />}
      </Body>
      <Foot>
        <DialogClose render={<Button variant="outline" size="compact" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" size="compact" disabled={!valid || busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {t('dialog.newBranch.action')}
        </Button>
      </Foot>
    </form>
  )
}

/** The paths the branch's commits change, from their cached details. */
function useBranchFiles(status: GitStatus): number | null {
  const [count, setCount] = useState<number | null>(null)
  const key = status.commits.map((c) => c.oid).join(',')
  useEffect(() => {
    let live = true
    Promise.all(status.commits.map((c) => loadCommit(status.projectPath, c.oid))).then(
      (details) => {
        if (!live) return
        setCount(new Set(details.flatMap((d) => d.files.map((f) => f.path))).size)
      },
      () => live && setCount(null),
    )
    return () => {
      live = false
    }
    // `key` names the commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.projectPath, key])
  return count
}

function CreatePrForm({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation(['git', 'common'])
  const { projectPath } = status
  const target = pushTargetOf(status)
  const headBranch = target?.branch ?? status.head.branch ?? ''
  const [initial] = useState(() => suggestPullRequest(status.head.branch ?? '', status.commits))
  const [title, setTitle] = useState(initial.title)
  const [body, setBody] = useState(initial.body)
  const [base, setBase] = useState(status.defaultBranch ?? '')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const files = useBranchFiles(status)
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    let live = true
    host('git.branches', { projectPath }).then(
      (list) => live && setBranches(list.branches.map((b) => b.name)),
      () => {},
    )
    return () => {
      live = false
    }
  }, [projectPath])
  // Unpublished, or with commits the remote does not have yet, it is pushed before it is opened.
  const pushesFirst = !!target && (target.setUpstream || (status.upstream?.ahead ?? 0) > 0)
  const valid = target !== null && title.trim() !== '' && base.trim() !== '' && base !== headBranch

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      if (pushesFirst) {
        const request = pushRequest(status)
        if (!request || !(await runGitOperation(projectPath, request))) {
          setError(useGitStore.getState().failed[projectPath]?.log ?? '')
          return
        }
      }
      if (!pullRequestHead(useGitStore.getState().status[projectPath] ?? status)) {
        setError(t('dialog.createPr.notOnGitHub'))
        return
      }
      const pr = await createPullRequest(projectPath, {
        title: title.trim(),
        body,
        base: base.trim(),
        draft,
      })
      onClose()
      showCreatedPr(projectPath, pr.number)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const choices = [...new Set([base, ...branches.filter((b) => b !== headBranch)])].filter(Boolean)
  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <Head>{t('dialog.createPr.title')}</Head>
      <Body>
        <div className="flex items-center gap-2 text-control text-secondary">
          <Select
            value={base}
            items={choices.map((name) => ({ value: name, label: name }))}
            onValueChange={(next) => next && setBase(next as string)}
          >
            <SelectTrigger
              aria-label={t('dialog.createPr.base')}
              variant="quiet"
              className="h-6.5 gap-1.5 bg-subtle px-3 text-control font-medium text-primary"
            >
              <GitBranchIcon className="size-3.25" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {choices.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <ArrowLeftIcon aria-hidden className="size-3.5 shrink-0 text-tertiary" />
          <span className="min-w-0 truncate font-mono text-command text-primary">{headBranch}</span>
          <span className="flex-1" />
          <span className="shrink-0 text-hint text-tertiary tabular">
            {files === null
              ? t('dialog.createPr.commits', { count: status.commits.length })
              : t('dialog.createPr.commitsFiles', {
                  count: status.commits.length,
                  files: t('dialog.createPr.files', { count: files }),
                })}
          </span>
        </div>
        <Label htmlFor="pr-title">{t('dialog.createPr.titleField')}</Label>
        <Input
          id="pr-title"
          value={title}
          autoFocus
          className="h-8.5 text-control"
          onChange={(e) => setTitle(e.target.value)}
        />
        <Label htmlFor="pr-body">{t('dialog.createPr.body')}</Label>
        <Textarea
          id="pr-body"
          value={body}
          rows={7}
          className="max-h-75 min-h-42.5 text-control leading-[1.55]"
          onChange={(e) => setBody(e.target.value)}
        />
        <label className="mt-3 flex items-center gap-2.25 text-control text-primary">
          <Checkbox checked={draft} onCheckedChange={setDraft} />
          {t('dialog.createPr.draft')}
        </label>
        {error !== null && <FailureText log={error} />}
      </Body>
      <Foot note={pushesFirst ? t('dialog.createPr.pushesFirst') : undefined}>
        <DialogClose render={<Button variant="outline" size="compact" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" size="compact" disabled={!valid || busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {t('dialog.createPr.action')}
        </Button>
      </Foot>
    </form>
  )
}

/** Settings under the fields, one per row: the label and a line about it, the control at the end. */
function Rows({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-subtle border-t border-subtle">{children}</div>
  )
}

function Row({
  label,
  description,
  children,
}: {
  label: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Field
      orientation="horizontal"
      className="min-h-12 gap-4 py-1.5 has-[>[data-slot=field-content]]:items-center"
    >
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        {description && (
          <FieldDescription className="text-xs text-tertiary">{description}</FieldDescription>
        )}
      </FieldContent>
      {children}
    </Field>
  )
}

function folderName(root: string): string {
  const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return name.replace(/[^A-Za-z0-9_.-]+/g, '-')
}

function PublishRepoForm({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation(['git', 'common'])
  const gh = useGitStore((s) => s.tools?.gh ?? null)
  const busy = useGitStore((s) => s.running[status.projectPath]?.kind === 'publishRepo')
  const failed = useGitStore((s) =>
    s.failed[status.projectPath]?.kind === 'publishRepo' ? s.failed[status.projectPath] : null,
  )
  const [name, setName] = useState(() => folderName(status.repo?.root ?? status.projectPath))
  const [visibility, setVisibility] = useState<RepositoryVisibility>('private')
  const valid = isRepositoryName(name)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    const done = await runStep(
      status.projectPath,
      { kind: 'publishRepo', name, visibility },
      { quietFailure: true },
    )
    if (done) onClose()
  }

  if (gh?.state !== 'ready') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t('dialog.publish.title')}</DialogTitle>
          <DialogDescription>
            {gh?.state === 'signed-out' ? (
              t('dialog.publish.ghSignedOut')
            ) : (
              <Trans
                t={t}
                i18nKey="dialog.publish.ghMissing"
                components={{
                  cli: <a href="https://cli.github.com" target="_blank" rel="noreferrer" />,
                }}
              />
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg bg-code-block py-1 pr-1 pl-3">
          <code className="flex-1 font-mono text-code">gh auth login</code>
          <CopyButton text="gh auth login" label={t('prPart.copyCommand')} />
        </div>
        <DialogFooter showCloseButton />
      </>
    )
  }

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{t('dialog.publish.title')}</DialogTitle>
        <DialogDescription>{t('dialog.publish.description')}</DialogDescription>
      </DialogHeader>
      <Field data-invalid={!valid || undefined}>
        <FieldLabel htmlFor="publish-name">{t('dialog.publish.name')}</FieldLabel>
        <Input
          id="publish-name"
          value={name}
          autoFocus
          spellCheck={false}
          aria-invalid={!valid || undefined}
          onChange={(event) => setName(event.target.value.trim())}
        />
        {!valid && <FieldError>{t('dialog.publish.nameInvalid')}</FieldError>}
      </Field>
      <Rows>
        <Row
          label={t('dialog.publish.visibility')}
          description={gh.account && t('dialog.publish.account', { account: gh.account })}
        >
          <SegmentedControl
            aria-label={t('dialog.publish.visibility')}
            value={visibility}
            onChange={setVisibility}
            className="w-fit shrink-0"
            segments={[
              {
                value: 'private',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <LockIcon aria-hidden className="size-3.5" />
                    {t('dialog.publish.private')}
                  </span>
                ),
              },
              {
                value: 'public',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <GlobeIcon aria-hidden className="size-3.5" />
                    {t('dialog.publish.public')}
                  </span>
                ),
              },
            ]}
          />
        </Row>
      </Rows>
      {failed && (
        <p className="text-xs leading-normal text-danger [overflow-wrap:anywhere]">
          {t(`failure.${failed.busy ? 'busy' : failureOf(failed.log)}`, {
            operation: t('failure.operation.publish'),
            detail: lastLine(failed.log),
          })}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" disabled={!valid || busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {t('dialog.publish.action')}
        </Button>
      </DialogFooter>
    </form>
  )
}

const LOG_TITLE = {
  fetch: 'failure.operation.fetch',
  pull: 'failure.operation.pull',
  push: 'failure.operation.push',
  publishBranch: 'failure.operation.publish',
  publishRepo: 'failure.operation.publish',
  switch: 'failure.operation.switch',
  commit: 'failure.operation.commit',
  discard: 'failure.operation.discard',
} as const

/** The failed operation's whole output, as git wrote it, with Copy. */
function LogView({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation(['git', 'common'])
  const failed = useGitStore((s) => s.failed[projectPath] ?? null)
  const [copied, setCopied] = useState(false)
  const log = failed?.log ?? ''
  const copy = (): void => {
    void navigator.clipboard.writeText(log).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('dialog.log.title', { operation: t(LOG_TITLE[failed?.kind ?? 'push']) })}
        </DialogTitle>
      </DialogHeader>
      {/* git aligns its output in columns, so lines scroll rather than wrap. */}
      <pre
        data-selectable=""
        className="max-h-75 overflow-auto rounded-code border border-subtle bg-code-block px-3.5 py-3 font-mono text-code whitespace-pre"
      >
        {log || t('dialog.log.empty')}
      </pre>
      <DialogFooter>
        <Button variant="outline" disabled={!log} onClick={copy}>
          {copied && <CheckIcon data-icon="inline-start" />}
          {copied ? t('common:actions.copied') : t('dialog.log.copy')}
        </Button>
        <DialogClose render={<Button />}>{t('common:actions.close')}</DialogClose>
      </DialogFooter>
    </>
  )
}
