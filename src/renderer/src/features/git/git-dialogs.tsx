import { useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { CheckIcon, GlobeIcon, LockIcon } from 'lucide-react'
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@renderer/components/ui/field'
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

type ReturnFocus = RefObject<HTMLElement | null>

/**
 * The branch popover's dialogs, kept outside it so the popover can close under them. The popover's
 * button is gone when one closes, so focus goes back to `returnFocus`.
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
  return (
    <>
      <ConfirmPushDialog
        status={status}
        dialog={dialog}
        returnFocus={returnFocus}
        onClose={close}
      />
      <Dialog open={dialog?.kind === 'publishRepo'} onOpenChange={(open) => !open && close()}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false}>
          {dialog?.kind === 'publishRepo' && <PublishForm status={status} onClose={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === 'createPr'} onOpenChange={(open) => !open && close()}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false} className="sm:max-w-115">
          {dialog?.kind === 'createPr' && <CreatePrForm status={status} onClose={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === 'log'} onOpenChange={(open) => !open && close()}>
        <DialogContent finalFocus={returnFocus} showCloseButton={false} className="sm:max-w-160">
          {dialog?.kind === 'log' && <LogView projectPath={status.projectPath} />}
        </DialogContent>
      </Dialog>
    </>
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

/** Settings under the fields, one per row: the label and a line about it, the control at the end. */
function Rows({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-subtle border-t border-subtle">{children}</div>
  )
}

function Row({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string
  description?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <Field
      orientation="horizontal"
      className="min-h-12 gap-4 py-1.5 has-[>[data-slot=field-content]]:items-center"
    >
      <FieldContent>
        <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
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
            components={{ branch: <span className="font-mono text-command text-primary" /> }}
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
          className="max-h-60"
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <Rows>
        <Row label={t('dialog.createPr.base')} htmlFor="pr-base">
          <Input
            id="pr-base"
            value={base}
            spellCheck={false}
            className="w-40 shrink-0 font-mono text-command"
            onChange={(e) => setBase(e.target.value.trim())}
          />
        </Row>
        <Row
          label={t('dialog.createPr.draft')}
          description={t('dialog.createPr.draftHint')}
          htmlFor="pr-draft"
        >
          <Switch id="pr-draft" checked={draft} onCheckedChange={setDraft} />
        </Row>
      </Rows>
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
    <p className="text-xs leading-normal text-danger [overflow-wrap:anywhere]" title={log}>
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
