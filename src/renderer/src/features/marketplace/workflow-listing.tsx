// A workflow's page: what it is for, its flow, each step with who does it, what it lets agents do,
// and its file; the approval for one the user has not approved, or that changed since, and Update
// for one from the Kettu Marketplace whose listing has a newer version.

import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  CommandLineIcon,
  Delete02Icon,
  Flag02Icon,
  MoreHorizontalIcon,
  PlugSocketIcon,
  RefreshIcon,
  SparklesIcon,
  Tick02Icon,
  UndoIcon,
  UserCheck01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  LEGACY_OFFICIAL,
  outcomeName,
  stepName,
  type Workflow,
  type WireWorkflowEntry,
  type WorkflowStep,
  type StepPick,
} from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { IconAction } from '@renderer/features/settings/controls'
import { PlaceAction } from '@renderer/features/settings/places'
import { splitName } from '@renderer/features/session/composer/levels'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { mediumAgo } from '@renderer/lib/format'
import { errorCode, errorMessage } from '@renderer/lib/host'
import { optionsOn, picksOf, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { AGENT_NAMES, agentName } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession, openSettings, type MarketplaceTab } from '@renderer/stores/view'
import { ConfirmDialog } from './dialogs'
import { homeShort } from './model'
import { ExternalLink, ListingFrame, ListingSkeleton } from './parts'
import { ReportDialog } from './report-dialog'
import { KettuMark, KindTag } from './rows'
import {
  awaitsApproval,
  backArrowsOf,
  flowLine,
  githubPage,
  githubRepo,
  kettuPublisher,
  listingOrigin,
  missingTools,
  outcomeTarget,
  pinNames,
  pinOf,
  pinValues,
  runsSteps,
  workflowDescription,
  workflowGroup,
  workflowName,
  workflowState,
  workflowTools,
  waitsForYou,
} from './workflow-model'
import { retryWorkflows, useWorkflowStanding, useWorkflows } from './workflow-actions'
import { FlowChart } from './workflow-flow'
import { WorkflowByline, WorkflowRow, WorkflowStateBadge, WorkflowUpdateButton } from './workflows'
import { workflowSubject } from './tile-art'
import { ItemTile } from './tiles'
import { FromPluginOrigin } from './plugin-ui'

/** Other workflows of its group shown under a page. */
const RELATED = 4

export function WorkflowListing({
  id,
  tab,
  back,
}: {
  id: string
  tab: MarketplaceTab
  back: () => void
}) {
  const { t, i18n } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const { entries, loaded, error } = useWorkflows()
  const entry = entries.find((e) => e.id === id) ?? null
  const locale = i18n.language

  if (!entry) {
    return (
      <ListingFrame back={back}>
        {!loaded ? (
          <ListingSkeleton />
        ) : (
          <div className="ui-as-empty">
            <b className="ui-as-empty__title">
              {error ? t('workflow.readFailedTitle') : t('workflow.missingTitle')}
            </b>
            <p className="ui-as-empty__text">
              {error ? t('workflow.readFailed', { error }) : t('workflow.missingText')}
            </p>
            <Button
              size="md"
              variant="secondary"
              onClick={error ? () => void retryWorkflows(scope) : back}
            >
              {error ? t('common:actions.retry') : t('listing.backToDirectory')}
            </Button>
          </div>
        )}
      </ListingFrame>
    )
  }

  const workflow = entry.workflow
  const state = workflowState(entry)
  const listed = listingOrigin(entry)
  const kettu = kettuPublisher(entry)
  const name = workflowName(entry, locale)
  const description = workflowDescription(entry, locale)
  const related = entries
    .filter((e) => e.id !== entry.id && workflowGroup(e) === workflowGroup(entry))
    .slice(0, RELATED)
  return (
    <ListingFrame back={back} rise>
      <header className="k-mkt-head">
        <ItemTile subject={workflowSubject(entry)} size="big" />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>{name}</h1>
            <KindTag kind="workflow" />
          </span>
          <span className="k-mkt-head__pub">
            {kettu ? (
              <>
                {kettu}
                <KettuMark />
                <span className="k-mkt-head__trust">{t('listing.official')}</span>
              </>
            ) : listed ? (
              <>
                {listed.handle}
                <span className="k-mkt-head__trust">{t('community.trust')}</span>
              </>
            ) : (
              <>
                {t('workflow.yours')}
                <span className="k-mkt-head__trust">
                  <WorkflowByline entry={entry} />
                </span>
              </>
            )}
          </span>
          {workflow && <span className="k-mkt-head__line">{flowLine(workflow, locale)}</span>}
        </span>
        <span className="k-mkt-head__act">
          <HeadUpdate entry={entry} name={name} tab={tab} />
          {state === 'ready' ? (
            <span className="k-mkt-head__on">
              <Icon icon={Tick02Icon} size={14} />
              {t('listing.installed')}
            </span>
          ) : (
            <WorkflowStateBadge state={state} />
          )}
          <WorkflowMenu entry={entry} name={name} onRemoved={back} />
        </span>
      </header>

      {entry.problems.length > 0 && <Problems entry={entry} />}
      {workflow && awaitsApproval(entry) && <Approval entry={entry} name={name} onRemoved={back} />}

      <Facts entry={entry} />

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          {description && <p className="k-mkt-about">{description}</p>}
          {workflow && <Flow workflow={workflow} pins={entry.pins} />}
          {workflow && <Steps entry={entry} workflow={workflow} />}
          {workflow && <Needs workflow={workflow} pending={awaitsApproval(entry)} />}
          {!(workflow && awaitsApproval(entry)) && <FileSection entry={entry} open={!workflow} />}
        </div>
        <Side entry={entry} workflow={workflow} />
      </div>

      {related.length > 0 && (
        <section className="ui-as-int-section">
          <h2 className="ui-as-int-section__title">
            {t(`workflow.related.${workflowGroup(entry)}`)}
          </h2>
          <div className="ui-as-int-grid">
            {related.map((other) => (
              <WorkflowRow key={other.id} entry={other} tab={tab} />
            ))}
          </div>
        </section>
      )}
    </ListingFrame>
  )
}

/** Update, while the listing a workflow came from has a newer version than the one added. */
function HeadUpdate({
  entry,
  name,
  tab,
}: {
  entry: WireWorkflowEntry
  name: string
  tab: MarketplaceTab
}) {
  const { update } = useWorkflowStanding(entry)
  if (!update) return null
  return <WorkflowUpdateButton entry={entry} name={name} tab={tab} version={update} />
}

/** Check for update on a GitHub workflow, and Delete on any of the user's. */
function WorkflowMenu({
  entry,
  name,
  onRemoved,
}: {
  entry: WireWorkflowEntry
  name: string
  onRemoved: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [removing, setRemoving] = useState(false)
  const [checking, setChecking] = useState(false)
  // An older host's own workflows are neither removed nor updated.
  if (entry.source === LEGACY_OFFICIAL) return null
  // A plugin's workflow leaves with the plugin; the host refuses to remove it alone.
  if (entry.origin?.kind === 'plugin') return <FromPluginOrigin origin={entry.origin} />
  const check = async () => {
    setChecking(true)
    try {
      const { changed } = await scope.request('workflows.update', { workflowId: entry.id })
      await retryWorkflows(scope)
      toast(changed ? t('workflow.update.changed', { name }) : t('workflow.update.same', { name }))
    } catch (error) {
      toast(t('workflow.update.failed', { name, error: errorMessage(error) }), undefined, {
        tone: 'warning',
      })
    } finally {
      setChecking(false)
    }
  }
  return (
    <>
      <Dropdown
        align="end"
        items={[
          ...(entry.origin?.kind === 'github'
            ? [
                {
                  label: checking ? t('workflow.update.checking') : t('workflow.update.check'),
                  icon: RefreshIcon,
                  disabled: checking,
                  onSelect: () => void check(),
                },
              ]
            : []),
          {
            label: t('workflow.remove.menu'),
            icon: Delete02Icon,
            danger: true,
            divider: entry.origin?.kind === 'github',
            onSelect: () => setRemoving(true),
          },
        ]}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className="k-mkt-icon-btn"
            aria-label={t('listing.more', { name })}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </button>
        )}
      />
      <RemoveDialog
        entry={entry}
        name={name}
        open={removing}
        onOpenChange={setRemoving}
        onRemoved={onRemoved}
      />
    </>
  )
}

function RemoveDialog({
  entry,
  name,
  open,
  onOpenChange,
  onRemoved,
}: {
  entry: WireWorkflowEntry
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoved: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('workflow.remove.title', { name })}
      body={t('workflow.remove.body')}
      confirm={t('workflow.remove.confirm')}
      action={async () => {
        await scope.request('workflows.remove', { workflowId: entry.id })
        onRemoved()
        await retryWorkflows(scope)
      }}
    />
  )
}

/** The file as the host read it, the hash an approval names with it. */
interface ReadFile {
  text: string | null
  hash: string
}

/** Reads the workflow's file; again when `key` changes, as the library says the file did. */
function useWorkflowFile(workflowId: string, key: string, enabled = true) {
  const scope = useHostScope()
  const [read, setRead] = useState<ReadFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let live = true
    scope
      .request('workflows.read', { workflowId })
      .then((result) => {
        if (!live) return
        setRead({ text: result.text, hash: result.entry.hash })
        setError(null)
      })
      .catch((failure: unknown) => {
        if (live) setError(errorMessage(failure))
      })
    return () => {
      live = false
    }
  }, [scope, workflowId, key, enabled, attempt])
  return { read, error, retry: () => setAttempt((n) => n + 1) }
}

/**
 * The approval of a workflow the user has not approved, or that changed since: what it is, its file
 * as read, Approve for that very file and Delete.
 */
function Approval({
  entry,
  name,
  onRemoved,
}: {
  entry: WireWorkflowEntry
  name: string
  onRemoved: () => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const { read, error, retry } = useWorkflowFile(entry.id, entry.hash)
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const origin = entry.origin
  const session = useSessionsStore((s) =>
    origin?.kind === 'agent' ? (s.byId[origin.sessionId] ?? null) : null,
  )

  const approve = async () => {
    setNotice(null)
    if (!read) {
      setNotice(t('workflow.approval.notRead'))
      throw new Error('not read')
    }
    try {
      await scope.request('workflows.approve', { workflowId: entry.id, hash: read.hash })
      await retryWorkflows(scope)
    } catch (failure) {
      // The file changed since it was shown: read it again, so what is approved is what is seen.
      if (errorCode(failure) === 'conflict') {
        setNotice(t('workflow.approval.changedWhileShown'))
        await retryWorkflows(scope)
        retry()
      } else {
        setNotice(t('workflow.approval.failed', { error: errorMessage(failure) }))
      }
      throw failure
    }
  }

  const title =
    entry.approval === 'changed'
      ? t('workflow.approval.changedTitle')
      : entry.source === 'agent'
        ? t('workflow.approval.agentTitle')
        : t('workflow.approval.title')
  const description: ReactNode =
    entry.approval === 'changed' ? (
      t('workflow.approval.changedText')
    ) : origin?.kind === 'agent' ? (
      <>
        {session ? (
          <>
            {t('workflow.approval.agentInBefore', {
              agent: agentName(origin.agentId, scope.hostId),
            })}
            <button
              type="button"
              className="k-mkt-link"
              onClick={() => openSession(session.id, session.projectPath)}
            >
              {session.title || t('workflow.approval.untitled')}
            </button>
            {t('workflow.approval.agentInAfter')}
          </>
        ) : (
          t('workflow.approval.agentText', { agent: agentName(origin.agentId, scope.hostId) })
        )}{' '}
        {t('workflow.approval.check')}
      </>
    ) : origin?.kind === 'community' ? (
      `${t('workflow.approval.communityText', { publisher: origin.handle, version: origin.version })} ${t('workflow.approval.check')}`
    ) : origin?.kind === 'github' ? (
      `${t('workflow.approval.githubText', { repo: githubRepo(origin.url) ?? 'GitHub' })} ${t('workflow.approval.check')}`
    ) : origin?.kind === 'file' ? (
      `${t('workflow.approval.fileText', { file: origin.name })} ${t('workflow.approval.check')}`
    ) : (
      `${t('workflow.approval.userText')} ${t('workflow.approval.check')}`
    )

  const missing = missingTools(entry)
  return (
    <div className="k-workflow-approve">
      <ApprovalCard
        title={title}
        description={
          missing.length > 0 ? (
            <>
              {description} {t('workflow.approval.missingTools', { tools: missing.join(', ') })}
            </>
          ) : (
            description
          )
        }
        icon={<Icon icon={UserCheck01Icon} size={16} />}
        status="pending"
        allowAlways={false}
        shortcuts={false}
        approveLabel={t('workflow.approval.approve')}
        denyLabel={t('workflow.approval.delete')}
        onApprove={approve}
        onDeny={() => setRemoving(true)}
        preview={
          <div className="k-workflow-approve__file">
            <span className="k-workflow-approve__head">
              <b>{t('workflow.file.title')}</b>
              <small>{t('workflow.approval.fileNote')}</small>
            </span>
            {error ? (
              <p className="k-mkt-error" role="alert">
                {t('workflow.file.failed', { error })}{' '}
                <button type="button" className="k-mkt-link" onClick={retry}>
                  {t('common:actions.retry')}
                </button>
              </p>
            ) : read ? (
              <FileText text={read.text} />
            ) : (
              <Skeleton className="k-workflow-file__skeleton" />
            )}
          </div>
        }
      />
      {notice && (
        <p className="k-workflow-approve__notice" role="alert">
          {notice}
        </p>
      )}
      <RemoveDialog
        entry={entry}
        name={name}
        open={removing}
        onOpenChange={setRemoving}
        onRemoved={onRemoved}
      />
    </div>
  )
}

function FileText({ text }: { text: string | null }) {
  const { t } = useTranslation('marketplace')
  if (text === null) return <p className="k-mkt-section-note">{t('workflow.file.gone')}</p>
  return (
    <pre className="k-workflow-file" data-selectable="" tabIndex={0}>
      {text}
    </pre>
  )
}

/** What the file has wrong, each where the host found it. */
function Problems({ entry }: { entry: WireWorkflowEntry }) {
  const { t, i18n } = useTranslation('marketplace')
  const where = (at: string): string | null => {
    if (!at) return null
    const step = /^steps\[(\d+)\]/.exec(at)
    const found = step && entry.workflow?.steps[Number(step[1])]
    return found ? `${at} · ${stepName(entry.workflow!, found.id, i18n.language)}` : at
  }
  return (
    <div className="k-workflow-problems" role="group" aria-label={t('workflow.problems.title')}>
      <b>
        {entry.workflow
          ? t('workflow.problems.title', { count: entry.problems.length })
          : t('workflow.problems.unreadable')}
      </b>
      <ul>
        {entry.problems.map((problem, i) => (
          <li key={i}>
            {where(problem.at) && <code className="k-mkt-mono">{where(problem.at)}</code>}
            <span data-selectable="">{problem.message}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Facts({ entry }: { entry: WireWorkflowEntry }) {
  const { t } = useTranslation('marketplace')
  const workflow = entry.workflow
  const origin = entry.origin
  const yours = workflow ? workflow.steps.filter(waitsForYou).length : 0
  const from =
    entry.source === LEGACY_OFFICIAL
      ? t('community.kettu')
      : origin?.kind === 'community'
        ? t('community.source')
        : origin?.kind === 'github'
          ? (githubRepo(origin.url) ?? 'GitHub')
          : origin?.kind === 'file'
            ? origin.name
            : origin?.kind === 'agent'
              ? t('workflow.from.agent', { agent: agentName(origin.agentId) })
              : t('workflow.from.you')
  const backs = workflow ? workflow.steps.flatMap((step) => backArrowsOf(workflow, step)) : []
  return (
    <div className="k-mkt-facts k-workflow-facts">
      <span>
        <small>{t('workflow.facts.runBy')}</small>
        <b className="k-mkt-facts__agents">
          <AgentMark agent="claude-code" size={15} />
          <AgentMark agent="codex" size={15} />
          <span className="k-mkt-facts__text">
            {t('more.two', { first: AGENT_NAMES['claude-code'], second: AGENT_NAMES.codex })}
          </span>
        </b>
      </span>
      <span>
        <small>{t('listing.facts.source')}</small>
        <b title={from}>{from}</b>
      </span>
      {origin?.kind === 'community' && (
        <span>
          <small>{t('listing.facts.version')}</small>
          <b className="k-mkt-mono">{origin.version}</b>
        </span>
      )}
      {entry.addedAt !== null && (
        <span>
          <small>{t('workflow.facts.added')}</small>
          <b>{mediumAgo(entry.addedAt)}</b>
        </span>
      )}
      {workflow && (
        <span>
          <small>{t('workflow.facts.steps')}</small>
          <b>
            {yours > 0
              ? t('workflow.facts.stepsWait', { steps: workflow.steps.length, count: yours })
              : workflow.steps.length}
          </b>
        </span>
      )}
      {workflow && backs.length > 0 && (
        <span>
          <small>{t('workflow.facts.sendBack')}</small>
          <b>{t('workflow.facts.sendBackLimit', { count: workflow.sendBackLimit })}</b>
        </span>
      )}
    </div>
  )
}

/** The flow as a chart, then in words what sends work back and what ends the task early. */
function Flow({ workflow, pins }: { workflow: Workflow; pins: Record<string, StepPick> }) {
  const { t, i18n } = useTranslation('marketplace')
  const locale = i18n.language
  const ends = new Set(workflow.steps.flatMap((step) => step.outcomes.map((o) => o.end)))
  const backs = workflow.steps.flatMap((step) =>
    backArrowsOf(workflow, step).map((outcome) => ({ step, outcome })),
  )
  return (
    <section>
      <h3>{t('workflow.flow.title')}</h3>
      <FlowChart workflow={workflow} pins={pins} />
      {(backs.length > 0 || ends.has('dropped')) && (
        <div className="k-mkt-list k-workflow-flow">
          <ul className="k-workflow-flow__notes">
            {backs.map(({ step, outcome }) => (
              <li key={`${step.id}:${outcome.name}`}>
                {t('workflow.flow.back', {
                  from: stepName(workflow, step.id, locale),
                  outcome: outcomeName(workflow, step.id, outcome.name, locale),
                  to: outcome.to.map((id) => stepName(workflow, id, locale)).join(' + '),
                  count: outcome.limit ?? workflow.sendBackLimit,
                })}
              </li>
            ))}
            {workflow.steps.flatMap((step) =>
              step.outcomes
                .filter((outcome) => outcome.end === 'dropped')
                .map((outcome) => (
                  <li key={`${step.id}:${outcome.name}:end`}>
                    {t('workflow.flow.dropped', {
                      from: stepName(workflow, step.id, locale),
                      outcome: outcomeName(workflow, step.id, outcome.name, locale),
                    })}
                  </li>
                )),
            )}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Each step: what it does and where its outcomes go, the words for whoever picks, who does it. */
function Steps({ entry, workflow }: { entry: WireWorkflowEntry; workflow: Workflow }) {
  const { t } = useTranslation('marketplace')
  return (
    <section>
      <h3 className="k-workflow-h3">
        {t('workflow.steps.title')}
        <button
          type="button"
          className="k-mkt-link k-workflow-h3__link"
          onClick={() => openSettings('agents')}
        >
          {t('workflow.steps.autoAgents')}
        </button>
      </h3>
      <div
        className="k-mkt-list k-workflow-steps"
        role="table"
        aria-label={t('workflow.steps.title')}
      >
        <div className="k-workflow-steps__row" role="row" data-head="">
          <span role="columnheader">{t('workflow.steps.step')}</span>
          <span role="columnheader">{t('workflow.steps.forPicker')}</span>
          <span role="columnheader">{t('workflow.steps.who')}</span>
        </div>
        {workflow.steps.map((step, index) => (
          <StepRow
            key={step.id}
            entry={entry}
            workflow={workflow}
            step={step}
            first={index === 0}
          />
        ))}
      </div>
    </section>
  )
}

function StepRow({
  entry,
  workflow,
  step,
  first,
}: {
  entry: WireWorkflowEntry
  workflow: Workflow
  step: WorkflowStep
  first: boolean
}) {
  const { t, i18n } = useTranslation('marketplace')
  const locale = i18n.language
  const [open, setOpen] = useState(false)
  const tools = [...step.tools.mcp, ...step.tools.skills]
  const prompt = step.prompt.trim()
  return (
    <div className="k-workflow-steps__row" role="row">
      <span role="cell" className="k-workflow-steps__node">
        <b>
          {stepName(workflow, step.id, locale)}
          {step.youReview && step.by === 'agent' && (
            <span className="k-workflow-you">{t('workflow.youReview')}</span>
          )}
        </b>
        <small className="k-workflow-steps__prompt" data-open={open || undefined}>
          <span data-selectable="">{prompt}</span>
          {prompt.length > 0 && (
            <button
              type="button"
              className="k-mkt-link"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? t('workflow.steps.less') : t('workflow.steps.more')}
            </button>
          )}
        </small>
        <ul className="k-workflow-steps__outcomes" aria-label={t('workflow.steps.outcomes')}>
          {step.outcomes.map((outcome) => {
            const target = outcomeTarget(workflow, outcome, locale)
            const back = backArrowsOf(workflow, step).includes(outcome)
            return (
              <li key={outcome.name}>
                <span>{outcomeName(workflow, step.id, outcome.name, locale)}</span>
                <Icon icon={back ? UndoIcon : ArrowRight01Icon} size={12} />
                <span>
                  {target.kind === 'end'
                    ? t(target.end === 'done' ? 'workflow.end.done' : 'workflow.end.dropped')
                    : target.names.join(' + ')}
                </span>
                {back && (
                  <span className="k-workflow-steps__limit">
                    {t('workflow.steps.upTo', { count: outcome.limit ?? workflow.sendBackLimit })}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </span>
      <span role="cell" className="k-workflow-steps__cap">
        {step.by === 'you' ? (
          <small>{t('workflow.steps.yourStep')}</small>
        ) : (
          <>
            {first && <small>{t('workflow.steps.first')}</small>}
            {step.reviewOf.length > 0 && (
              <small>
                {t('workflow.steps.reviews', {
                  steps: step.reviewOf.map((id) => stepName(workflow, id, locale)).join(', '),
                })}
              </small>
            )}
            {step.hint && <small>{t('workflow.steps.hint', { hint: step.hint })}</small>}
          </>
        )}
        {tools.length > 0 && <small>{t('workflow.steps.uses', { tools: tools.join(', ') })}</small>}
      </span>
      <span role="cell" className="k-workflow-steps__who">
        {step.by === 'you' ? (
          <span className="k-workflow-agent">
            <Icon icon={UserCheck01Icon} size={14} />
            {t('workflow.you')}
          </span>
        ) : (
          <StepPin entry={entry} step={step} />
        )}
      </span>
    </div>
  )
}

/** Auto's mark: the violet sparkle. */
function AutoMark() {
  return (
    <span className="k-workflow-auto" aria-hidden>
      <Icon icon={SparklesIcon} size={13} />
    </span>
  )
}

/** A pin as text: the agent's mark, the model and the effort. */
function PinLabel({ pick }: { pick: StepPick }) {
  const { hostId } = useHostScope()
  const entry = useAgentOptionsStore((s) => optionsOn(s, hostId)[pick.agentId])
  const names = pinNames(entry, pick)
  return (
    <span className="k-workflow-agent" title={agentName(pick.agentId, hostId)}>
      <AgentMark agent={pick.agentId} size={14} />
      <span className="k-workflow-agent__model">
        {names.model ? splitName(names.model)[1] : agentName(pick.agentId, hostId)}
      </span>
      {names.effort && <span className="k-workflow-agent__effort">{names.effort}</span>}
    </span>
  )
}

/**
 * Who does an agent step for every task of this workflow: Auto, or an agent, model and effort the user
 * pinned with the agent menu, whose values are kept here rather than in New session's picks.
 */
function StepPin({ entry, step }: { entry: WireWorkflowEntry; step: WorkflowStep }) {
  const { t, i18n } = useTranslation('marketplace')
  const scope = useHostScope()
  const { hostId } = scope
  const saved = entry.pins[step.id] ?? null
  // What was just chosen, shown until the library says it was kept.
  const [wanted, setWanted] = useState<{ pick: StepPick | null } | null>(null)
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    setSeen(saved)
    setWanted(null)
  }
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pin = wanted ? wanted.pick : saved
  const stepTitle = entry.workflow ? stepName(entry.workflow, step.id, i18n.language) : step.name

  if (awaitsApproval(entry) || !entry.workflow) {
    return (
      <>
        {pin ? (
          <PinLabel pick={pin} />
        ) : (
          <span className="k-workflow-agent">
            <AutoMark />
            {t('workflow.auto')}
          </span>
        )}
        <small>{t('workflow.pin.afterApproval')}</small>
      </>
    )
  }

  const save = async (pick: StepPick | null) => {
    if (pick && !runsSteps(pick.agentId)) {
      setError(t('workflow.pin.notStepAgent'))
      return
    }
    setWanted({ pick })
    setBusy(true)
    setError(null)
    try {
      await scope.request('workflows.pin', { workflowId: entry.id, stepId: step.id, pick })
    } catch (failure) {
      setWanted(null)
      setError(t('workflow.pin.failed', { error: errorMessage(failure) }))
    } finally {
      setBusy(false)
    }
  }
  const options = (agentId: AgentId) => optionsOn(useAgentOptionsStore.getState(), hostId)[agentId]
  const choose = (agentId: AgentId, model: string | null) => {
    const entryOptions = options(agentId)
    const seed =
      pin && pin.agentId === agentId
        ? pinValues(entryOptions, pin)
        : { ...(picksOf(useAgentOptionsStore.getState(), hostId, agentId) ?? {}) }
    const modelOption = entryOptions?.config.find((o) => o.category === 'model')
    if (modelOption) {
      if (model === null) delete seed[modelOption.id]
      else seed[modelOption.id] = model
    }
    void save(pinOf(entryOptions, agentId, seed, model))
  }

  return (
    <>
      <span className="k-workflow-who" data-busy={busy || undefined}>
        {choosing ? (
          <span className="k-workflow-pick">
            <AgentMenu
              only={(status) => runsSteps(status.id)}
              agentId={pin?.agentId ?? null}
              values={pin ? pinValues(options(pin.agentId), pin) : undefined}
              onChoose={choose}
              onValues={(optionId, value) => {
                if (!pin) return
                const entryOptions = options(pin.agentId)
                const next = { ...pinValues(entryOptions, pin), [optionId]: value }
                void save(pinOf(entryOptions, pin.agentId, next, pin.model))
              }}
              hostId={hostId}
              defaultOpen
              onClose={() => setChoosing(false)}
            />
          </span>
        ) : (
          <button
            type="button"
            className="k-workflow-pick k-workflow-pick--button"
            aria-label={
              pin
                ? t('workflow.pin.pinnedLabel', { step: stepTitle })
                : t('workflow.pin.autoLabel', { step: stepTitle })
            }
            aria-haspopup="listbox"
            onClick={() => setChoosing(true)}
          >
            {pin ? (
              <PinLabel pick={pin} />
            ) : (
              <>
                <AutoMark />
                {t('workflow.auto')}
              </>
            )}
            <Icon icon={ArrowDown01Icon} size={12} />
          </button>
        )}
        {pin && (
          <IconAction
            label={t('workflow.pin.backToAuto')}
            icon={SparklesIcon}
            busy={busy}
            onClick={() => void save(null)}
          />
        )}
      </span>
      {error && (
        <small className="k-mkt-error" role="alert">
          {error}
        </small>
      )}
    </>
  )
}

/** What the workflow lets agents do: work in the task's folder, use tools, wait for you. */
function Needs({ workflow, pending }: { workflow: Workflow; pending: boolean }) {
  const { t, i18n } = useTranslation('marketplace')
  const locale = i18n.language
  const names = (steps: WorkflowStep[]) =>
    steps.map((s) => stepName(workflow, s.id, locale)).join(', ')
  const agents = workflow.steps.filter((s) => s.by === 'agent')
  const wait = workflow.steps.filter(waitsForYou)
  const { mcp, skills } = workflowTools(workflow)
  const items: { icon: typeof CommandLineIcon; label: string; detail: string }[] = []
  if (agents.length > 0) {
    items.push({ icon: CommandLineIcon, label: t('workflow.needs.work'), detail: names(agents) })
  }
  if (mcp.length > 0 || skills.length > 0) {
    items.push({
      icon: PlugSocketIcon,
      label: t('workflow.needs.tools'),
      detail: [...mcp, ...skills].join(', '),
    })
  }
  if (wait.length > 0) {
    items.push({ icon: UserCheck01Icon, label: t('workflow.needs.wait'), detail: names(wait) })
  }
  if (items.length === 0) return null
  return (
    <section>
      <h3>{pending ? t('workflow.needs.titlePending') : t('workflow.needs.title')}</h3>
      <div className="k-mkt-list">
        {items.map((item) => (
          <div key={item.label} className="k-mkt-item">
            <Icon icon={item.icon} size={15} />
            <span>
              <b>{item.label}</b>
              <small>{item.detail}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The workflow's file, shown when asked for, or at once when it does not read. */
function FileSection({ entry, open: openAtFirst }: { entry: WireWorkflowEntry; open: boolean }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const [open, setOpen] = useState(openAtFirst)
  const { read, error, retry } = useWorkflowFile(entry.id, entry.hash, open)
  return (
    <section>
      <h3 className="k-workflow-h3">
        {t('workflow.file.title')}
        <button
          type="button"
          className="k-mkt-link k-workflow-h3__link"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('workflow.file.hide') : t('workflow.file.show')}
        </button>
      </h3>
      {open &&
        (error ? (
          <p className="k-mkt-error" role="alert">
            {t('workflow.file.failed', { error })}{' '}
            <button type="button" className="k-mkt-link" onClick={retry}>
              {t('common:actions.retry')}
            </button>
          </p>
        ) : read ? (
          <FileText text={read.text} />
        ) : (
          <Skeleton className="k-workflow-file__skeleton" />
        ))}
    </section>
  )
}

function Side({ entry, workflow }: { entry: WireWorkflowEntry; workflow: Workflow | null }) {
  const { t, i18n } = useTranslation('marketplace')
  const [reporting, setReporting] = useState(false)
  const origin = entry.origin
  const kettu = kettuPublisher(entry)
  const tools = workflow ? workflowTools(workflow) : null
  const session = useSessionsStore((s) =>
    origin?.kind === 'agent' ? (s.byId[origin.sessionId] ?? null) : null,
  )
  const none = t('workflow.side.none')
  return (
    <aside className="k-mkt-side">
      <dl>
        <dt>{t('listing.side.publisher')}</dt>
        <dd>
          {kettu ? (
            <>
              {kettu}
              <KettuMark />
            </>
          ) : origin?.kind === 'community' ? (
            origin.handle
          ) : origin?.kind === 'github' ? (
            (githubRepo(origin.url)?.split('/')[0] ?? 'GitHub')
          ) : (
            t('workflow.side.you')
          )}
        </dd>
        <dt>{t('workflow.side.kind')}</dt>
        <dd>{t('kind.workflow')}</dd>
        {origin?.kind === 'community' && (
          <>
            <dt>{t('community.side.name')}</dt>
            <dd className="k-mkt-mono" data-selectable="">
              @{origin.handle}/{origin.slug}
            </dd>
            <dt>{t('listing.side.listedIn')}</dt>
            <dd>{t('community.source')}</dd>
          </>
        )}
        {origin?.kind === 'github' && (
          <>
            <dt>{t('listing.side.repository')}</dt>
            <dd>
              <ExternalLink href={githubPage(origin.url)} />
            </dd>
          </>
        )}
        {entry.file && (
          <>
            <dt>{t('workflow.side.file')}</dt>
            <dd className="k-workflow-side__file">
              <span className="k-mkt-mono" data-selectable="">
                {homeShort(entry.file)}
              </span>
              <PlaceAction path={entry.file} icon />
            </dd>
          </>
        )}
        {tools && (
          <>
            <dt>{t('workflow.side.mcp')}</dt>
            <dd>{tools.mcp.join(', ') || none}</dd>
            <dt>{t('workflow.side.skills')}</dt>
            <dd>{tools.skills.join(', ') || none}</dd>
          </>
        )}
        {origin?.kind === 'agent' && (
          <>
            <dt>{t('workflow.side.madeIn')}</dt>
            <dd>
              {session ? (
                <button
                  type="button"
                  className="k-mkt-link"
                  onClick={() => openSession(session.id, session.projectPath)}
                >
                  <span>{session.title || t('workflow.approval.untitled')}</span>
                </button>
              ) : (
                t('workflow.side.sessionGone')
              )}
            </dd>
          </>
        )}
      </dl>
      {origin?.kind === 'community' && (
        <>
          <button type="button" className="k-mkt-report" onClick={() => setReporting(true)}>
            <Icon icon={Flag02Icon} size={13} />
            {t('community.report')}
          </button>
          <ReportDialog
            listing={{
              id: origin.listingId,
              name: workflow ? workflowName(entry, i18n.language) : entry.name,
            }}
            open={reporting}
            onOpenChange={setReporting}
          />
        </>
      )}
    </aside>
  )
}
