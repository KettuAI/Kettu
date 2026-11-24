// The Requests pane: each request the session made to its model, by turn, as the agent recorded
// it. A row opens in place to its parameters, tokens, what it sent and received, and its records.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowDownLeft01Icon,
  ArrowUpRight01Icon,
  InformationCircleIcon,
  ArrowRight01Icon,
  AttachmentIcon,
  Copy01Icon,
  Layers01Icon,
  Message01Icon,
  Robot01Icon,
  Tick02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { CodeBlock } from 'streamdown'
import {
  cacheHitShare,
  foldedBytes,
  inputTotal,
  type LastRequest,
  type ModelRequest,
  type RequestActionKind,
  type RequestPart,
  type RequestPartKind,
  type RequestTokens,
  type RequestTurn,
  type RequestsSource,
  type RequestsSystem,
} from '@shared/model-requests'
import type { SessionView } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { KIND_GLYPH } from '@renderer/features/session/entries/tool-call-model'
import {
  BlockAction,
  BlockFrame,
  BlockSpacer,
} from '@renderer/features/session/markdown/block-frame'
import { foldLines } from '@renderer/features/session/markdown/code-meta'
import { useSessionView } from '@renderer/features/session/use-thread'
import { Glyph } from '@renderer/features/shell/glyph'
import { PaneBody, PaneEmpty, PaneIcon } from '@renderer/features/shell/panel-button'
import {
  bytes,
  clockTime,
  daysBefore,
  exactCount,
  monthDay,
  shortDuration,
  tokens,
  usd,
} from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { panelSession } from '@renderer/stores/view'
import { REQUESTS_ICON } from './icon'
import { useModelRequests, useRequestRaw } from './use-model-requests'
import './requests-pane.css'

const ACTION_GLYPH: Record<RequestActionKind, IconSvgElement> = {
  thinking: KIND_GLYPH.think,
  read: KIND_GLYPH.read,
  search: KIND_GLYPH.search,
  edit: KIND_GLYPH.edit,
  run: KIND_GLYPH.execute,
  web: KIND_GLYPH.fetch,
  agent: Robot01Icon,
  reply: Message01Icon,
  tool: KIND_GLYPH.other,
}

const PART_GLYPH: Record<RequestPartKind, IconSvgElement> = {
  prompt: UserIcon,
  'tool-result': KIND_GLYPH.execute,
  attachment: AttachmentIcon,
  thinking: KIND_GLYPH.think,
  text: Message01Icon,
  'tool-call': KIND_GLYPH.other,
  other: Message01Icon,
}

/** The time a request went out, to the second. */
function secondsTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

const share = (value: number): string => `${Math.round(value * 100)}%`

function hitTone(hit: number | null): string | undefined {
  if (hit === null) return undefined
  return hit >= 0.8 ? 'kr-good' : hit >= 0.4 ? 'kr-warn' : 'kr-bad'
}

export default function RequestsPane({ panel }: { panel: string }) {
  const { t } = useTranslation('requests')
  const sessionId = panelSession(panel) ?? ''
  const session = useSessionView(sessionId)
  const data = useModelRequests(sessionId)
  const running = session?.status === 'running'
  // An agent that does not count its requests has them all counted once every page is read.
  const count =
    data.overview?.requests ??
    (data.overview && !data.more
      ? data.turns.reduce((n, turn) => n + turn.requests.length, 0)
      : null)

  let body: ReactNode
  if (data.available === false) {
    body = (
      <PaneEmpty
        icon={<PaneIcon icon={REQUESTS_ICON} />}
        title={t('unavailable.title')}
        text={t('unavailable.text')}
      />
    )
  } else if (data.error && data.turns.length === 0) {
    body = (
      <PaneEmpty icon={<PaneIcon icon={Alert02Icon} />} title={t('error.title')} text={data.error}>
        <Button size="sm" variant="outline" onClick={data.retry}>
          {t('error.retry')}
        </Button>
      </PaneEmpty>
    )
  } else if (data.available === null) {
    body = <Loading />
  } else if (data.turns.length === 0) {
    body = (
      <PaneEmpty
        icon={<PaneIcon icon={REQUESTS_ICON} />}
        title={t('empty.title')}
        text={data.source === 'acp' ? t('acp.empty') : t('empty.text')}
      />
    )
  } else {
    body = (
      <RequestList
        sessionId={sessionId}
        session={session}
        source={data.source ?? 'claude'}
        turns={data.turns}
        system={data.overview?.system ?? null}
        recorded={data.overview?.tokens ?? null}
        ordinals={data.overview?.turns ?? null}
        costUsd={data.overview?.costUsd ?? null}
        requests={count}
        more={data.more}
        loadingOlder={data.loadingOlder}
        onOlder={data.loadOlder}
      />
    )
  }

  return (
    <PaneBody>
      {count !== null && data.source && (
        <p className="kr-head">
          {data.source === 'acp'
            ? t('acp.summary', { count })
            : running
              ? t('summaryLive', { count })
              : t('summary', { count, source: t(`source.${data.source}`) })}
        </p>
      )}
      <div className="kp-body kr-body">{body}</div>
    </PaneBody>
  )
}

function Loading() {
  return (
    <div className="kr-scroll" aria-busy="true">
      <Skeleton className="kr-skel-card" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="kr-skel-row" />
      ))}
    </div>
  )
}

function RequestList({
  sessionId,
  session,
  source,
  turns,
  system,
  recorded,
  ordinals,
  costUsd,
  requests,
  more,
  loadingOlder,
  onOlder,
}: {
  sessionId: string
  session: SessionView | undefined
  source: RequestsSource
  turns: RequestTurn[]
  system: RequestsSystem | null
  recorded: RequestTokens | null
  ordinals: Record<string, number> | null
  costUsd: number | null
  requests: number | null
  more: boolean
  loadingOlder: boolean
  onOlder: () => void
}) {
  const { t } = useTranslation('requests')
  const scroller = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const [openRequest, setOpenRequest] = useState<string | null>(null)
  const [systemOpen, setSystemOpen] = useState(false)
  const newest = turns.at(-1)?.id
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  // The newest turn starts open, the earlier ones folded.
  const isFolded = (turn: RequestTurn) => folded[turn.id] ?? turn.id !== newest

  // The pane opens on the newest requests, as the thread does.
  const placed = useRef(false)
  useLayoutEffect(() => {
    if (placed.current || !scroller.current) return
    placed.current = true
    scroller.current.scrollTop = scroller.current.scrollHeight
  }, [turns])

  useEffect(() => {
    const root = scroller.current
    const target = sentinel.current
    if (!root || !target || !more) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onOlder()
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [more, onOlder])

  return (
    <div ref={scroller} className="kr-scroll">
      {source === 'acp' && (
        <AcpBody
          sessionId={sessionId}
          turns={turns}
          running={session?.status === 'running'}
          openRequest={openRequest}
          onToggle={(id) => setOpenRequest(openRequest === id ? null : id)}
        />
      )}
      {source !== 'acp' && (
        <>
          <Totals
            session={session}
            source={source}
            recorded={recorded}
            costUsd={costUsd}
            requests={requests}
          />
          {system && (
            <SystemRow
              sessionId={sessionId}
              system={system}
              open={systemOpen}
              onToggle={() => setSystemOpen(!systemOpen)}
            />
          )}
          <div ref={sentinel} className="kr-older">
            {more ? (loadingOlder ? t('loadingOlder') : t('older')) : t('start')}
          </div>
          {turns.map((turn) => {
            const open = !isFolded(turn)
            return (
              <section key={turn.id} className="kr-turn">
                <TurnHead
                  turn={turn}
                  index={turn.index ?? ordinals?.[turn.id] ?? null}
                  open={open}
                  running={turn.id === newest && session?.status === 'running'}
                  onToggle={() => setFolded({ ...folded, [turn.id]: open })}
                />
                {open && (
                  <>
                    <div className="kr-cols" aria-hidden>
                      <span />
                      <span />
                      <span>{t('cols.request')}</span>
                      <span>{t('cols.input')}</span>
                      <span>{t('cols.output')}</span>
                      <span>{t('cols.cached')}</span>
                      <span>{t('cols.took')}</span>
                    </div>
                    {turn.requests.map((request) => {
                      const live =
                        request.status === 'running' && session?.status === 'running'
                          ? session.lastRequest
                          : undefined
                      return (
                        <RequestRow
                          key={request.id}
                          sessionId={sessionId}
                          source={source}
                          request={request}
                          live={live}
                          open={openRequest === request.id}
                          onToggle={() =>
                            setOpenRequest(openRequest === request.id ? null : request.id)
                          }
                        />
                      )
                    })}
                  </>
                )}
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}

/**
 * An ACP session: ACP reports each turn but not each request to the model, so a row is a turn,
 * read from the messages Kettu exchanged since it started.
 */
function AcpBody({
  sessionId,
  turns,
  running,
  openRequest,
  onToggle,
}: {
  sessionId: string
  turns: RequestTurn[]
  running: boolean
  openRequest: string | null
  onToggle: (id: string) => void
}) {
  const { t } = useTranslation('requests')
  const rows = turns.flatMap((turn) => turn.requests.map((request) => ({ turn, request })))
  const count = (parts: RequestPart[]) => parts.reduce((sum, p) => sum + (p.count ?? 1), 0)
  const tools = (request: ModelRequest) =>
    request.actions
      .filter((a) => a.kind !== 'thinking' && a.kind !== 'reply')
      .reduce((sum, a) => sum + a.count, 0)
  const took = (request: ModelRequest) =>
    request.sentAt !== null && request.endedAt !== null ? request.endedAt - request.sentAt : 0
  const all = rows.map(({ request }) => request)
  const spent = all.reduce((sum, r) => sum + took(r), 0)
  const usedTokens = all.some((r) => inputTotal(r.tokens) !== null)
    ? all.reduce((sum, r) => sum + (inputTotal(r.tokens) ?? 0) + (r.tokens.output ?? 0), 0)
    : null
  const cell = (label: string, value: ReactNode) => (
    <div>
      <small>{label}</small>
      <b className="tabular">{value ?? '—'}</b>
    </div>
  )
  return (
    <>
      <p className="kr-note">
        <Glyph icon={InformationCircleIcon} size={14} />
        {t('acp.note')}
      </p>
      <div className="kr-totals">
        {cell(t('acp.turns'), exactCount(rows.length))}
        {cell(t('acp.messages'), exactCount(all.reduce((sum, r) => sum + r.records, 0)))}
        {cell(t('acp.tools'), exactCount(all.reduce((sum, r) => sum + tools(r), 0)))}
        {cell(t('acp.took'), spent > 0 ? shortDuration(spent) : null)}
        {cell(t('acp.tokens'), usedTokens === null ? null : tokens(usedTokens))}
      </div>
      <div className="kr-cols" aria-hidden>
        <span />
        <span />
        <span>{t('acp.turn')}</span>
        <span>{t('acp.sent')}</span>
        <span>{t('acp.updates')}</span>
        <span>{t('acp.tools')}</span>
        <span>{t('cols.took')}</span>
      </div>
      {rows.map(({ turn, request }) => {
        const open = openRequest === request.id
        const live = request.status === 'running' && running
        return (
          <div key={request.id}>
            <button
              type="button"
              className="kr-row"
              data-open={open || undefined}
              data-failed={request.status === 'failed' || undefined}
              aria-expanded={open}
              onClick={() => onToggle(request.id)}
            >
              {live ? (
                <span className="kr-spin" aria-hidden />
              ) : (
                <Glyph icon={ArrowRight01Icon} size={12} className="kr-row__chev" />
              )}
              <span className="kr-row__time tabular">
                {request.sentAt !== null ? secondsTime(request.sentAt) : ''}
              </span>
              <span className="kr-row__what">
                {request.status === 'failed' && (
                  <Glyph icon={Alert02Icon} size={13} className="kr-bad" />
                )}
                <span className="kr-row__words">{turn.prompt || t('turnEarlier')}</span>
              </span>
              <span className="kr-num tabular">{count(request.sent)}</span>
              <span className="kr-num tabular">{count(request.received)}</span>
              <span className="kr-num tabular">{tools(request)}</span>
              <span className="kr-num tabular kr-faint">
                {took(request) > 0 ? shortDuration(took(request)) : live ? '…' : '—'}
              </span>
            </button>
            {open && <AcpDetail sessionId={sessionId} request={request} />}
          </div>
        )
      })}
    </>
  )
}

function AcpDetail({ sessionId, request }: { sessionId: string; request: ModelRequest }) {
  const { t } = useTranslation('requests')
  const line = (part: RequestPart, dir: 'out' | 'in') => (
    <Line
      key={`${dir}-${part.label}`}
      icon={dir === 'out' ? ArrowUpRight01Icon : ArrowDownLeft01Icon}
      label={part.label}
      text={part.preview}
      size={part.count && part.count > 1 ? `×${part.count}` : null}
      error={part.error}
    />
  )
  const total = request.sent.length + request.received.length
  return (
    <div className="kr-detail">
      {request.stop && (
        <div className="kr-facts">
          <span className="kr-fact">
            {t('detail.stop')} <b>{request.stop}</b>
          </span>
        </div>
      )}
      {request.error && (
        <p role="alert" className="kr-error">
          <Glyph icon={Alert02Icon} size={13} />
          {request.error}
        </p>
      )}
      {inputTotal(request.tokens) !== null && <TokenSplit tokens={request.tokens} />}
      <Section label={t('acp.groups', { count: request.records })} meta={t('acp.grouped')}>
        {total === 0 ? (
          <p className="kr-none">{t('detail.nothingReceived')}</p>
        ) : (
          <>
            {request.sent.map((part) => line(part, 'out'))}
            {request.received.map((part) => line(part, 'in'))}
          </>
        )}
      </Section>
      <Section label={t('detail.raw')} meta={t('acp.raw')}>
        <RawJson key={request.raw} sessionId={sessionId} raw={request.raw} />
      </Section>
    </div>
  )
}

/** The session's tokens: as the agent's record adds them up, else as Kettu counted them. */
function sessionTokens(
  recorded: RequestTokens | null,
  session: SessionView | undefined,
): RequestTokens | null {
  if (recorded) return recorded
  const counted = session?.usage?.tokens
  if (!counted) return null
  return {
    input: counted.input,
    cacheRead: counted.cacheRead,
    cacheWrite: counted.cacheWrite,
    cacheWrite1h: null,
    output: counted.output,
    reasoning: counted.thought,
  }
}

function Totals({
  session,
  source,
  recorded,
  costUsd,
  requests,
}: {
  session: SessionView | undefined
  source: RequestsSource
  recorded: RequestTokens | null
  costUsd: number | null
  requests: number | null
}) {
  const { t } = useTranslation('requests')
  const totals = sessionTokens(recorded, session)
  const input = totals ? inputTotal(totals) : null
  const hit = totals ? cacheHitShare(totals) : null
  const cell = (label: string, value: ReactNode) => (
    <div>
      <small>{label}</small>
      <b className="tabular">{value ?? '—'}</b>
    </div>
  )
  return (
    <div className="kr-totals">
      {cell(t('totals.requests'), requests === null ? null : exactCount(requests))}
      {cell(t('totals.input'), input === null ? null : tokens(input))}
      {cell(t('totals.cached'), hit === null ? null : share(hit))}
      {cell(t('totals.output'), totals?.output == null ? null : tokens(totals.output))}
      {source === 'codex' ? (
        cell(t('totals.reasoning'), totals?.reasoning == null ? null : tokens(totals.reasoning))
      ) : costUsd !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div>
                <small>{t('totals.cost')}</small>
                <b className="tabular">
                  ≈ {usd(costUsd)} <em>{t('totals.api')}</em>
                </b>
              </div>
            }
          />
          <TooltipContent>{t('totals.costHint')}</TooltipContent>
        </Tooltip>
      ) : (
        cell(t('totals.cost'), null)
      )}
    </div>
  )
}

function SystemRow({
  sessionId,
  system,
  open,
  onToggle,
}: {
  sessionId: string
  system: RequestsSystem
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('requests')
  // Codex keeps its instructions, not a system prompt.
  const instructions = system.kind === 'instructions'
  const chars = system.blocks.reduce((sum, block) => sum + block.chars, 0)
  return (
    <div className="kr-system" data-open={open || undefined}>
      <button type="button" className="kr-system__head" aria-expanded={open} onClick={onToggle}>
        <span className="kr-tile">
          <Glyph icon={Layers01Icon} size={14} />
        </span>
        <span className="kr-system__text">
          <b>{instructions ? t('system.instructions') : t('system.title')}</b>
          <small>
            {[
              t('system.line', {
                blocks: system.blocks.length,
                chars: tokens(chars),
                tools: system.toolCount ?? 0,
              }),
              system.changes.length > 0 && t('system.changed', { count: system.changes.length }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </span>
        <Glyph icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={13} className="kr-faint" />
      </button>
      {open && (
        <div className="kr-detail kr-detail--flat">
          <Section
            label={
              instructions
                ? t('system.instructionBlocks', { count: system.blocks.length })
                : t('system.blocks', { count: system.blocks.length })
            }
          >
            {system.blocks.map((block, i) => (
              <Line
                key={i}
                icon={Layers01Icon}
                label={String(i + 1)}
                text={block.preview}
                size={t('system.chars', { chars: tokens(block.chars) })}
              />
            ))}
          </Section>
          <Section
            label={t('system.tools', { count: system.toolCount ?? 0 })}
            meta={system.changes.at(-1) && <ToolChange change={system.changes.at(-1)!} />}
          >
            {system.groups.map((group) => (
              <Line
                key={group.name}
                icon={KIND_GLYPH.other}
                label={
                  group.kind === 'builtin'
                    ? t('system.builtin')
                    : group.kind === 'mcp'
                      ? t('system.mcp', { name: group.name })
                      : group.name
                }
                text={group.tools.join(', ')}
                size={String(group.tools.length)}
              />
            ))}
          </Section>
          <Section
            label={t('detail.raw')}
            meta={instructions ? t('system.codexRaw') : t('system.raw')}
          >
            <RawJson sessionId={sessionId} raw="system" />
          </Section>
        </div>
      )}
    </div>
  )
}

function ToolChange({ change }: { change: RequestsSystem['changes'][number] }) {
  const { t } = useTranslation('requests')
  const time = change.at === null ? '' : clockTime(change.at)
  const names = (list: string[]) => list.map((name) => name.replace(/^mcp__.+?__/, '')).join(', ')
  return (
    <>
      {change.added.length > 0 && t('system.added', { tools: names(change.added), time })}
      {change.added.length > 0 && change.removed.length > 0 && ' · '}
      {change.removed.length > 0 && t('system.removed', { tools: names(change.removed), time })}
    </>
  )
}

function TurnHead({
  turn,
  index,
  open,
  running,
  onToggle,
}: {
  turn: RequestTurn
  index: number | null
  open: boolean
  running: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('requests')
  const last = turn.requests.at(-1)
  const start = turn.startedAt ?? turn.requests[0]?.sentAt ?? null
  const end = last?.endedAt ?? last?.sentAt ?? null
  const time = running
    ? t('turnRunning')
    : start !== null && end !== null && end >= start
      ? shortDuration(end - start)
      : ''
  return (
    <button type="button" className="kr-turn__head" aria-expanded={open} onClick={onToggle}>
      <b>
        {index !== null
          ? t('turn', { index })
          : // An agent that does not number its turns names one by when it began.
            turn.prompt && start !== null
            ? t('turnAt', {
                time:
                  daysBefore(start) === 0
                    ? clockTime(start)
                    : `${monthDay(start)} ${clockTime(start)}`,
              })
            : t('turnEarlier')}
      </b>
      {turn.prompt && <span className="kr-turn__prompt">{t('you', { text: turn.prompt })}</span>}
      <span className="kr-turn__meta tabular">
        {t('turnMeta', { count: turn.requests.length, time })}
      </span>
      <Glyph icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={13} className="kr-faint" />
    </button>
  )
}

/** A request's tokens, with what the stream reported for one still running. */
function shownTokens(request: ModelRequest, live: LastRequest | undefined): RequestTokens {
  if (!live || inputTotal(request.tokens) !== null) return request.tokens
  return {
    ...request.tokens,
    input: live.input,
    cacheRead: live.cacheRead,
    cacheWrite: live.cacheWrite,
  }
}

function RequestRow({
  sessionId,
  source,
  request,
  live,
  open,
  onToggle,
}: {
  sessionId: string
  source: RequestsSource
  request: ModelRequest
  live: LastRequest | undefined
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('requests')
  const running = request.status === 'running'
  const failed = request.status === 'failed'
  const shown = shownTokens(request, live)
  const input = inputTotal(shown)
  const hit = cacheHitShare(shown)
  const took =
    request.sentAt !== null && request.endedAt !== null && request.endedAt >= request.sentAt
      ? shortDuration(request.endedAt - request.sentAt)
      : null
  return (
    <>
      <button
        type="button"
        className="kr-row"
        data-open={open || undefined}
        data-failed={failed || undefined}
        aria-expanded={open}
        onClick={onToggle}
      >
        {running ? (
          <span className="kr-spin" aria-hidden />
        ) : (
          <Glyph icon={ArrowRight01Icon} size={12} className="kr-row__chev" />
        )}
        <span className="kr-row__time tabular">
          {request.sentAt !== null ? secondsTime(request.sentAt) : ''}
        </span>
        <span className="kr-row__what">
          {failed && <Glyph icon={Alert02Icon} size={13} className="kr-bad" />}
          {request.actions.length === 0 && (
            <span className="kr-faint">{failed ? t('failed') : '…'}</span>
          )}
          {request.actions.length > 0 && <ActionSummary actions={request.actions} />}
        </span>
        <span className="kr-num tabular">{input === null ? '—' : tokens(input)}</span>
        <span className="kr-num tabular">
          {running ? '…' : shown.output === null ? '—' : tokens(shown.output)}
        </span>
        <span className={cn('kr-num tabular', hitTone(hit))}>
          {hit === null ? '—' : share(hit)}
        </span>
        <span className="kr-num tabular kr-faint">{took ?? (running ? '…' : '—')}</span>
      </button>
      {open && (
        <RequestDetail sessionId={sessionId} source={source} request={request} tokens={shown} />
      )}
    </>
  )
}

/**
 * What a request did in one line: a glyph for each kind of thing, then the words of its main one,
 * the first tool call or else the reply or the thinking, and how many more calls it made.
 */
function ActionSummary({ actions }: { actions: ModelRequest['actions'] }) {
  const { t } = useTranslation('requests')
  const calls = actions.filter((a) => a.kind !== 'thinking' && a.kind !== 'reply')
  const main = calls[0] ?? actions.find((a) => a.kind === 'reply') ?? actions[0]!
  const others =
    calls.slice(1).reduce((sum, a) => sum + a.count, 0) + (calls[0] ? calls[0].count - 1 : 0)
  const kinds = [...new Set(actions.map((a) => a.kind))]
  const words =
    main.kind === 'thinking' || main.kind === 'reply'
      ? t(`action.${main.kind}`)
      : main.count > 1 && calls.length === 1
        ? `${main.label} ×${main.count}`
        : main.label
  return (
    <>
      <span className="kr-glyphs" aria-hidden>
        {kinds.map((kind) => (
          <Glyph key={kind} icon={ACTION_GLYPH[kind]} size={13} />
        ))}
      </span>
      <span className="kr-row__words">{words}</span>
      {others > 0 && !(main.count > 1 && calls.length === 1) && (
        <span className="kr-more tabular">+{others}</span>
      )}
    </>
  )
}

function RequestDetail({
  sessionId,
  source,
  request,
  tokens: shown,
}: {
  sessionId: string
  source: RequestsSource
  request: ModelRequest
  tokens: RequestTokens
}) {
  const { t } = useTranslation('requests')
  return (
    <div className="kr-detail">
      <div className="kr-facts">
        {request.model && <span className="kr-fact kr-mono">{request.model}</span>}
        {request.params.map((param) => (
          <span key={param.name} className="kr-fact">
            {param.name} <b>{param.value}</b>
          </span>
        ))}
        {request.stop && (
          <span className="kr-fact">
            {t('detail.stop')} <b>{request.stop}</b>
          </span>
        )}
        {request.requestId && <span className="kr-fact kr-mono">{request.requestId}</span>}
      </div>
      {request.error && (
        <p role="alert" className="kr-error">
          <Glyph icon={Alert02Icon} size={13} />
          {request.error}
        </p>
      )}
      <TokenSplit tokens={shown} />
      <Section
        label={t('detail.sent')}
        meta={
          request.kept !== null && request.added !== null
            ? t('detail.kept', { kept: request.kept, added: request.added })
            : undefined
        }
      >
        {request.sent.length === 0 ? (
          <p className="kr-none">{t('detail.nothingSent')}</p>
        ) : (
          request.sent.map((part, i) => <PartLine key={i} part={part} />)
        )}
      </Section>
      <Section label={t('detail.received')}>
        {request.received.length === 0 ? (
          <p className="kr-none">{t('detail.nothingReceived')}</p>
        ) : (
          request.received.map((part, i) => <PartLine key={i} part={part} />)
        )}
      </Section>
      <Section
        label={t('detail.raw')}
        meta={t('detail.records', { count: request.records, source: t(`source.${source}`) })}
      >
        <RawJson key={request.raw} sessionId={sessionId} raw={request.raw} />
      </Section>
    </div>
  )
}

function TokenSplit({ tokens: shown }: { tokens: RequestTokens }) {
  const { t } = useTranslation('requests')
  const parts = [
    { key: 'read', value: shown.cacheRead, label: t('detail.cacheRead') },
    { key: 'write', value: shown.cacheWrite, label: t('detail.cacheWrite') },
    { key: 'input', value: shown.input, label: t('detail.input') },
    { key: 'output', value: shown.output, label: t('detail.output') },
  ]
  const total = parts.reduce((sum, part) => sum + (part.value ?? 0), 0)
  if (total === 0) return null
  const ttl =
    shown.cacheWrite && shown.cacheWrite1h !== null
      ? shown.cacheWrite1h >= shown.cacheWrite
        ? '1h'
        : shown.cacheWrite1h === 0
          ? '5m'
          : null
      : null
  return (
    <div className="kr-tokens">
      <div className="kr-bar" aria-hidden>
        {parts.map(
          (part) =>
            (part.value ?? 0) > 0 && (
              <i
                key={part.key}
                data-part={part.key}
                style={{ width: `max(${((part.value ?? 0) / total) * 100}%, 3px)` }}
              />
            ),
        )}
      </div>
      <dl className="kr-split">
        {parts.map((part) => (
          <div key={part.key}>
            <dt>
              <i data-part={part.key} aria-hidden />
              {part.label}
            </dt>
            <dd className="tabular">
              {part.value === null ? '—' : exactCount(part.value)}
              {part.key === 'write' && ttl && <em>{ttl}</em>}
              {part.key === 'output' && shown.reasoning ? (
                <em>{t('detail.thinking', { tokens: exactCount(shown.reasoning) })}</em>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Section({
  label,
  meta,
  children,
}: {
  label: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="kr-section">
      <div className="kr-section__label">
        <span>{label}</span>
        {meta && <span className="kr-section__meta">{meta}</span>}
      </div>
      {children}
    </section>
  )
}

function Line({
  icon,
  label,
  text,
  size,
  error,
}: {
  icon: IconSvgElement
  label: string
  text: string
  size?: string | null
  error?: boolean
}) {
  return (
    <div className="kr-line" data-error={error || undefined}>
      <Glyph icon={icon} size={13} />
      <b>{label}</b>
      <span className="kr-line__text">{text}</span>
      {size && <span className="kr-line__size tabular">{size}</span>}
    </div>
  )
}

function PartLine({ part }: { part: RequestPart }) {
  const { t } = useTranslation('requests')
  const label =
    part.kind === 'tool-call' || part.kind === 'attachment' ? part.label : t(`part.${part.kind}`)
  return (
    <Line
      icon={PART_GLYPH[part.kind]}
      label={label}
      text={part.preview}
      size={part.bytes !== null && part.bytes > 0 ? bytes(part.bytes) : null}
      error={part.error}
    />
  )
}

/** The records as JSON, folded strings written as how much they hold. */
function rawText(records: unknown[], folded: (n: number) => string): string {
  return JSON.stringify(
    records,
    (_key, value: unknown) => {
      const n = foldedBytes(value)
      return n === null ? value : folded(n)
    },
    2,
  )
}

function RawJson({ sessionId, raw }: { sessionId: string; raw: string }) {
  const { t } = useTranslation('requests')
  const { t: ts } = useTranslation('session')
  const { value, error, full, showFull } = useRequestRaw(sessionId, raw)
  const [linesFolded, setLinesFolded] = useState(true)
  const [copied, setCopied] = useState(false)
  if (error) return <p className="kr-error">{error}</p>
  if (!value) return <Skeleton className="kr-skel-raw" />
  const code = rawText(value.records, (n) => `… ${bytes(n)} folded`)
  const { shown, hidden } = foldLines(code, linesFolded)
  const copy = () => {
    full()
      .then((whole) => navigator.clipboard.writeText(JSON.stringify(whole.records, null, 2)))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <BlockFrame
      className="kr-raw"
      // Records hold long strings, which read better wrapped than scrolled.
      data-wrap=""
      header={
        <>
          <span className="block-frame-lang">json</span>
          <BlockSpacer />
          {value.folded && (
            <Button size="xs" variant="quiet" onClick={showFull}>
              {t('detail.showFull')}
            </Button>
          )}
          <BlockAction label={copied ? t('detail.copied') : t('detail.copy')} onClick={copy}>
            <Glyph icon={copied ? Tick02Icon : Copy01Icon} size={14} />
          </BlockAction>
        </>
      }
    >
      <CodeBlock code={shown} language="json" lineNumbers />
      {hidden > 0 || !linesFolded ? (
        <button
          type="button"
          className="block-frame-more"
          onClick={() => setLinesFolded(!linesFolded)}
        >
          {linesFolded ? ts('block.showMore', { count: hidden }) : ts('block.showLess')}
        </button>
      ) : null}
    </BlockFrame>
  )
}
