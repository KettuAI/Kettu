// An SOP's page: what it is for, its flow, each step with who does it, what it lets agents do,
// and its file; the approval for one the user has not approved, or that changed since.

import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  CommandLineIcon,
  Delete02Icon,
  MoreHorizontalIcon,
  PlugSocketIcon,
  RefreshIcon,
  SparklesIcon,
  Tick02Icon,
  UndoIcon,
  UserCheck01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { stepName, type Sop, type SopEntry, type SopStep, type StepPick } from '@shared/sop'
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
import { KindTag, OfficialBadge } from './rows'
import {
  awaitsApproval,
  backArrowsOf,
  flowGroups,
  flowLine,
  githubPage,
  githubRepo,
  outcomeTarget,
  pinNames,
  pinOf,
  pinValues,
  runsSteps,
  sopDescription,
  sopGroup,
  sopName,
  sopState,
  sopTools,
  waitsForYou,
} from './sop-model'
import { retrySops, useSops } from './sop-actions'
import { SopByline, SopRow, SopStateBadge } from './sops'
import { sopSubject } from './tile-art'
import { ItemTile } from './tiles'

/** Other SOPs of its group shown under a page. */
const RELATED = 4

export function SopListing({
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
  const { entries, loaded, error } = useSops()
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
              {error ? t('sop.readFailedTitle') : t('sop.missingTitle')}
            </b>
            <p className="ui-as-empty__text">
              {error ? t('sop.readFailed', { error }) : t('sop.missingText')}
            </p>
            <Button
              size="md"
              variant="secondary"
              onClick={error ? () => void retrySops(scope) : back}
            >
              {error ? t('common:actions.retry') : t('listing.backToDirectory')}
            </Button>
          </div>
        )}
      </ListingFrame>
    )
  }

  const sop = entry.sop
  const state = sopState(entry)
  const name = sopName(entry, locale)
  const description = sopDescription(entry, locale)
  const related = entries
    .filter((e) => e.id !== entry.id && sopGroup(e) === sopGroup(entry))
    .slice(0, RELATED)
  return (
    <ListingFrame back={back} rise>
      <header className="k-mkt-head">
        <ItemTile subject={sopSubject(entry)} size="big" />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>{name}</h1>
            <KindTag kind="sop" />
          </span>
          <span className="k-mkt-head__pub">
            {entry.source === 'official' ? (
              <>
                {t('sop.by.kettu')}
                <OfficialBadge />
                <span className="k-mkt-head__trust" aria-hidden>
                  {t('listing.official')}
                </span>
              </>
            ) : (
              <>
                {t('sop.yours')}
                <span className="k-mkt-head__trust">
                  <SopByline entry={entry} />
                </span>
              </>
            )}
          </span>
          {sop && <span className="k-mkt-head__line">{flowLine(sop, locale)}</span>}
        </span>
        <span className="k-mkt-head__act">
          {state === 'ready' ? (
            <span className="k-mkt-head__on">
              <Icon icon={Tick02Icon} size={14} />
              {t('listing.installed')}
            </span>
          ) : (
            <SopStateBadge state={state} />
          )}
          <SopMenu entry={entry} name={name} onRemoved={back} />
        </span>
      </header>

      {entry.problems.length > 0 && <Problems entry={entry} />}
      {sop && awaitsApproval(entry) && <Approval entry={entry} name={name} onRemoved={back} />}

      <Facts entry={entry} />

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          {description && <p className="k-mkt-about">{description}</p>}
          {sop && <Flow sop={sop} />}
          {sop && <Steps entry={entry} sop={sop} />}
          {sop && <Needs sop={sop} pending={awaitsApproval(entry)} />}
          {!(sop && awaitsApproval(entry)) && <FileSection entry={entry} open={!sop} />}
        </div>
        <Side entry={entry} sop={sop} />
      </div>

      {related.length > 0 && (
        <section className="ui-as-int-section">
          <h2 className="ui-as-int-section__title">{t(`sop.related.${sopGroup(entry)}`)}</h2>
          <div className="ui-as-int-grid">
            {related.map((other) => (
              <SopRow key={other.id} entry={other} tab={tab} />
            ))}
          </div>
        </section>
      )}
    </ListingFrame>
  )
}

/** Check for update on a GitHub SOP, and Delete on any of the user's. */
function SopMenu({
  entry,
  name,
  onRemoved,
}: {
  entry: SopEntry
  name: string
  onRemoved: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [removing, setRemoving] = useState(false)
  const [checking, setChecking] = useState(false)
  if (entry.source === 'official') return null
  const check = async () => {
    setChecking(true)
    try {
      const { changed } = await scope.request('sops.update', { sopId: entry.id })
      await retrySops(scope)
      toast(changed ? t('sop.update.changed', { name }) : t('sop.update.same', { name }))
    } catch (error) {
      toast(t('sop.update.failed', { name, error: errorMessage(error) }), undefined, {
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
                  label: checking ? t('sop.update.checking') : t('sop.update.check'),
                  icon: RefreshIcon,
                  disabled: checking,
                  onSelect: () => void check(),
                },
              ]
            : []),
          {
            label: t('sop.remove.menu'),
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
  entry: SopEntry
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
      title={t('sop.remove.title', { name })}
      body={t('sop.remove.body')}
      confirm={t('sop.remove.confirm')}
      action={async () => {
        await scope.request('sops.remove', { sopId: entry.id })
        onRemoved()
        await retrySops(scope)
      }}
    />
  )
}

/** The file as the host read it, the hash an approval names with it. */
interface ReadFile {
  text: string | null
  hash: string
}

/** Reads the SOP's file; again when `key` changes, as the library says the file did. */
function useSopFile(sopId: string, key: string, enabled = true) {
  const scope = useHostScope()
  const [read, setRead] = useState<ReadFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let live = true
    scope
      .request('sops.read', { sopId })
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
  }, [scope, sopId, key, enabled, attempt])
  return { read, error, retry: () => setAttempt((n) => n + 1) }
}

/**
 * The approval of an SOP the user has not approved, or that changed since: what it is, its file
 * as read, Approve for that very file and Delete.
 */
function Approval({
  entry,
  name,
  onRemoved,
}: {
  entry: SopEntry
  name: string
  onRemoved: () => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const { read, error, retry } = useSopFile(entry.id, entry.hash)
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const origin = entry.origin
  const session = useSessionsStore((s) =>
    origin?.kind === 'agent' ? (s.byId[origin.sessionId] ?? null) : null,
  )

  const approve = async () => {
    setNotice(null)
    if (!read) {
      setNotice(t('sop.approval.notRead'))
      throw new Error('not read')
    }
    try {
      await scope.request('sops.approve', { sopId: entry.id, hash: read.hash })
      await retrySops(scope)
    } catch (failure) {
      // The file changed since it was shown: read it again, so what is approved is what is seen.
      if (errorCode(failure) === 'conflict') {
        setNotice(t('sop.approval.changedWhileShown'))
        await retrySops(scope)
        retry()
      } else {
        setNotice(t('sop.approval.failed', { error: errorMessage(failure) }))
      }
      throw failure
    }
  }

  const title =
    entry.approval === 'changed'
      ? t('sop.approval.changedTitle')
      : entry.source === 'agent'
        ? t('sop.approval.agentTitle')
        : t('sop.approval.title')
  const description: ReactNode =
    entry.approval === 'changed' ? (
      t('sop.approval.changedText')
    ) : origin?.kind === 'agent' ? (
      <>
        {session ? (
          <>
            {t('sop.approval.agentInBefore', { agent: agentName(origin.agentId, scope.hostId) })}
            <button
              type="button"
              className="k-mkt-link"
              onClick={() => openSession(session.id, session.projectPath)}
            >
              {session.title || t('sop.approval.untitled')}
            </button>
            {t('sop.approval.agentInAfter')}
          </>
        ) : (
          t('sop.approval.agentText', { agent: agentName(origin.agentId, scope.hostId) })
        )}{' '}
        {t('sop.approval.check')}
      </>
    ) : origin?.kind === 'github' ? (
      `${t('sop.approval.githubText', { repo: githubRepo(origin.url) ?? 'GitHub' })} ${t('sop.approval.check')}`
    ) : origin?.kind === 'file' ? (
      `${t('sop.approval.fileText', { file: origin.name })} ${t('sop.approval.check')}`
    ) : (
      `${t('sop.approval.userText')} ${t('sop.approval.check')}`
    )

  return (
    <div className="k-sop-approve">
      <ApprovalCard
        title={title}
        description={description}
        icon={<Icon icon={UserCheck01Icon} size={16} />}
        status="pending"
        allowAlways={false}
        shortcuts={false}
        approveLabel={t('sop.approval.approve')}
        denyLabel={t('sop.approval.delete')}
        onApprove={approve}
        onDeny={() => setRemoving(true)}
        preview={
          <div className="k-sop-approve__file">
            <span className="k-sop-approve__head">
              <b>{t('sop.file.title')}</b>
              <small>{t('sop.approval.fileNote')}</small>
            </span>
            {error ? (
              <p className="k-mkt-error" role="alert">
                {t('sop.file.failed', { error })}{' '}
                <button type="button" className="k-mkt-link" onClick={retry}>
                  {t('common:actions.retry')}
                </button>
              </p>
            ) : read ? (
              <FileText text={read.text} />
            ) : (
              <Skeleton className="k-sop-file__skeleton" />
            )}
          </div>
        }
      />
      {notice && (
        <p className="k-sop-approve__notice" role="alert">
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
  if (text === null) return <p className="k-mkt-section-note">{t('sop.file.gone')}</p>
  return (
    <pre className="k-sop-file" data-selectable="" tabIndex={0}>
      {text}
    </pre>
  )
}

/** What the file has wrong, each where the host found it. */
function Problems({ entry }: { entry: SopEntry }) {
  const { t, i18n } = useTranslation('marketplace')
  const where = (at: string): string | null => {
    if (!at) return null
    const step = /^steps\[(\d+)\]/.exec(at)
    const found = step && entry.sop?.steps[Number(step[1])]
    return found ? `${at} · ${stepName(entry.sop!, found.id, i18n.language)}` : at
  }
  return (
    <div className="k-sop-problems" role="group" aria-label={t('sop.problems.title')}>
      <b>
        {entry.sop
          ? t('sop.problems.title', { count: entry.problems.length })
          : t('sop.problems.unreadable')}
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

function Facts({ entry }: { entry: SopEntry }) {
  const { t } = useTranslation('marketplace')
  const sop = entry.sop
  const origin = entry.origin
  const yours = sop ? sop.steps.filter(waitsForYou).length : 0
  const from =
    entry.source === 'official'
      ? t('sop.from.official')
      : origin?.kind === 'github'
        ? (githubRepo(origin.url) ?? 'GitHub')
        : origin?.kind === 'file'
          ? origin.name
          : origin?.kind === 'agent'
            ? t('sop.from.agent', { agent: agentName(origin.agentId) })
            : t('sop.from.you')
  const backs = sop ? sop.steps.flatMap((step) => backArrowsOf(sop, step)) : []
  return (
    <div className="k-mkt-facts k-sop-facts">
      <span>
        <small>{t('sop.facts.runBy')}</small>
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
      {entry.addedAt !== null && (
        <span>
          <small>{t('sop.facts.added')}</small>
          <b>{mediumAgo(entry.addedAt)}</b>
        </span>
      )}
      {sop && (
        <span>
          <small>{t('sop.facts.steps')}</small>
          <b>
            {yours > 0
              ? t('sop.facts.stepsWait', { steps: sop.steps.length, count: yours })
              : sop.steps.length}
          </b>
        </span>
      )}
      {sop && backs.length > 0 && (
        <span>
          <small>{t('sop.facts.sendBack')}</small>
          <b>{t('sop.facts.sendBackLimit', { count: sop.sendBackLimit })}</b>
        </span>
      )}
    </div>
  )
}

/** The steps in order as chips, the ones that wait for you marked, then what sends work back. */
function Flow({ sop }: { sop: Sop }) {
  const { t, i18n } = useTranslation('marketplace')
  const locale = i18n.language
  const ends = new Set(sop.steps.flatMap((step) => step.outcomes.map((o) => o.end)))
  const backs = sop.steps.flatMap((step) =>
    backArrowsOf(sop, step).map((outcome) => ({ step, outcome })),
  )
  return (
    <section>
      <h3>{t('sop.flow.title')}</h3>
      <div className="k-mkt-list k-sop-flow">
        <ol className="k-sop-flow__row">
          {flowGroups(sop).map((group) => (
            <li key={group[0]!.id} className="k-sop-flow__step">
              {group.map((step, i) => (
                <Fragment key={step.id}>
                  {i > 0 && <span className="k-sop-flow__and">+</span>}
                  <span className="k-sop-node">
                    {stepName(sop, step.id, locale)}
                    {step.by === 'you' ? (
                      <span className="k-sop-you">{t('sop.you')}</span>
                    ) : (
                      step.youReview && <span className="k-sop-you">{t('sop.youReview')}</span>
                    )}
                  </span>
                </Fragment>
              ))}
              <Icon icon={ArrowRight01Icon} size={14} />
            </li>
          ))}
          <li className="k-sop-end">
            <i aria-hidden />
            {ends.has('done') ? t('sop.end.done') : t('sop.end.dropped')}
          </li>
        </ol>
        {(backs.length > 0 || ends.has('dropped')) && (
          <ul className="k-sop-flow__notes">
            {backs.map(({ step, outcome }) => (
              <li key={`${step.id}:${outcome.name}`}>
                {t('sop.flow.back', {
                  from: stepName(sop, step.id, locale),
                  outcome: outcome.name,
                  to: outcome.to.map((id) => stepName(sop, id, locale)).join(' + '),
                  count: outcome.limit ?? sop.sendBackLimit,
                })}
              </li>
            ))}
            {sop.steps.flatMap((step) =>
              step.outcomes
                .filter((outcome) => outcome.end === 'dropped')
                .map((outcome) => (
                  <li key={`${step.id}:${outcome.name}:end`}>
                    {t('sop.flow.dropped', {
                      from: stepName(sop, step.id, locale),
                      outcome: outcome.name,
                    })}
                  </li>
                )),
            )}
          </ul>
        )}
      </div>
    </section>
  )
}

/** Each step: what it does and where its outcomes go, the words for whoever picks, who does it. */
function Steps({ entry, sop }: { entry: SopEntry; sop: Sop }) {
  const { t } = useTranslation('marketplace')
  return (
    <section>
      <h3 className="k-sop-h3">
        {t('sop.steps.title')}
        <button
          type="button"
          className="k-mkt-link k-sop-h3__link"
          onClick={() => openSettings('agents')}
        >
          {t('sop.steps.autoAgents')}
        </button>
      </h3>
      <div className="k-mkt-list k-sop-steps" role="table" aria-label={t('sop.steps.title')}>
        <div className="k-sop-steps__row" role="row" data-head="">
          <span role="columnheader">{t('sop.steps.step')}</span>
          <span role="columnheader">{t('sop.steps.forPicker')}</span>
          <span role="columnheader">{t('sop.steps.who')}</span>
        </div>
        {sop.steps.map((step, index) => (
          <StepRow key={step.id} entry={entry} sop={sop} step={step} first={index === 0} />
        ))}
      </div>
    </section>
  )
}

function StepRow({
  entry,
  sop,
  step,
  first,
}: {
  entry: SopEntry
  sop: Sop
  step: SopStep
  first: boolean
}) {
  const { t, i18n } = useTranslation('marketplace')
  const locale = i18n.language
  const [open, setOpen] = useState(false)
  const tools = [...step.tools.mcp, ...step.tools.skills]
  const prompt = step.prompt.trim()
  return (
    <div className="k-sop-steps__row" role="row">
      <span role="cell" className="k-sop-steps__node">
        <b>
          {stepName(sop, step.id, locale)}
          {step.youReview && step.by === 'agent' && (
            <span className="k-sop-you">{t('sop.youReview')}</span>
          )}
        </b>
        <small className="k-sop-steps__prompt" data-open={open || undefined}>
          <span data-selectable="">{prompt}</span>
          {prompt.length > 0 && (
            <button
              type="button"
              className="k-mkt-link"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? t('sop.steps.less') : t('sop.steps.more')}
            </button>
          )}
        </small>
        <ul className="k-sop-steps__outcomes" aria-label={t('sop.steps.outcomes')}>
          {step.outcomes.map((outcome) => {
            const target = outcomeTarget(sop, outcome, locale)
            const back = backArrowsOf(sop, step).includes(outcome)
            return (
              <li key={outcome.name}>
                <span>{outcome.name}</span>
                <Icon icon={back ? UndoIcon : ArrowRight01Icon} size={12} />
                <span>
                  {target.kind === 'end'
                    ? t(target.end === 'done' ? 'sop.end.done' : 'sop.end.dropped')
                    : target.names.join(' + ')}
                </span>
                {back && (
                  <span className="k-sop-steps__limit">
                    {t('sop.steps.upTo', { count: outcome.limit ?? sop.sendBackLimit })}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </span>
      <span role="cell" className="k-sop-steps__cap">
        {step.by === 'you' ? (
          <small>{t('sop.steps.yourStep')}</small>
        ) : (
          <>
            {first && <small>{t('sop.steps.first')}</small>}
            {step.reviewOf.length > 0 && (
              <small>
                {t('sop.steps.reviews', {
                  steps: step.reviewOf.map((id) => stepName(sop, id, locale)).join(', '),
                })}
              </small>
            )}
            {step.hint && <small>{t('sop.steps.hint', { hint: step.hint })}</small>}
          </>
        )}
        {tools.length > 0 && <small>{t('sop.steps.uses', { tools: tools.join(', ') })}</small>}
      </span>
      <span role="cell" className="k-sop-steps__who">
        {step.by === 'you' ? (
          <span className="k-sop-agent">
            <Icon icon={UserCheck01Icon} size={14} />
            {t('sop.you')}
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
    <span className="k-sop-auto" aria-hidden>
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
    <span className="k-sop-agent" title={agentName(pick.agentId, hostId)}>
      <AgentMark agent={pick.agentId} size={14} />
      <span className="k-sop-agent__model">
        {names.model ? splitName(names.model)[1] : agentName(pick.agentId, hostId)}
      </span>
      {names.effort && <span className="k-sop-agent__effort">{names.effort}</span>}
    </span>
  )
}

/**
 * Who does an agent step for every task of this SOP: Auto, or an agent, model and effort the user
 * pinned with the agent menu, whose values are kept here rather than in New session's picks.
 */
function StepPin({ entry, step }: { entry: SopEntry; step: SopStep }) {
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
  const stepTitle = entry.sop ? stepName(entry.sop, step.id, i18n.language) : step.name

  if (awaitsApproval(entry) || !entry.sop) {
    return (
      <>
        {pin ? (
          <PinLabel pick={pin} />
        ) : (
          <span className="k-sop-agent">
            <AutoMark />
            {t('sop.auto')}
          </span>
        )}
        <small>{t('sop.pin.afterApproval')}</small>
      </>
    )
  }

  const save = async (pick: StepPick | null) => {
    if (pick && !runsSteps(pick.agentId)) {
      setError(t('sop.pin.notStepAgent'))
      return
    }
    setWanted({ pick })
    setBusy(true)
    setError(null)
    try {
      await scope.request('sops.pin', { sopId: entry.id, stepId: step.id, pick })
    } catch (failure) {
      setWanted(null)
      setError(t('sop.pin.failed', { error: errorMessage(failure) }))
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
      <span className="k-sop-who" data-busy={busy || undefined}>
        {choosing ? (
          <span className="k-sop-pick">
            <AgentMenu
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
            className="k-sop-pick k-sop-pick--button"
            aria-label={
              pin
                ? t('sop.pin.pinnedLabel', { step: stepTitle })
                : t('sop.pin.autoLabel', { step: stepTitle })
            }
            aria-haspopup="listbox"
            onClick={() => setChoosing(true)}
          >
            {pin ? (
              <PinLabel pick={pin} />
            ) : (
              <>
                <AutoMark />
                {t('sop.auto')}
              </>
            )}
            <Icon icon={ArrowDown01Icon} size={12} />
          </button>
        )}
        {pin && (
          <IconAction
            label={t('sop.pin.backToAuto')}
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

/** What the SOP lets agents do: work in the task's folder, use tools, wait for you. */
function Needs({ sop, pending }: { sop: Sop; pending: boolean }) {
  const { t, i18n } = useTranslation('marketplace')
  const locale = i18n.language
  const names = (steps: SopStep[]) => steps.map((s) => stepName(sop, s.id, locale)).join(', ')
  const agents = sop.steps.filter((s) => s.by === 'agent')
  const wait = sop.steps.filter(waitsForYou)
  const { mcp, skills } = sopTools(sop)
  const items: { icon: typeof CommandLineIcon; label: string; detail: string }[] = []
  if (agents.length > 0) {
    items.push({ icon: CommandLineIcon, label: t('sop.needs.work'), detail: names(agents) })
  }
  if (mcp.length > 0 || skills.length > 0) {
    items.push({
      icon: PlugSocketIcon,
      label: t('sop.needs.tools'),
      detail: [...mcp, ...skills].join(', '),
    })
  }
  if (wait.length > 0) {
    items.push({ icon: UserCheck01Icon, label: t('sop.needs.wait'), detail: names(wait) })
  }
  if (items.length === 0) return null
  return (
    <section>
      <h3>{pending ? t('sop.needs.titlePending') : t('sop.needs.title')}</h3>
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

/** The SOP's file, shown when asked for, or at once when it does not read. */
function FileSection({ entry, open: openAtFirst }: { entry: SopEntry; open: boolean }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const [open, setOpen] = useState(openAtFirst)
  const { read, error, retry } = useSopFile(entry.id, entry.hash, open)
  return (
    <section>
      <h3 className="k-sop-h3">
        {t('sop.file.title')}
        <button
          type="button"
          className="k-mkt-link k-sop-h3__link"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('sop.file.hide') : t('sop.file.show')}
        </button>
      </h3>
      {open &&
        (error ? (
          <p className="k-mkt-error" role="alert">
            {t('sop.file.failed', { error })}{' '}
            <button type="button" className="k-mkt-link" onClick={retry}>
              {t('common:actions.retry')}
            </button>
          </p>
        ) : read ? (
          <FileText text={read.text} />
        ) : (
          <Skeleton className="k-sop-file__skeleton" />
        ))}
    </section>
  )
}

function Side({ entry, sop }: { entry: SopEntry; sop: Sop | null }) {
  const { t } = useTranslation('marketplace')
  const origin = entry.origin
  const tools = sop ? sopTools(sop) : null
  const session = useSessionsStore((s) =>
    origin?.kind === 'agent' ? (s.byId[origin.sessionId] ?? null) : null,
  )
  const none = t('sop.side.none')
  return (
    <aside className="k-mkt-side">
      <dl>
        <dt>{t('listing.side.publisher')}</dt>
        <dd>
          {entry.source === 'official' ? (
            <>
              {t('sop.by.kettu')}
              <OfficialBadge />
            </>
          ) : origin?.kind === 'github' ? (
            (githubRepo(origin.url)?.split('/')[0] ?? 'GitHub')
          ) : (
            t('sop.side.you')
          )}
        </dd>
        <dt>{t('sop.side.kind')}</dt>
        <dd>{t('kind.sop')}</dd>
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
            <dt>{t('sop.side.file')}</dt>
            <dd className="k-sop-side__file">
              <span className="k-mkt-mono" data-selectable="">
                {homeShort(entry.file)}
              </span>
              <PlaceAction path={entry.file} icon />
            </dd>
          </>
        )}
        {tools && (
          <>
            <dt>{t('sop.side.mcp')}</dt>
            <dd>{tools.mcp.join(', ') || none}</dd>
            <dt>{t('sop.side.skills')}</dt>
            <dd>{tools.skills.join(', ') || none}</dd>
          </>
        )}
        {origin?.kind === 'agent' && (
          <>
            <dt>{t('sop.side.madeIn')}</dt>
            <dd>
              {session ? (
                <button
                  type="button"
                  className="k-mkt-link"
                  onClick={() => openSession(session.id, session.projectPath)}
                >
                  <span>{session.title || t('sop.approval.untitled')}</span>
                </button>
              ) : (
                t('sop.side.sessionGone')
              )}
            </dd>
          </>
        )}
      </dl>
    </aside>
  )
}
