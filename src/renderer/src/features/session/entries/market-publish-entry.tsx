import {
  memo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Globe02Icon,
  SquareLock02Icon,
  Store01Icon,
  Tick02Icon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  HANDLE,
  LISTING_NOTES_CHARS,
  type ListingVisibility,
  type PublishVisibility,
} from '@shared/market-publish'
import type { MarketPublishAsk as Ask, MarketPublishEntry as Entry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Spinner } from '@renderer/components/ui/spinner'
import { bytes } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { WorkflowChart } from '@renderer/features/tasks/workflow-chart'
import { permissionRows } from '../../marketplace/plugin-model'
import { kettuPluginSubject, tileArt } from '../../marketplace/tile-art'
import { Clamp } from '../clamp'
import { Diff } from '../markdown'
import { useEntry, useEntryAnimation } from '../use-thread'
import { useAnswering } from './use-answering'

const MAX_LIST_HEIGHT = 140
const EVERY_AGENT = ['claude-code', 'codex', 'opencode', 'pi'] as const
// The agents that do a workflow's steps.
const STEP_AGENTS = ['claude-code', 'codex'] as const
const VISIBILITY_ICON = {
  public: Globe02Icon,
  private: SquareLock02Icon,
  unlisted: ViewOffSlashIcon,
} as const satisfies Record<ListingVisibility, unknown>

/** The listing's tile, on the Marketplace's own glyph and color for its kind. */
function PublishTile({ item }: { item: Ask['item'] }) {
  const art = tileArt(
    item.kind === 'skill'
      ? { kind: 'skill', name: item.slug }
      : item.kind === 'workflow'
        ? { kind: 'workflow', id: item.slug, source: 'community' }
        : item.kind === 'plugin'
          ? {
              kind: 'plugin',
              harness: item.harness ?? 'claude-code',
              id: item.slug,
              category: null,
            }
          : item.kind === 'agent-plugin'
            ? kettuPluginSubject({ name: item.slug })
            : { kind: 'mcp', id: item.slug, brand: null },
  )
  const glyph = art.type === 'glyph' ? art : null
  return (
    <span
      aria-hidden
      className="ks-pub-tile"
      style={glyph ? ({ '--tile': glyph.color } as CSSProperties) : undefined}
    >
      {glyph && <Icon icon={glyph.icon} size={17} />}
    </span>
  )
}

function KindLabel({ item }: { item: Ask['item'] }) {
  const { t } = useTranslation('session')
  return (
    <span className="ks-pub-kind">
      {item.harness && <AgentMark agent={item.harness} size={11} dot={null} />}
      {t(`marketPublish.kind.${item.kind}`)}
    </span>
  )
}

/** The listing's line: tile, name, kind and the version, old to new for a new version. */
function ListingLine({ entry }: { entry: Ask }) {
  return (
    <div className="ks-pub-line">
      <PublishTile item={entry.item} />
      <span className="ks-pub-line__text">
        <span className="ks-pub-line__top">
          <b>{entry.item.name}</b>
          <KindLabel item={entry.item} />
          {entry.version && (
            <span className="ks-pub-line__version">
              {entry.previous && (
                <>
                  <span className="ks-pub-faint">{entry.previous}</span> →{' '}
                </>
              )}
              {entry.version}
            </span>
          )}
        </span>
        {entry.item.description && <small>{entry.item.description}</small>}
      </span>
    </div>
  )
}

function Visibility({ value }: { value: ListingVisibility }) {
  const { t } = useTranslation('session')
  return (
    <span className="ks-pub-vis">
      <Icon icon={VISIBILITY_ICON[value]} size={14} />
      {t(`marketPublish.visibility.${value}`)}
    </span>
  )
}

function Check({ children }: { children: ReactNode }) {
  return (
    <span className="ks-pub-ok">
      <Icon icon={Tick02Icon} size={13} />
      {children}
    </span>
  )
}

/**
 * The agents an install works with: a plugin's harness, the agents that do a workflow's steps,
 * else every agent Kettu runs.
 */
function WorksWith({ item }: { item: Ask['item'] }) {
  const { t } = useTranslation('session')
  if (item.kind === 'workflow') {
    return (
      <span className="ks-pub-agents">
        {STEP_AGENTS.map((agent) => (
          <AgentMark key={agent} agent={agent} size={13} dot={null} />
        ))}
        {t('marketPublish.stepAgents')}
      </span>
    )
  }
  if (item.kind === 'plugin' && item.harness) {
    return (
      <span className="ks-pub-agents">
        <AgentMark agent={item.harness} size={13} dot={null} />
        {t(`marketPublish.harness.${item.harness}`)}
      </span>
    )
  }
  return (
    <span className="ks-pub-agents">
      {EVERY_AGENT.map((agent) => (
        <AgentMark key={agent} agent={agent} size={13} dot={null} />
      ))}
      {t('marketPublish.everyAgent')}
    </span>
  )
}

/** What the card shows of the version: what it adds and runs, its files or changes, the checks. */
function Facts({ entry, visibility }: { entry: Ask; visibility: ReactNode }) {
  const { t } = useTranslation('session')
  const [filesOpen, setFilesOpen] = useState(false)
  const publish = entry.action === 'publish'
  // The chart above draws a workflow's steps, and a plugin's script has a row of its own.
  const adds = entry.adds.filter(
    (group) => !(entry.workflow && group.label === 'steps') && group.label !== 'script',
  )
  return (
    <dl className="ks-pub-dl">
      {visibility}
      {publish && entry.converted && <Converted converted={entry.converted} />}
      {publish && entry.fromTask && <FromTask from={entry.fromTask} />}
      {adds.length > 0 && (
        <div>
          <dt>{t('marketPublish.adds')}</dt>
          <dd className="ks-pub-adds">
            {adds.map((group) => (
              <span key={group.label}>
                {t(
                  `marketPublish.${entry.item.kind === 'workflow' ? 'workflowGroup' : 'addsGroup'}.${group.label}`,
                  { defaultValue: group.label },
                )}{' '}
                <span className="ks-pub-mono">
                  {group.items.join(group.label === 'steps' ? ' → ' : ', ')}
                </span>
              </span>
            ))}
          </dd>
        </div>
      )}
      {publish && entry.plugin && <PluginScript plugin={entry.plugin} />}
      {publish && entry.plugin && entry.plugin.notes.length > 0 && (
        <div>
          <dt>{t('marketPublish.pluginLeftOut')}</dt>
          <dd>
            <LeftOutList>
              {entry.plugin.notes.map((note) => (
                <li key={note}>
                  <span>{note}</span>
                </li>
              ))}
            </LeftOutList>
          </dd>
        </div>
      )}
      {publish && (
        <div>
          <dt>
            {entry.item.kind === 'workflow'
              ? t('marketPublish.stepsBy')
              : t('marketPublish.worksWith')}
          </dt>
          <dd>
            <WorksWith item={entry.item} />
          </dd>
        </div>
      )}
      {entry.runs.length > 0 && (
        <div>
          <dt>{t('marketPublish.runs')}</dt>
          <dd className="ks-pub-runs">
            {entry.runs.map((line) => (
              <span key={line} className="ks-pub-mono">
                {line}
              </span>
            ))}
          </dd>
        </div>
      )}
      {publish && entry.changes && entry.changes.length > 0 && (
        <div>
          <dt>{t('marketPublish.changes')}</dt>
          <dd className="ks-pub-files">
            {entry.changes.map((change) => (
              <span key={change.path}>
                <span className="ks-pub-mono">{change.path}</span>
                {(change.added ?? 0) > 0 && <span className="ks-add">+{change.added}</span>}
                {(change.removed ?? 0) > 0 && <span className="ks-del">−{change.removed}</span>}
                {change.status !== 'changed' && (
                  <span className="ks-pub-faint">{t(`marketPublish.change.${change.status}`)}</span>
                )}
              </span>
            ))}
          </dd>
        </div>
      )}
      {publish && entry.files.length > 0 && (
        <div>
          <dt>{t('marketPublish.uploads')}</dt>
          <dd>
            <span className="ks-pub-uploads">
              {t('marketPublish.filesSize', {
                count: entry.files.length,
                size: bytes(entry.bytes),
              })}
              <span className="ks-pub-mono ks-pub-faint">
                {t('marketPublish.from', { folder: entry.folder })}
              </span>
              <button
                type="button"
                className="ks-pub-link"
                aria-expanded={filesOpen}
                onClick={() => setFilesOpen((open) => !open)}
              >
                {filesOpen ? t('marketPublish.hideFiles') : t('marketPublish.viewFiles')}
              </button>
            </span>
            {filesOpen && (
              <ul className="ks-pub-filelist" data-selectable="">
                {entry.files.map((file) => (
                  <li key={file.path}>
                    <span className="ks-pub-mono">{file.path}</span>
                    <span className="ks-pub-faint">{bytes(file.size)}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      )}
      {publish && (
        <div>
          <dt>{t('marketPublish.checks')}</dt>
          <dd className="ks-pub-checks">
            {entry.manifest && <Check>{entry.manifest}</Check>}
            <Check>{t('marketPublish.noSecrets')}</Check>
            <Check>
              {entry.runs.length === 0 && !entry.plugin?.script
                ? t('marketPublish.runsNothing')
                : t('marketPublish.withinLimits')}
            </Check>
          </dd>
        </div>
      )}
    </dl>
  )
}

/** A list that is cut at a height, with a button that shows the rest. */
function LeftOutList({ children }: { children: ReactNode }) {
  const { t } = useTranslation('session')
  return (
    <Clamp maxHeight={MAX_LIST_HEIGHT} more={t('marketPublish.showAll')}>
      <ul className="ks-pub-left" data-selectable="">
        {children}
      </ul>
    </Clamp>
  )
}

/** A Kettu plugin's script and what it may do, with the high permissions marked as an install does. */
function PluginScript({ plugin }: { plugin: NonNullable<Ask['plugin']> }) {
  const { t } = useTranslation('session')
  const { t: market } = useTranslation('marketplace')
  if (!plugin.script) return null
  const rows = permissionRows(plugin.permissions)
  return (
    <div>
      <dt>{t('marketPublish.script.label')}</dt>
      <dd className="ks-pub-adds">
        <span className="ks-pub-mono">{plugin.script.entry}</span>
        {rows.length === 0 && (
          <span className="ks-pub-faint">{t('marketPublish.script.noPermissions')}</span>
        )}
        {rows.map((row) => (
          <span key={row.permission} className="ks-pub-perm" data-risk={row.risk}>
            <b>
              {market(row.nameKey as 'plugin.permission.tools.name')}
              {row.domain && <span className="ks-pub-mono">{row.domain}</span>}
              {row.risk === 'high' && (
                <span className="ks-pub-high">{market('plugin.risk.high')}</span>
              )}
            </b>
            <small>
              {market(row.descriptionKey as 'plugin.permission.tools.description', {
                domain: row.domain ?? undefined,
              })}
            </small>
          </span>
        ))}
        <small className="ks-pub-faint">{t('marketPublish.script.onlyKettu')}</small>
      </dd>
    </div>
  )
}

/**
 * What a conversion made of a Claude Code or Codex plugin: what came over, what did not and why,
 * and what changed on the way, for the user to review before it is published.
 */
function Converted({ converted }: { converted: NonNullable<Ask['converted']> }) {
  const { t } = useTranslation('session')
  const changed = converted.notes.filter((note) => note.name !== '')
  return (
    <div>
      <dt>{t('marketPublish.converted.label')}</dt>
      <dd className="ks-pub-from">
        <span data-selectable="">
          {t('marketPublish.converted.from', {
            harness: t(`marketPublish.harness.${converted.from}`),
          })}
        </span>
        {converted.carried.length > 0 && (
          <span className="ks-pub-uploads">
            <span className="ks-pub-faint">{t('marketPublish.converted.carried')}</span>
            <span>
              {converted.carried
                .map((group) =>
                  t(`marketPublish.converted.count.${group.label}`, {
                    count: group.items.length,
                    defaultValue: `${group.items.length} ${group.label}`,
                  }),
                )
                .join(', ')}
            </span>
          </span>
        )}
        {converted.leftOut.length === 0 ? (
          <span className="ks-pub-faint">{t('marketPublish.converted.nothingLeftOut')}</span>
        ) : (
          <>
            <span className="ks-pub-faint">
              {t('marketPublish.converted.leftOut', { count: converted.leftOut.length })}
            </span>
            <LeftOutList>
              {converted.leftOut.map((item, index) => (
                <li key={`${item.kind}:${item.name}:${index}`}>
                  <span className="ks-pub-mono">
                    {t(`marketPublish.converted.kind.${item.kind}`)} {item.name}
                  </span>
                  <span className="ks-pub-faint">{item.text ?? item.message}</span>
                </li>
              ))}
            </LeftOutList>
          </>
        )}
        {changed.length > 0 && (
          <>
            <span className="ks-pub-faint">{t('marketPublish.converted.changed')}</span>
            <LeftOutList>
              {changed.map((item, index) => (
                <li key={`${item.name}:${index}`}>
                  <span className="ks-pub-mono">{item.name}</span>
                  <span className="ks-pub-faint">{item.text ?? item.message}</span>
                </li>
              ))}
            </LeftOutList>
          </>
        )}
      </dd>
    </div>
  )
}

/**
 * A workflow made general from a task's: what the agent says it changed, whether the steps and
 * arrows stayed, and the two files side by side on request.
 */
function FromTask({ from }: { from: NonNullable<Ask['fromTask']> }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  return (
    <div>
      <dt>{t('marketPublish.fromTask.label')}</dt>
      <dd className="ks-pub-from">
        {from.changes && <span data-selectable="">{from.changes}</span>}
        <span className="ks-pub-uploads">
          <span className={cn('ks-pub-faint', !from.sameFlow && 'text-warning')}>
            {from.sameFlow ? t('marketPublish.fromTask.same') : t('marketPublish.fromTask.changed')}
          </span>
          <button
            type="button"
            className="ks-pub-link"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
          >
            {open
              ? t('marketPublish.fromTask.hide')
              : t('marketPublish.fromTask.compare', { title: from.title })}
          </button>
        </span>
        {open && (
          <div className="flex flex-col overflow-hidden rounded-code border border-subtle">
            <Clamp maxHeight={360} more={t('tool.showFullDiff')} buttonClassName="mx-2 my-1">
              <Diff path="workflow.yaml" oldText={from.before} newText={from.after} />
            </Clamp>
          </div>
        )}
      </dd>
    </div>
  )
}

/** Keys typed into a field of the card stay there: Esc leaves the field instead of Not now. */
function stayInField(event: KeyboardEvent<HTMLElement>) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    event.currentTarget.blur()
  }
}

/**
 * What a publish or an unlisting asks, as a session's card and Marketplace › Published's folder
 * dialog show it: the listing, who sees it, a new version's notes, what it adds and uploads, the
 * checks and a first publish's publisher name. `agentName` is null when no agent asked.
 */
export function PublishForm({
  ask,
  fieldId,
  agentName,
  visibility,
  onVisibility,
  notes,
  onNotes,
  handle,
  onHandle,
  handleInvalid,
}: {
  ask: Ask
  fieldId: string
  agentName: string | null
  visibility: PublishVisibility
  onVisibility: (visibility: PublishVisibility) => void
  notes: string
  onNotes: (notes: string) => void
  handle: string
  onHandle: (handle: string) => void
  handleInvalid: boolean
}) {
  const { t } = useTranslation('session')
  const unlist = ask.action === 'unlist'
  const fresh = !unlist && ask.listingId === null
  const newVersion = !unlist && ask.listingId !== null
  const visibilityRow = fresh ? null : (
    <div>
      <dt>{t('marketPublish.visibleTo')}</dt>
      <dd>
        <Visibility value={ask.visibility} />
        {!unlist && <span className="ks-pub-faint">{t('marketPublish.asBefore')}</span>}
      </dd>
    </div>
  )
  return (
    <div className="ks-pub__body">
      <ListingLine entry={ask} />
      {ask.workflow && <WorkflowChart workflow={ask.workflow} hostId={null} />}
      {fresh && (
        <div className="ks-pub-row">
          <span className="ks-pub-label">{t('marketPublish.visibleTo')}</span>
          <SegmentedControl
            aria-label={t('marketPublish.visibleTo')}
            variant="tray"
            size="sm"
            value={visibility}
            onChange={onVisibility}
            options={[
              { value: 'public', label: t('marketPublish.visibility.public') },
              { value: 'private', label: t('marketPublish.visibility.private') },
            ]}
          />
          <small className="ks-pub-hint">{t(`marketPublish.visibilityHint.${visibility}`)}</small>
        </div>
      )}
      {newVersion && (
        <label className="ks-pub-notes">
          <span className="ks-pub-label">
            {agentName
              ? t('marketPublish.notes', { agent: agentName })
              : t('marketPublish.notesYours')}
          </span>
          <textarea
            rows={3}
            value={notes}
            maxLength={LISTING_NOTES_CHARS}
            placeholder={t('marketPublish.notesPlaceholder')}
            onChange={(event) => onNotes(event.target.value)}
            onKeyDown={stayInField}
          />
        </label>
      )}
      <Facts entry={ask} visibility={visibilityRow} />
      {ask.publisher && (
        <div className="ks-pub-row ks-pub-handle">
          <label className="ks-pub-label" htmlFor={`${fieldId}-handle`}>
            {t('marketPublish.publisherName')}
          </label>
          <span className="ks-pub-input">
            <span className="ks-pub-faint">@</span>
            <input
              id={`${fieldId}-handle`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              value={handle}
              aria-invalid={handleInvalid}
              onChange={(event) => onHandle(event.target.value.toLowerCase())}
              onKeyDown={stayInField}
            />
          </span>
          <small className="ks-pub-hint">{t('marketPublish.publisherHint')}</small>
        </div>
      )}
    </div>
  )
}

/**
 * An agent's publish to the Kettu Marketplace, or its unlisting, waiting for the user on Approval
 * Card: the listing, who sees it, what it adds and uploads and the checks, a new version's notes and
 * a first publish's publisher name. Publish uploads; Not now keeps a draft and uploads nothing.
 */
function PublishCard({
  sessionId,
  entry,
  agentName,
}: {
  sessionId: string
  entry: Entry
  agentName: string
}) {
  const { t } = useTranslation('session')
  const { answering, error, away, send } = useAnswering(sessionId)
  const [visibility, setVisibility] = useState<PublishVisibility>(
    entry.visibility === 'private' ? 'private' : 'public',
  )
  const [notes, setNotes] = useState(entry.notes ?? '')
  const [handle, setHandle] = useState(entry.publisher?.suggested ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const unlist = entry.action === 'unlist'
  const fresh = !unlist && entry.listingId === null
  const newVersion = !unlist && entry.listingId !== null

  const answer = async (decision: 'confirm' | 'later'): Promise<boolean> => {
    if (away || answering !== null) return false
    const focused = !!root.current?.contains(document.activeElement)
    const sent = await send(decision, () =>
      host('market.answerPublish', {
        sessionId,
        entryId: entry.id,
        decision,
        ...(decision === 'confirm' && fresh ? { visibility } : {}),
        ...(decision === 'confirm' && newVersion ? { notes } : {}),
        ...(decision === 'confirm' && entry.publisher ? { handle: handle.trim() } : {}),
      }),
    )
    if (sent && focused) emitAppEvent({ kind: 'focus-composer' })
    return sent
  }

  const publish = async () => {
    if (entry.publisher && !HANDLE.test(handle.trim())) {
      setProblem(t('marketPublish.handleInvalid'))
      throw new Error('invalid handle')
    }
    setProblem(null)
    // A refusal keeps the card waiting, with the reason under it.
    if (!(await answer('confirm'))) throw new Error('not sent')
  }

  const title = unlist
    ? t('marketPublish.title.unlist', { name: entry.item.name })
    : newVersion
      ? t('marketPublish.title.version', { name: entry.item.name, version: entry.version })
      : t('marketPublish.title.new')
  const description = unlist
    ? t('marketPublish.description.unlist')
    : newVersion && entry.installs > 0
      ? t('marketPublish.description.version', {
          count: entry.installs,
          version: entry.version,
        })
      : t('marketPublish.description.new')

  return (
    <div ref={root} className="min-w-0">
      <ApprovalCard
        className="ks-pub"
        title={title}
        description={description}
        icon={<Icon icon={Store01Icon} size={15} />}
        label={`${agentName} · ${unlist ? 'marketplace_unlist' : 'marketplace_publish'}`}
        approveLabel={
          unlist
            ? t('marketPublish.unlist')
            : newVersion && entry.version
              ? t('marketPublish.publishVersion', { version: entry.version })
              : t('marketPublish.publish')
        }
        denyLabel={t('marketPublish.notNow')}
        allowAlways={false}
        shortcuts
        status="pending"
        onApprove={publish}
        onDeny={() => void answer('later')}
        preview={
          <PublishForm
            ask={entry}
            fieldId={entry.id}
            agentName={agentName}
            visibility={visibility}
            onVisibility={setVisibility}
            notes={notes}
            onNotes={setNotes}
            handle={handle}
            onHandle={(next) => {
              setHandle(next)
              setProblem(null)
            }}
            handleInvalid={problem !== null}
          />
        }
      />
      {(problem ?? error) && (
        <p role="alert" className="ks-card-error">
          {problem ?? error}
        </p>
      )}
    </div>
  )
}

/** What became of a card once answered: on its way, done, refused, or kept as a draft. */
function PublishSettled({ entry }: { entry: Entry }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const outcome = entry.outcome!
  const name = entry.item.name
  const unlist = entry.action === 'unlist'
  const busy = outcome.kind === 'publishing' || outcome.kind === 'unlisting'
  const held = outcome.kind === 'published' && outcome.held === true
  const done = (outcome.kind === 'published' && !held) || outcome.kind === 'unlisted'
  const failed = outcome.kind === 'failed'
  const glyph = done
    ? CheckmarkCircle02Icon
    : failed
      ? Alert02Icon
      : held || outcome.kind === 'later'
        ? Clock01Icon
        : Cancel01Icon
  const title =
    outcome.kind === 'published'
      ? t(held ? 'marketPublish.outcome.held' : 'marketPublish.outcome.published', {
          name,
          version: outcome.version,
        })
      : outcome.kind === 'unlisted'
        ? t('marketPublish.outcome.unlisted', { name })
        : outcome.kind === 'publishing'
          ? t('marketPublish.outcome.publishing', { name })
          : outcome.kind === 'unlisting'
            ? t('marketPublish.outcome.unlisting', { name })
            : failed
              ? t(unlist ? 'marketPublish.outcome.unlistFailed' : 'marketPublish.outcome.failed', {
                  name,
                })
              : t(`marketPublish.outcome.${outcome.kind}`, { name })
  const meta =
    outcome.kind === 'published'
      ? held
        ? [
            t('marketPublish.heldMeta'),
            entry.previous ? t('marketPublish.heldStays', { previous: entry.previous }) : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : `@${outcome.handle}/${entry.item.slug} · ${t(`marketPublish.visibility.${entry.visibility}`)}`
      : !busy && !done && !failed && !unlist
        ? t('marketPublish.keptDraft')
        : null
  const device = entry.device ? entry.device.name : null
  const problems = failed ? outcome.problems : []
  return (
    <div className="ks-answered" data-kind={done ? 'done' : 'other'}>
      <div className="ks-answered__head">
        {busy ? <Spinner className="size-4" /> : <Icon icon={glyph} size={16} />}
        <span className="ks-answered__title">{title}</span>
        {(meta || device) && (
          <span className="ks-answered__device">
            · {[meta, device].filter(Boolean).join(' · ')}
          </span>
        )}
        {failed && problems.length > 0 && (
          <button
            type="button"
            className="ks-answered__toggle"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open
              ? t('marketPublish.hideProblems')
              : t('marketPublish.showProblems', { count: problems.length })}
            <Icon icon={ArrowDown01Icon} size={14} />
          </button>
        )}
      </div>
      {failed && (
        <p data-selectable="" className="ks-answered__quote">
          {outcome.message}
        </p>
      )}
      {failed && open && (
        <ul className="ks-answered__list" data-selectable="">
          {problems.map((p, i) => (
            <li key={i}>
              {p.path && <span className="ks-answered__question">{p.path}</span>}
              <span className="ks-answered__answer">{p.text ?? p.message}</span>
            </li>
          ))}
        </ul>
      )}
      {!failed && <div className="ks-answered__end" />}
    </div>
  )
}

/** An agent asked to publish to the Kettu Marketplace, or to unlist a listing. */
export const MarketPublishEntry = memo(function MarketPublishEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const entry = useEntry(sessionId, entryId, 'market_publish')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <div data-entry-id={entry.id} className={cn('min-w-0', animation)}>
      {entry.outcome === null ? (
        <PublishCard sessionId={sessionId} entry={entry} agentName={agentName} />
      ) : (
        <PublishSettled entry={entry} />
      )}
    </div>
  )
})
