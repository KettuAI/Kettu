import { useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { isRepositoryName, type GitStatus, type RepositoryVisibility } from '@shared/git'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { errorMessage } from '@renderer/lib/host'
import {
  closeGitDialog,
  createPullRequest,
  runGitOperation,
  useGitStore,
  type GitDialog,
} from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import { failureOf, lastLine, pullRequestHead, suggestPullRequest } from './sync'

/** The branch popover's dialogs, kept outside it so the popover can close under them. */
export function GitDialogs({ status }: { status: GitStatus }) {
  const dialog = useGitStore((s) => s.dialogs[status.projectPath] ?? null)
  const close = (): void => closeGitDialog(status.projectPath)
  return (
    <>
      <ConfirmPushDialog status={status} dialog={dialog} onClose={close} />
      <Dialog open={dialog?.kind === 'publishRepo'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          {dialog?.kind === 'publishRepo' && <PublishForm status={status} onClose={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === 'createPr'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-lg">
          {dialog?.kind === 'createPr' && <CreatePrForm status={status} onClose={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === 'log'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-xl">
          {dialog?.kind === 'log' && <LogView projectPath={status.projectPath} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function ConfirmPushDialog({
  status,
  dialog,
  onClose,
}: {
  status: GitStatus
  dialog: GitDialog | null
  onClose: () => void
}) {
  const { t } = useTranslation(['git', 'common'])
  const confirm = dialog?.kind === 'confirmPush' ? dialog : null
  // The branch it lands on, which is the default branch, not the one checked out.
  const branch = confirm?.operation.branch ?? ''
  const count = confirm?.count ?? 0
  return (
    <AlertDialog open={!!confirm} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-sm">
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
              void runGitOperation(status.projectPath, confirm.operation)
            }}
          >
            {t('dialog.confirmPush.action', { branch })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function folderName(root: string): string {
  const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return name.replace(/[^A-Za-z0-9_.-]+/g, '-')
}

function PublishForm({ status, onClose }: { status: GitStatus; onClose: () => void }) {
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
    if (await runGitOperation(status.projectPath, { kind: 'publishRepo', name, visibility })) {
      onClose()
    }
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
        <div className="flex items-center gap-2 rounded-lg bg-muted py-1 pr-1 pl-3">
          <code className="flex-1 font-mono text-xs">gh auth login</code>
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
      <Field>
        <FieldLabel>{t('dialog.publish.visibility')}</FieldLabel>
        <SegmentedControl
          aria-label={t('dialog.publish.visibility')}
          value={visibility}
          onChange={setVisibility}
          className="w-fit"
          segments={[
            { value: 'private', label: t('dialog.publish.private') },
            { value: 'public', label: t('dialog.publish.public') },
          ]}
        />
        {gh.account && (
          <FieldDescription>
            {t('dialog.publish.account', { account: gh.account })}
          </FieldDescription>
        )}
      </Field>
      {failed && (
        <p className="text-xs leading-normal text-destructive [overflow-wrap:anywhere]">
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

function CreatePrForm({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation(['git', 'common'])
  const head = pullRequestHead(status) ?? ''
  const github = status.remote?.github
  const [initial] = useState(() => suggestPullRequest(status.head.branch ?? '', status.commits))
  const [title, setTitle] = useState(initial.title)
  const [body, setBody] = useState(initial.body)
  const [base, setBase] = useState(status.defaultBranch ?? '')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = head !== '' && title.trim() !== '' && base.trim() !== '' && base !== head

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      await createPullRequest(status.projectPath, {
        title: title.trim(),
        body,
        base: base.trim(),
        draft,
      })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{t('dialog.createPr.title')}</DialogTitle>
        <DialogDescription>
          <Trans
            t={t}
            i18nKey="dialog.createPr.description"
            values={{ head, repo: github ? `${github.owner}/${github.repo}` : '' }}
            components={{ branch: <span className="font-mono text-control text-foreground" /> }}
          />
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="pr-title">{t('dialog.createPr.titleField')}</FieldLabel>
        <Input id="pr-title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="pr-body">{t('dialog.createPr.body')}</FieldLabel>
        <Textarea
          id="pr-body"
          value={body}
          rows={5}
          className="max-h-60 font-mono text-xs"
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <div className="flex items-start gap-4">
        <Field className="w-40">
          <FieldLabel htmlFor="pr-base">{t('dialog.createPr.base')}</FieldLabel>
          <Input
            id="pr-base"
            value={base}
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(e) => setBase(e.target.value.trim())}
          />
        </Field>
        <Field orientation="horizontal" className="mt-7 flex-1">
          <Switch id="pr-draft" checked={draft} onCheckedChange={setDraft} />
          <FieldLabel htmlFor="pr-draft" className="font-normal">
            {t('dialog.createPr.draft')}
          </FieldLabel>
        </Field>
      </div>
      {draft && (
        <FieldDescription className="-mt-2">{t('dialog.createPr.draftHint')}</FieldDescription>
      )}
      {error && <FailureText log={error} />}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" disabled={!valid || busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {t('dialog.createPr.action')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function FailureText({ log }: { log: string }) {
  return (
    <p className="text-xs leading-normal text-destructive [overflow-wrap:anywhere]" title={log}>
      {lastLine(log)}
    </p>
  )
}

const LOG_TITLE = {
  fetch: 'failure.operation.fetch',
  pull: 'failure.operation.pull',
  push: 'failure.operation.push',
  publishBranch: 'failure.operation.publish',
  publishRepo: 'failure.operation.publish',
} as const

/** The failed operation's whole output, selectable, with Copy. */
function LogView({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation(['git', 'common'])
  const failed = useGitStore((s) => s.failed[projectPath] ?? null)
  const log = failed?.log ?? ''
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('dialog.log.title', { operation: t(LOG_TITLE[failed?.kind ?? 'push']) })}
        </DialogTitle>
      </DialogHeader>
      <pre
        data-selectable=""
        className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {log || t('dialog.log.empty')}
      </pre>
      <DialogFooter>
        <Button variant="outline" onClick={() => void navigator.clipboard.writeText(log)}>
          {t('dialog.log.copy')}
        </Button>
        <DialogClose render={<Button />}>{t('common:actions.close')}</DialogClose>
      </DialogFooter>
    </>
  )
}
