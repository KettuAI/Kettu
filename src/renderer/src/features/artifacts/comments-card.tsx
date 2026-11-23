import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Comment01Icon,
  FilterHorizontalIcon,
  MoreHorizontalIcon,
  SentIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { isPending, type ArtifactComment, type CommentThread } from '@shared/artifact-comments'
import type { VersionSummary } from '@shared/artifacts'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { longAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { anchorLabel } from './anchors'
import { sendThreads, type CommentsArtifact } from './comment-send'
import { openOrder, threadNumbers, threadState, type ThreadState } from './comment-threads'
import { NEW_SESSION, useTargetName, type SendTargets } from './send-targets'
import { ToMenu } from './send-to'
import { CardHead } from './tool-parts'

/** A thread's state as a small tinted tag. */
export function StateTag({ state }: { state: ThreadState }) {
  const { t } = useTranslation('artifacts')
  const tone =
    state.kind === 'notSent'
      ? 'warning'
      : state.kind === 'needsReply'
        ? 'info'
        : state.kind === 'gone'
          ? 'danger'
          : state.kind === 'resolved'
            ? 'success'
            : 'neutral'
  const label =
    state.kind === 'resolved'
      ? state.version === null
        ? t('comments.state.resolved')
        : t('comments.state.resolvedIn', { version: state.version })
      : t(`comments.state.${state.kind}`)
  return (
    <span className="k-vt-tag" data-tone={tone}>
      {label}
    </span>
  )
}

/** Who wrote a comment, the user or the agent of the session that wrote it: its mark and name. */
export function Writer({
  comment,
  mark = true,
  name = true,
}: {
  comment: ArtifactComment
  mark?: boolean
  name?: boolean
}) {
  const { t } = useTranslation('artifacts')
  const session = useSessionsStore((s) =>
    comment.author.session ? (s.byId[comment.author.session] ?? null) : null,
  )
  const label =
    comment.author.session === null
      ? t('comments.you')
      : session
        ? agentName(session.agentId, hostOfSession(session))
        : t('comments.agent')
  return (
    <>
      {mark &&
        (session ? (
          <AgentMark agent={session.agentId} size={14} hostId={hostOfSession(session)} />
        ) : comment.author.session === null ? (
          <span aria-hidden className="k-vt-you" />
        ) : (
          <span aria-hidden className="k-vt-unknown" />
        ))}
      {name && <b>{label}</b>}
    </>
  )
}

/** The pin's number as the card shows it beside a row. */
function PinChip({ n, state }: { n: number; state: ThreadState }) {
  const kind = state.kind === 'resolved' ? 'done' : state.kind === 'gone' ? 'lost' : undefined
  return (
    <span className="k-vt-pinchip" data-kind={kind}>
      {kind === 'done' ? <Icon icon={Tick02Icon} size={12} stroke={2.2} /> : n}
    </span>
  )
}

type Tab = 'open' | 'resolved'

/**
 * The Comments card: the open threads, those asking back first, and the resolved ones in a tab of
 * their own; the unsent ones go together from its foot to one session.
 */
export function CommentsCard({
  artifact,
  threads,
  error,
  versions,
  targets,
  target,
  onTarget,
  selected,
  tab,
  onTab,
  pageFiles,
  onFocus,
  hint,
  emptyText,
}: {
  artifact: CommentsArtifact
  threads: CommentThread[] | null
  error: string | null
  versions: readonly VersionSummary[] | null
  targets: SendTargets
  target: string
  onTarget: (target: string) => void
  /** The thread whose row is picked, and whose pin is lit. */
  selected: string | null
  tab: Tab
  onTab: (tab: Tab) => void
  /** The files of the page on screen, for This page; null where there is one page. */
  pageFiles: ReadonlySet<string> | null
  onFocus: (thread: CommentThread) => void
  /** What a click on the content does, under the title. */
  hint: string
  /** What the empty card says, for the kind shown. */
  emptyText: string
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  const [onlyPage, setOnlyPage] = useState(false)
  const [onlyUnsent, setOnlyUnsent] = useState(false)
  const all = useMemo(() => threads ?? [], [threads])
  const numbers = useMemo(() => threadNumbers(all), [all])
  const open = useMemo(() => openOrder(all), [all])
  const resolved = useMemo(
    () =>
      all
        .filter((thread) => thread.resolvedAt !== null)
        .toSorted((a, b) => b.resolvedAt! - a.resolvedAt!),
    [all],
  )
  const pending = open.filter(isPending)
  const onPage = (thread: CommentThread) =>
    !onlyPage || !pageFiles || pageFiles.has(thread.anchor.path)
  const list = (
    tab === 'open' ? open.filter((th) => !onlyUnsent || isPending(th)) : resolved
  ).filter(onPage)

  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selected) return
    box.current
      ?.querySelector(`[data-thread="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected])

  const [sending, setSending] = useState<string[] | null>(null)
  const [failed, setFailed] = useState<{ ids: string[]; error: string } | null>(null)
  const name = useTargetName()
  const send = (batch: readonly CommentThread[]) => {
    if (batch.length === 0 || sending) return
    const ids = batch.map((thread) => thread.id)
    setSending(ids)
    setFailed(null)
    sendThreads(artifact, batch, target)
      .catch((reason: unknown) => setFailed({ ids, error: errorMessage(reason) }))
      .finally(() => setSending(null))
  }

  let body: React.ReactNode
  if (error && !threads) body = <p className="k-av-error k-vt-pad">{error}</p>
  else if (!threads) {
    body = (
      <div aria-busy className="k-av-side__wait k-vt-pad">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    )
  } else if (all.length === 0) {
    body = (
      <div className="k-vt-empty">
        <Icon icon={Comment01Icon} size={20} />
        <b>{t('comments.emptyTitle')}</b>
        <p>{emptyText}</p>
      </div>
    )
  } else if (list.length === 0) {
    body = (
      <p className="k-vt-none">
        {tab === 'resolved'
          ? t('comments.noneResolved')
          : onlyUnsent
            ? t('comments.allSentList')
            : t('comments.noneOpen')}
      </p>
    )
  } else {
    body = list.map((thread) => (
      <ThreadRow
        key={thread.id}
        thread={thread}
        n={numbers.get(thread.id) ?? 0}
        state={threadState(thread, versions)}
        selected={thread.id === selected}
        compact={tab === 'resolved'}
        onFocus={() => onFocus(thread)}
        onSendOnly={isPending(thread) ? () => send([thread]) : null}
        onReopen={
          tab === 'resolved'
            ? () =>
                void host('artifacts.resolve', {
                  id: artifact.id,
                  threadId: thread.id,
                  resolved: false,
                }).then(() => onTab('open'))
            : null
        }
      />
    ))
  }

  return (
    <aside aria-label={t('comments.title')} className="k-av-side k-vt-card">
      <CardHead icon={Comment01Icon} title={t('comments.title')} sub={hint} />
      {all.length > 0 && (
        <div className="k-vt-bar">
          <SegmentedControl<Tab>
            aria-label={t('comments.title')}
            variant="tray"
            size="sm"
            kind="tabs"
            value={tab}
            onChange={onTab}
            options={[
              { value: 'open', label: t('comments.open'), count: open.length },
              { value: 'resolved', label: t('comments.resolvedTab') },
            ]}
          />
          <Dropdown
            align="end"
            items={[
              ...(pageFiles
                ? [
                    {
                      label: t('comments.allPages'),
                      checked: !onlyPage,
                      onSelect: () => setOnlyPage(false),
                    },
                    {
                      label: t('comments.thisPage'),
                      checked: onlyPage,
                      onSelect: () => setOnlyPage(true),
                    },
                  ]
                : []),
              {
                label: t('comments.unsentOnly'),
                checked: onlyUnsent,
                divider: !!pageFiles,
                disabled: tab !== 'open',
                onSelect: () => setOnlyUnsent((on) => !on),
              },
            ]}
            trigger={({ open: menuOpen, toggle }) => (
              <button
                type="button"
                aria-label={t('comments.filter')}
                title={t('comments.filter')}
                aria-expanded={menuOpen}
                data-on={onlyPage || onlyUnsent || undefined}
                onClick={toggle}
                className="k-vt-icon k-vt-filter"
              >
                <Icon icon={FilterHorizontalIcon} size={15} />
              </button>
            )}
          />
        </div>
      )}
      <div ref={box} className="k-vt-list">
        {body}
      </div>
      {open.length > 0 && (
        <div className="k-vt-send">
          {failed ? (
            <p role="alert" className="k-vt-send__fail" title={failed.error}>
              {t('comments.sendFailedCount', { count: failed.ids.length })}
            </p>
          ) : null}
          <div className="k-vt-send__row">
            {sending ? (
              <span role="status" className="k-vt-send__status">
                {t('comments.sending', { count: sending.length, session: name(targets, target) })}
              </span>
            ) : (
              <ToMenu targets={targets} target={target} onPick={onTarget} />
            )}
            {failed && !sending ? (
              <Button
                size="sm"
                onClick={() => send(open.filter((th) => failed.ids.includes(th.id)))}
              >
                {t('viewer.retry')}
              </Button>
            ) : pending.length > 0 ? (
              <Button
                size="sm"
                icon={<Icon icon={SentIcon} size={14} />}
                loading={!!sending}
                onClick={() => send(pending)}
              >
                {t('comments.sendCount', { count: pending.length })}
              </Button>
            ) : (
              <span className="k-vt-allsent">
                <Icon icon={Tick02Icon} size={14} />
                {t('comments.allSentShort')}
              </span>
            )}
          </div>
          {target === NEW_SESSION && pending.length > 0 && (
            <p className="k-vt-send__note">{t('comments.newSessionNote')}</p>
          )}
        </div>
      )}
    </aside>
  )
}

function ThreadRow({
  thread,
  n,
  state,
  selected,
  compact,
  onFocus,
  onSendOnly,
  onReopen,
}: {
  thread: CommentThread
  n: number
  state: ThreadState
  selected: boolean
  compact: boolean
  onFocus: () => void
  onSendOnly: (() => void) | null
  onReopen: (() => void) | null
}) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  const first = thread.comments[0]
  const last = thread.comments.length > 1 ? thread.comments.at(-1) : undefined
  if (!first) return null
  return (
    <div
      role="button"
      tabIndex={0}
      data-thread={thread.id}
      data-selected={selected || undefined}
      data-compact={compact || undefined}
      aria-label={t('comments.rowLabel', { n, text: first.body })}
      onClick={onFocus}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onFocus()
        }
      }}
      className="k-vt-row"
    >
      <span className="k-vt-row__meta">
        <PinChip n={n} state={state} />
        <Writer comment={first} mark={!compact} />
        <time className="k-vt-row__time" dateTime={new Date(first.createdAt).toISOString()}>
          {longAgo(first.createdAt, now)}
        </time>
        <span className="k-vt-row__act" onClick={(event) => event.stopPropagation()}>
          {onReopen ? (
            <Button variant="secondary" size="sm" onClick={onReopen}>
              {t('comments.reopen')}
            </Button>
          ) : onSendOnly ? (
            <Dropdown
              align="end"
              items={[{ label: t('comments.sendOnly'), icon: SentIcon, onSelect: onSendOnly }]}
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  aria-label={t('viewer.more')}
                  title={t('viewer.more')}
                  aria-expanded={open}
                  onClick={toggle}
                  className="k-vt-icon"
                >
                  <Icon icon={MoreHorizontalIcon} size={15} />
                </button>
              )}
            />
          ) : null}
        </span>
      </span>
      <p className="k-vt-row__text">{first.body}</p>
      {last && !compact && (
        <p className="k-vt-row__reply">
          <Writer comment={last} name={false} />
          <span>{last.body}</span>
        </p>
      )}
      <span className="k-vt-row__foot">
        {!compact && <span className="k-vt-row__where">{anchorLabel(thread.anchor)}</span>}
        <StateTag state={state} />
      </span>
    </div>
  )
}
