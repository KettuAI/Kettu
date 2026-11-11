import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_BRANCH_TEMPLATE, type ProjectWorktreeSettings } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { useWorktreeSettings } from './worktree-settings-model'

/**
 * A project's worktree settings: how new worktrees' branches are named and how they are
 * prepared. Mounted once for the window.
 */
export function WorktreeSettingsDialog() {
  const shown = useWorktreeSettings((s) => s.shown)
  // The last project stays drawn while the dialog closes.
  const [drawn, setDrawn] = useState(shown)
  if (shown && shown !== drawn) setDrawn(shown)
  const close = () => useWorktreeSettings.setState({ shown: null })
  return (
    <Dialog open={shown !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-120">
        {drawn && (
          <SettingsForm
            key={drawn.id}
            projectPath={drawn.path}
            projectName={drawn.name}
            onClose={close}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

type Field = 'branch' | 'copy' | 'setup'

/** Which field the host's `invalid_params` message is about, by the name it starts with. */
function fieldOf(message: string): Field | null {
  if (message.startsWith('copy')) return 'copy'
  if (message.startsWith('setup')) return 'setup'
  if (message.startsWith('branch') || /branch|ref/i.test(message)) return 'branch'
  return null
}

function SettingsForm({
  projectPath,
  projectName,
  onClose,
}: {
  projectPath: string
  projectName: string
  onClose: () => void
}) {
  const { t } = useTranslation(['sidebar', 'common'])
  const id = useId()
  const [loaded, setLoaded] = useState<ProjectWorktreeSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [template, setTemplate] = useState('')
  const [copy, setCopy] = useState('')
  const [setup, setSetup] = useState('')
  const [wait, setWait] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ field: Field | null; message: string } | null>(null)
  // A paired device changes these only while the host lets it use the terminal.
  const remote = hostOfPath(projectPath) !== null
  const allowed = useTerminalAllowed(projectPath) || !remote

  useEffect(() => {
    let live = true
    host('projects.worktreeSettings', { path: projectPath }).then(
      (settings) => {
        if (!live) return
        setLoaded(settings)
        setTemplate(settings.branchTemplate)
        setCopy(settings.copy.join('\n'))
        setSetup(settings.setup ?? '')
        setWait(settings.waitForSetup)
      },
      (failure: unknown) => live && setLoadError(errorMessage(failure)),
    )
    return () => {
      live = false
    }
  }, [projectPath, attempt])

  const save = async () => {
    if (!loaded || saving) return
    setSaving(true)
    setError(null)
    const settings: ProjectWorktreeSettings = {
      branchTemplate: template.trim() || DEFAULT_BRANCH_TEMPLATE,
      copy: [
        ...new Set(
          copy
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ],
      setup: setup.trim() === '' ? null : setup.trim(),
      waitForSetup: wait,
    }
    try {
      await host('projects.setWorktreeSettings', { path: projectPath, settings })
      onClose()
    } catch (failure) {
      const code = errorCode(failure)
      const message = errorMessage(failure)
      setError(
        code === 'forbidden'
          ? { field: null, message: t('worktreeSettings.forbidden') }
          : code === 'invalid_params'
            ? { field: fieldOf(message), message }
            : { field: null, message },
      )
    } finally {
      setSaving(false)
    }
  }

  const fieldError = (field: Field) =>
    error?.field === field && (
      <p role="alert" className="mt-1.5 text-small leading-normal text-danger">
        {error.message}
      </p>
    )
  const disabled = !loaded || !allowed || saving

  return (
    <form
      className="contents"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void save()
      }}
    >
      <DialogHeader className="px-5.5 pt-5">
        <DialogTitle className="truncate">
          {t('worktreeSettings.title', { project: projectName })}
        </DialogTitle>
        <DialogDescription className="text-small text-tertiary">
          {t('worktreeSettings.description')}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col px-5.5 pt-1.5">
        {loadError !== null ? (
          <div className="mt-3 flex items-start gap-3">
            <p role="alert" className="flex-1 text-small leading-normal text-danger">
              {loadError}
            </p>
            <Button
              type="button"
              variant="outline"
              size="compact"
              onClick={() => {
                setLoadError(null)
                setAttempt((n) => n + 1)
              }}
            >
              {t('common:actions.retry')}
            </Button>
          </div>
        ) : loaded === null ? (
          <div aria-busy className="flex flex-col gap-2.5 py-3">
            <Skeleton className="h-3.5 w-1/4" />
            <Skeleton className="h-8.5 w-full" />
            <Skeleton className="h-3.5 w-1/4" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-3.5 w-1/4" />
            <Skeleton className="h-8.5 w-full" />
          </div>
        ) : (
          <>
            {!allowed && (
              <p className="mt-3 rounded-[10px] bg-(--shell-chip) px-3 py-2.5 text-control leading-normal text-secondary">
                {t('worktreeSettings.forbidden')}
              </p>
            )}
            <Label htmlFor={`${id}-branch`}>{t('worktreeSettings.branch')}</Label>
            <Input
              id={`${id}-branch`}
              value={template}
              autoFocus
              disabled={disabled}
              placeholder={DEFAULT_BRANCH_TEMPLATE}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error?.field === 'branch' || undefined}
              className="h-8.5 font-mono text-code"
              onChange={(event) => setTemplate(event.target.value)}
            />
            <Hint>{t('worktreeSettings.branchHint')}</Hint>
            {fieldError('branch')}

            <Label htmlFor={`${id}-copy`}>{t('worktreeSettings.copy')}</Label>
            <Textarea
              id={`${id}-copy`}
              value={copy}
              rows={3}
              disabled={disabled}
              placeholder=".env"
              spellCheck={false}
              aria-invalid={error?.field === 'copy' || undefined}
              className="max-h-40 min-h-18 resize-none font-mono text-code leading-[1.55]"
              onChange={(event) => setCopy(event.target.value)}
            />
            <Hint>{t('worktreeSettings.copyHint')}</Hint>
            {fieldError('copy')}

            <Label htmlFor={`${id}-setup`}>{t('worktreeSettings.setup')}</Label>
            <Textarea
              id={`${id}-setup`}
              value={setup}
              rows={2}
              disabled={disabled}
              placeholder="pnpm install"
              spellCheck={false}
              aria-invalid={error?.field === 'setup' || undefined}
              className="max-h-32 min-h-13 resize-none font-mono text-code leading-[1.55]"
              onChange={(event) => setSetup(event.target.value)}
            />
            <Hint>{t('worktreeSettings.setupHint')}</Hint>
            {fieldError('setup')}

            <label className="mt-4 flex items-center gap-3 text-control text-primary">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t('worktreeSettings.wait')}</span>
                <span className="block text-small text-tertiary">
                  {t('worktreeSettings.waitHint')}
                </span>
              </span>
              <Switch checked={wait} disabled={disabled} onCheckedChange={setWait} />
            </label>

            {error !== null && error.field === null && (
              <p role="alert" className="mt-3 text-small leading-normal text-danger">
                {error.message}
              </p>
            )}
          </>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-5.5 py-4.5 *:data-[slot=button]:h-7.5">
        <DialogClose render={<Button type="button" variant="outline" size="compact" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <Button type="submit" size="compact" disabled={disabled}>
          {saving && <Spinner data-icon="inline-start" />}
          {t('worktreeSettings.save')}
        </Button>
      </div>
    </form>
  )
}

function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mt-4 mb-1.5 text-control font-medium text-primary">
      {children}
    </label>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-small leading-normal text-tertiary">{children}</p>
}
