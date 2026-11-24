// Workflows in the Marketplace's directory: their rows, the workflow tab's three groups, their section on
// Installed, and adding one from a GitHub file or a .yaml file. They come from the host's workflow
// library, not the catalogs, but for the Community group's listings not added yet.

import {
  Fragment,
  useId,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react'
import { File02Icon, GithubIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { stepName, type WireWorkflowEntry } from '@shared/workflow'
import { EmptyState, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { SetButton } from '@renderer/features/settings/controls'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from '@renderer/features/settings/settings-dialog'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { busyKey } from '@renderer/stores/marketplace'
import { openMarketplace, type MarketplaceTab } from '@renderer/stores/view'
import { useBusy } from './hooks'
import { itemKey } from './model'
import {
  addCommunityWorkflow,
  addWorkflowFile,
  retryWorkflows,
  showAdded,
  useWorkflowStanding,
  useWorkflows,
} from './workflow-actions'
import {
  InstalledCheck,
  ItemRow,
  KettuMark,
  KindTag,
  QuietNote,
  SkeletonRows,
  StepsCount,
  StepsLine,
} from './rows'
import {
  flowGroups,
  githubRepo,
  isWorkflowFileUrl,
  kettuPublisher,
  listingOrigin,
  waitsForYou,
  workflowDescription,
  workflowGroup,
  workflowMatches,
  workflowName,
  workflowState,
  type WorkflowGroup,
  type WorkflowState,
} from './workflow-model'
import { workflowSubject } from './tile-art'
import { PlainTile } from './tiles'
import { PluginByline } from './plugin-ui'

/**
 * Who a workflow comes from, after its name: a publisher of the Kettu Marketplace, with the Kettu
 * mark for Kettu's own, a repository's owner, a file, an agent or you.
 */
export function WorkflowByline({ entry }: { entry: WireWorkflowEntry }) {
  const { t } = useTranslation('marketplace')
  const origin = entry.origin
  const kettu = kettuPublisher(entry)
  if (kettu) {
    return (
      <>
        <span className="k-workflow-by">{kettu}</span>
        <KettuMark />
      </>
    )
  }
  if (origin?.kind === 'plugin') return <PluginByline origin={origin} />
  const text =
    origin?.kind === 'community'
      ? t('workflow.by.community', { handle: origin.handle })
      : origin?.kind === 'github'
        ? t('workflow.by.github', { owner: githubRepo(origin.url)?.split('/')[0] ?? 'GitHub' })
        : entry.source === 'file'
          ? t('workflow.by.file')
          : entry.source === 'agent'
            ? t('workflow.by.agent')
            : t('workflow.by.you')
  return <span className="k-workflow-by">{text}</span>
}

/** What keeps a workflow from starting tasks, as a pill at its row's end or its page's top. */
export function WorkflowStateBadge({ state }: { state: Exclude<WorkflowState, 'ready'> }) {
  const { t } = useTranslation('marketplace')
  return (
    <span
      className="k-workflow-state"
      data-tone={state === 'pending' || state === 'changed' ? 'wait' : 'bad'}
      title={t(`workflow.stateTitle.${state}`)}
    >
      {t(`workflow.state.${state}`)}
    </span>
  )
}

/** The line of a workflow whose file does not read: why. */
function rowLine(entry: WireWorkflowEntry): string | null {
  return entry.problems[0]?.message ?? null
}

export function WorkflowRow({
  entry,
  tab,
  fresh,
  card,
}: {
  entry: WireWorkflowEntry
  tab: MarketplaceTab
  fresh?: boolean
  card?: boolean
}) {
  const { t, i18n } = useTranslation('marketplace')
  const locale = i18n.language
  const name = workflowName(entry, locale)
  const state = workflowState(entry)
  const workflow = entry.workflow
  const { update, takenDown } = useWorkflowStanding(entry)
  const open = () => openMarketplace({ item: itemKey({ kind: 'workflow', id: entry.id }), tab })
  const standing = update
    ? t('workflow.newVersion', { version: update })
    : takenDown
      ? t('community.takenDownLine')
      : null
  return (
    <ItemRow
      title={name}
      subject={workflowSubject(entry)}
      meta={
        <>
          <KindTag kind="workflow" />
          <span className="k-mkt-publisher">
            <WorkflowByline entry={entry} />
          </span>
          {workflow && <StepsCount count={workflow.steps.length} />}
        </>
      }
      line={
        [standing, workflow ? workflowDescription(entry, locale) : rowLine(entry)]
          .filter(Boolean)
          .join(' · ') || null
      }
      extra={
        workflow ? (
          <StepsLine
            names={flowGroups(workflow).map((group) =>
              group.map((step) => stepName(workflow, step.id, locale)).join(' + '),
            )}
            waits={flowGroups(workflow)
              .filter((group) => group.some(waitsForYou))
              .map((group) => group.map((step) => stepName(workflow, step.id, locale)).join(' + '))}
          />
        ) : undefined
      }
      fresh={fresh}
      card={card}
      onOpen={open}
      end={
        update ? (
          <WorkflowUpdateButton entry={entry} name={name} tab={tab} size="md" />
        ) : state === 'ready' ? (
          <InstalledCheck name={name} onOpen={open} />
        ) : (
          <WorkflowStateBadge state={state} />
        )
      }
    />
  )
}

/** Update: the listing's newer version replaces the file, and waits for approval at once. */
export function WorkflowUpdateButton({
  entry,
  name,
  tab,
  size,
  version,
}: {
  entry: WireWorkflowEntry
  name: string
  tab: MarketplaceTab
  size?: 'md'
  /** Named on the button, as a listing's page names it. */
  version?: string
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const listingId = listingOrigin(entry)?.listingId ?? ''
  const busy = useBusy(busyKey('community', listingId))
  return (
    <Button
      size={size}
      variant={size ? 'secondary' : 'primary'}
      loading={busy}
      aria-label={t('row.action', { action: t('workflow.update.button'), name })}
      onClick={() =>
        !busy && void addCommunityWorkflow(scope, { id: listingId, name }, { update: true, tab })
      }
    >
      {busy
        ? t('community.updating')
        : version
          ? t('community.update', { version })
          : t('workflow.update.button')}
    </Button>
  )
}

const GROUPS: readonly WorkflowGroup[] = ['community', 'added', 'yours']

/**
 * The workflow tab: what a workflow is, then Community, Added from GitHub and Yours.
 * `community` is the Community group, drawn by the directory since it pages through the Kettu
 * Marketplace; null when it has nothing to show for the query.
 */
export function WorkflowSections({
  query,
  community,
}: {
  query: string
  community: ReactNode | null
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { entries, loaded, error } = useWorkflows()
  const locale = currentLocale()
  const searching = query.trim() !== ''
  const [adding, setAdding] = useState(false)

  if (!loaded) {
    return (
      <>
        <p className="k-workflow-intro">{t('workflow.intro')}</p>
        {GROUPS.filter((group) => group !== 'community').map((group) => (
          <section key={group} className="ui-as-int-section" aria-busy>
            <h2 className="ui-as-int-section__title">{t(`workflow.groups.${group}`)}</h2>
            <SkeletonRows rows={2} />
          </section>
        ))}
      </>
    )
  }
  const shown = entries.filter((entry) => workflowMatches(entry, query, locale))
  const note = error && (
    <div className="k-mkt-notes">
      <QuietNote action={<RetryButton onRetry={() => retryWorkflows(scope)} />}>
        {t('workflow.readFailed', { error })}
      </QuietNote>
    </div>
  )
  if (searching && shown.length === 0 && !community) {
    return (
      <>
        {note}
        <div className="ui-as-rise ui-as-int-empty">
          <EmptyState title={t('search.noneTitle')} text={t('search.none', { query })} />
        </div>
      </>
    )
  }
  const added = shown.filter((entry) => workflowGroup(entry) === 'added')
  const title = (group: WorkflowGroup): string =>
    group === 'added' && added.some((entry) => entry.source === 'file')
      ? t('workflow.groups.addedOrFile')
      : t(`workflow.groups.${group}`)
  return (
    <>
      {!searching && <p className="k-workflow-intro">{t('workflow.intro')}</p>}
      {note}
      {GROUPS.map((group, index) => {
        if (group === 'community') return <Fragment key={group}>{community}</Fragment>
        const rows = shown.filter((entry) => workflowGroup(entry) === group)
        if (searching && rows.length === 0) return null
        return (
          <section
            key={group}
            className="ui-as-int-section ui-as-rise"
            style={{ '--i': index } as CSSProperties}
          >
            <h2 className="ui-as-int-section__title">{title(group)}</h2>
            {rows.length === 0 && group === 'yours' && (
              <p className="k-mkt-section-note">{t('workflow.yoursEmpty')}</p>
            )}
            {(rows.length > 0 || group === 'added') && (
              <div className="ui-as-int-grid">
                {rows.map((entry) => (
                  <WorkflowRow key={entry.id} entry={entry} tab="workflow" />
                ))}
                {group === 'added' && !searching && (
                  <AddWorkflowRow onAdd={() => setAdding(true)} />
                )}
              </div>
            )}
          </section>
        )
      })}
      <AddWorkflowDialog open={adding} onOpenChange={setAdding} />
    </>
  )
}

/** The last row of Added from GitHub: where a workflow someone shared comes in. */
function AddWorkflowRow({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation('marketplace')
  return (
    <ItemRow
      title={t('workflow.add.rowTitle')}
      icon={
        <PlainTile>
          <Icon icon={GithubIcon} />
        </PlainTile>
      }
      line={t('workflow.add.rowLine')}
      end={
        <Button size="md" variant="secondary" onClick={onAdd}>
          {t('workflow.add.rowButton')}
        </Button>
      }
    />
  )
}

/** Installed's workflow section: every workflow the host keeps. */
export function InstalledWorkflows({ query, index }: { query: string; index: number }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { entries, loaded, error } = useWorkflows()
  const locale = currentLocale()
  const shown = entries.filter((entry) => workflowMatches(entry, query, locale))
  if (loaded && query.trim() && shown.length === 0) return null
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': index } as CSSProperties}>
      <h2 className="ui-as-int-section__title">
        {t('installed.workflows')}
        {shown.length > 0 && <span className="k-mkt-count">{shown.length}</span>}
      </h2>
      {!loaded ? (
        <SkeletonRows rows={2} />
      ) : error && entries.length === 0 ? (
        <QuietNote action={<RetryButton onRetry={() => retryWorkflows(scope)} />}>
          {t('workflow.readFailed', { error })}
        </QuietNote>
      ) : entries.length === 0 ? (
        <p className="k-mkt-section-note">{t('installed.noWorkflows')}</p>
      ) : (
        <div className="ui-as-int-grid">
          {shown.map((entry) => (
            <WorkflowRow key={entry.id} entry={entry} tab="installed" />
          ))}
        </div>
      )}
    </section>
  )
}

function RetryButton({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useTranslation('common')
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="md"
      variant="ghost"
      loading={busy}
      onClick={() => {
        setBusy(true)
        void onRetry().finally(() => setBusy(false))
      }}
    >
      {t('actions.retry')}
    </Button>
  )
}

export function AddWorkflowDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && <AddWorkflowForm onDone={() => onOpenChange(false)} />}
      </SettingsDialogContent>
    </Dialog>
  )
}

function AddWorkflowForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const id = useId()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'url' | 'file' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trimmed = url.trim()
  const ready = isWorkflowFileUrl(trimmed)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy('url')
    setError(null)
    try {
      const entry = await scope.request('workflows.add', { kind: 'url', url: trimmed })
      await showAdded(scope, entry)
      onDone()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(null)
    }
  }
  const chooseFile = async () => {
    setBusy('file')
    setError(null)
    const result = await addWorkflowFile(scope)
    setBusy(null)
    if (typeof result === 'object') setError(result.error)
    else if (result === 'added') onDone()
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('workflow.add.title')}>
        {t('workflow.add.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField
          label={t('workflow.add.url')}
          htmlFor={`${id}-url`}
          hint={trimmed && !ready ? t('workflow.add.urlInvalid') : t('workflow.add.urlHint')}
        >
          <input
            id={`${id}-url`}
            className={DIALOG_MONO_FIELD}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            inputMode="url"
            aria-invalid={trimmed && !ready ? true : undefined}
            placeholder={t('workflow.add.urlPlaceholder')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </SettingsField>
        {error && (
          <p role="alert" className="k-mkt-error" data-selectable="">
            {t('workflow.add.failed', { error })}
          </p>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          <SetButton
            size="md"
            variant="ghost"
            icon={<Icon icon={File02Icon} size={14} />}
            loading={busy === 'file'}
            disabled={busy !== null}
            onClick={() => void chooseFile()}
          >
            {t('workflow.add.chooseFile')}
          </SetButton>
        }
      >
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton
          size="md"
          variant="primary"
          type="submit"
          loading={busy === 'url'}
          disabled={!ready || busy !== null}
        >
          {t('workflow.add.submit')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}
