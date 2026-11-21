import { useEffect, useState } from 'react'
import { ArrowLeft02Icon, GitBranchIcon, SparklesIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { GitStatus } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
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
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import {
  clearPullRequestForm,
  createPullRequest,
  EMPTY_PULL_REQUEST_FORM,
  runGitOperation,
  setGitPaneTab,
  updatePullRequestForm,
  useGitStore,
  type PullRequestForm,
} from '@renderer/stores/git'
import { pushRequest, showCreatedPr } from '../steps'
import { lastLine, pullRequestHead, pushTargetOf } from '../sync'
import { Field, PAGE_PAD } from './pane-ui'

/**
 * The pull request to open from this branch, in the pane in place of one. The agent's small model
 * drafts its title and description from the branch's commits; what the user typed is kept.
 */
export function CreatePullRequest({ status, panel }: { status: GitStatus; panel: string }) {
  const { t } = useTranslation(['git', 'common'])
  const { projectPath } = status
  const form = useGitStore((s) => s.pullRequestForm[projectPath] ?? EMPTY_PULL_REQUEST_FORM)
  const target = pushTargetOf(status)
  const headBranch = target?.branch ?? status.head.branch ?? ''
  const base = form.base ?? status.defaultBranch ?? ''
  const [branches, setBranches] = useState<string[]>([])
  const { drafting, draftError } = form
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  // Once for each base the user looks at; a text typed meanwhile stays.
  useEffect(() => {
    const now = useGitStore.getState().pullRequestForm[projectPath] ?? EMPTY_PULL_REQUEST_FORM
    if (base === '' || base === headBranch || now.draftedFor === base) return
    updatePullRequestForm(projectPath, { draftedFor: base, drafting: true, draftError: null })
    // The form lives in the store, so a draft that lands after the page was left still shows.
    const current = (): PullRequestForm | null => {
      const form = useGitStore.getState().pullRequestForm[projectPath]
      return form?.draftedFor === base ? form : null
    }
    host('git.pullRequestDraft', { projectPath, base }).then(
      (draft) => {
        const typed = current()
        if (!typed) return
        updatePullRequestForm(projectPath, {
          ...(typed.titleEdited ? {} : { title: draft.title }),
          ...(typed.bodyEdited ? {} : { body: draft.body }),
          drafting: false,
        })
      },
      (failure: unknown) => {
        if (current()) {
          updatePullRequestForm(projectPath, { drafting: false, draftError: errorMessage(failure) })
        }
      },
    )
  }, [projectPath, base, headBranch])

  // Unpublished, or with commits the remote does not have yet, it is pushed before it is opened.
  const pushesFirst = !!target && (target.setUpstream || (status.upstream?.ahead ?? 0) > 0)
  const valid =
    target !== null && form.title.trim() !== '' && base.trim() !== '' && base !== headBranch
  const choices = [...new Set([base, ...branches.filter((b) => b !== headBranch)])].filter(Boolean)
  const drafted = form.draftedFor === base && !drafting && draftError === null

  const submit = async (): Promise<void> => {
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
        title: form.title.trim(),
        body: form.body,
        base: base.trim(),
        draft: form.draft,
      })
      clearPullRequestForm(projectPath)
      showCreatedPr(projectPath, pr.number)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={PAGE_PAD}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="rounded-xl bg-card p-3 shadow-outline">
        <div className="flex items-center gap-2 text-control text-secondary">
          <Select
            value={base}
            items={choices.map((name) => ({ value: name, label: name }))}
            onValueChange={(next) =>
              next && updatePullRequestForm(projectPath, { base: next as string })
            }
          >
            <SelectTrigger
              aria-label={t('dialog.createPr.base')}
              variant="quiet"
              size="sm"
              className="gap-1.5 rounded-xl px-2.5 text-control font-medium text-primary data-[size=sm]:h-6.5 data-[variant=quiet]:bg-subtle [&>svg:last-child]:hidden"
            >
              <Glyph icon={GitBranchIcon} className="size-3.25" />
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
          <Glyph icon={ArrowLeft02Icon} className="size-3.5 shrink-0 text-tertiary" />
          <span className="min-w-0 truncate font-mono text-command text-primary">{headBranch}</span>
          <span className="flex-1" />
          <span className="inline-flex shrink-0 items-center gap-1 text-hint text-tertiary">
            {drafting ? (
              <>
                <Spinner className="size-3" />
                {t('pane.pr.drafting')}
              </>
            ) : (
              drafted && (
                <>
                  <Glyph icon={SparklesIcon} size={12} />
                  {t('pane.pr.drafted')}
                </>
              )
            )}
          </span>
        </div>
        <Field label={t('dialog.createPr.titleField')} htmlFor="pr-title">
          <Input
            id="pr-title"
            value={form.title}
            placeholder={drafting ? t('pane.pr.drafting') : undefined}
            className="h-8.5 text-control"
            onChange={(event) =>
              updatePullRequestForm(projectPath, { title: event.target.value, titleEdited: true })
            }
          />
        </Field>
        <Field label={t('dialog.createPr.body')} htmlFor="pr-body">
          <Textarea
            id="pr-body"
            value={form.body}
            rows={6}
            placeholder={drafting ? t('pane.pr.drafting') : undefined}
            className="max-h-72 min-h-32 resize-none text-control leading-[1.55]"
            onChange={(event) =>
              updatePullRequestForm(projectPath, { body: event.target.value, bodyEdited: true })
            }
          />
        </Field>
        {draftError !== null && (
          <p
            className="mt-2 text-small leading-normal text-tertiary [overflow-wrap:anywhere]"
            title={draftError}
          >
            {lastLine(draftError)}
          </p>
        )}
        <label className="mt-3 flex items-center gap-2.25 text-control text-primary">
          <Checkbox
            checked={form.draft}
            onCheckedChange={(on) => updatePullRequestForm(projectPath, { draft: on })}
          />
          {t('dialog.createPr.draft')}
        </label>
        {error !== null && (
          <p
            role="alert"
            title={error}
            className="mt-3 text-small leading-normal text-danger [overflow-wrap:anywhere]"
          >
            {lastLine(error)}
          </p>
        )}
        <div className="mt-3.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-hint text-tertiary">
            {pushesFirst ? t('dialog.createPr.pushesFirst') : ''}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              clearPullRequestForm(projectPath)
              setGitPaneTab(panel, 'changes')
            }}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!valid || busy}>
            {busy && <Spinner data-icon="inline-start" />}
            {t('dialog.createPr.action')}
          </Button>
        </div>
      </div>
    </form>
  )
}
