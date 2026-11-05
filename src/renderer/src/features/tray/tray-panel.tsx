import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  AppWindowIcon,
  CheckIcon,
  ChevronLeftIcon,
  PlusIcon,
  Settings2Icon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { AnimatePresence, MotionConfig, motion, type Variants } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import type { SessionSummary } from '@shared/agent-host'
import type { BrowserOriginDecision } from '@shared/browser'
import type { RemoteStatus } from '@shared/remote/status'
import type { TrayTarget } from '@shared/tray'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { relativePath } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { glide } from '@renderer/lib/motion'
import { LIMIT_FILL, limitLevel } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  answer,
  review,
  trayApi,
  useTrayPanelStore,
  type AnswerChoice,
} from '@renderer/stores/tray-panel'
import { ago, when } from './ago'
import {
  elapsed,
  groupSessions,
  limitRows,
  type PendingRequest,
  type PendingTool,
  type SessionDetail,
  type TrayGroups,
} from './model'

const ORIGIN_DECISIONS: BrowserOriginDecision[] = ['session', 'project', 'deny']

const WANTS_KEY = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'execute',
  think: 'other',
  fetch: 'fetch',
  switch_mode: 'switchMode',
  other: 'other',
} as const

const VERB_KEY = { read: 'read', edit: 'edit', delete: 'delete', move: 'move' } as const

// Review pushes the list aside, and going back pushes it in again: `custom` is 1 into a review.
const SLIDE: Variants = {
  enter: (into: number) => ({ x: `${into * 100}%`, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (into: number) => ({ x: `${into * -100}%`, opacity: 0 }),
}

function open(target: TrayTarget): void {
  trayApi().tray.open(target)
}

/**
 * Whether the panel leaves a key press alone: an IME still composing, or Enter and Space on a
 * focused button, which press it themselves.
 */
function passes(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true
  return (event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLButtonElement
}

/** The request's target as the row's second line and the review's box show it. */
function requestTarget(
  request: PendingRequest,
  projectPath: string,
): { text: string; code: boolean } {
  if (request.kind === 'origin') return { text: request.origin, code: false }
  const { tool } = request
  if (request.permission.questions && tool.question !== undefined) {
    return { text: tool.question, code: false }
  }
  const location = tool.locations[0]?.path
  if (tool.toolKind in VERB_KEY && location) {
    return { text: relativePath(location, projectPath), code: true }
  }
  if (tool.toolKind === 'execute') {
    return { text: tool.rawInput ?? tool.title.replace(/^run\s+/i, ''), code: true }
  }
  return { text: tool.title, code: false }
}

/** The panel under Motion's reduce-motion rule, which follows the setting as the window does. */
export function TrayRoot() {
  const reduceMotion = useSettingsStore((s) => s.settings.appearance.reduceMotion)
  return (
    <MotionConfig reducedMotion={reduceMotion === 'always' ? 'always' : 'user'}>
      <TrayPanel />
    </MotionConfig>
  )
}

/** The panel: a list of what goes on, or the request the user reviews. */
export function TrayPanel() {
  const { t } = useTranslation('tray')
  const content = useRef<HTMLDivElement>(null)
  const reviewing = useTrayPanelStore((s) => s.reviewing)
  const shown = useTrayPanelStore((s) => s.shown)
  const summary = useTrayPanelStore((s) =>
    reviewing ? s.sessions[reviewing.sessionId] : undefined,
  )
  const request = useTrayPanelStore((s) =>
    reviewing
      ? s.details[reviewing.sessionId]?.requests.find((r) => r.entryId === reviewing.entryId)
      : undefined,
  )
  const reviewed = summary && request ? { summary, request } : null

  // The window takes the content's natural height; past the room main gives it, the panel scrolls.
  // Each opening reports it at once, since main shows the panel only then and a hidden page's
  // observer stays idle.
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const report = () => trayApi().tray.resize(Math.ceil(element.offsetHeight))
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => observer.disconnect()
  }, [shown])

  return (
    <div
      aria-label={t('label')}
      className="h-screen overflow-y-auto rounded-2xl bg-[color-mix(in_srgb,var(--bg-surface)_92%,transparent)] text-foreground shadow-[inset_0_0_0_1px_var(--panel-highlight)]"
    >
      <div ref={content} className="relative flex flex-col overflow-hidden">
        <AnimatePresence key={shown} initial={false} mode="popLayout" custom={reviewed ? 1 : -1}>
          <motion.div
            key={reviewed ? `${reviewed.summary.id}:${reviewed.request.entryId}` : 'list'}
            custom={reviewed ? 1 : -1}
            variants={SLIDE}
            initial="enter"
            animate="center"
            exit="exit"
            transition={glide}
            className="flex flex-col"
          >
            {reviewed ? <Review summary={reviewed.summary} request={reviewed.request} /> : <List />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

function List() {
  const { t } = useTranslation('tray')
  const sessions = useTrayPanelStore((s) => s.sessions)
  const details = useTrayPanelStore((s) => s.details)
  const loaded = useTrayPanelStore((s) => s.loaded)
  const groups = groupSessions(Object.values(sessions))
  const idle = loaded && !busy(groups)
  const rows = [...groups.needsYou, ...groups.running, ...groups.finished, ...groups.recent]
  const menu: { icon: LucideIcon; label: string; keys: string; target: TrayTarget }[] = idle
    ? [
        { icon: PlusIcon, label: t('newSession'), keys: '⌘N', target: { kind: 'new-session' } },
        { icon: AppWindowIcon, label: t('openKettu'), keys: '⌘O', target: { kind: 'app' } },
      ]
    : []
  const items = [...menu.map((m) => `menu:${m.target.kind}`), ...rows.map((s) => s.id)]
  const [chosen, setHighlight] = useState<string | null>(null)
  // Until the arrows or the pointer pick a row, ↵ reviews the first waiting request.
  const highlight = chosen && items.includes(chosen) ? chosen : (groups.needsYou[0]?.id ?? null)
  const activate = (id: string) => {
    const item = menu.find((m) => `menu:${m.target.kind}` === id)
    if (item) return open(item.target)
    if (groups.needsYou.some((s) => s.id === id) && details[id]?.requests.length) return review(id)
    open({ kind: 'session', sessionId: id })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A held key repeats into the view it opened, which must never answer for the user.
      if (passes(event) || event.repeat) return
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'n') open({ kind: 'new-session' })
      else if (mod && event.key.toLowerCase() === 'o') open({ kind: 'app' })
      else if (mod && event.key === ',') open({ kind: 'settings' })
      else if (event.key === 'Escape') trayApi().tray.hide()
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const at = highlight ? items.indexOf(highlight) : -1
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next = items[(at + step + items.length) % items.length]
        if (next) setHighlight(next)
      } else if (event.key === 'Enter' && highlight && items.includes(highlight)) {
        activate(highlight)
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const row = (summary: SessionSummary, mark: ReactNode, line: string, action?: ReactNode) => (
    <SessionRow
      key={summary.id}
      summary={summary}
      line={line}
      mark={mark}
      action={action}
      highlighted={highlight === summary.id}
      onHover={() => setHighlight(summary.id)}
    />
  )

  return (
    <>
      <Header groups={groups} idle={idle} />
      <div>
        <div>
          {idle && (
            <div className="px-1.5 py-1">
              {menu.map((item) => (
                <MenuRow
                  key={item.target.kind}
                  {...item}
                  highlighted={highlight === `menu:${item.target.kind}`}
                  onHover={() => setHighlight(`menu:${item.target.kind}`)}
                />
              ))}
            </div>
          )}
          {groups.needsYou.length > 0 && <GroupLabel>{t('group.needsYou')}</GroupLabel>}
          {groups.needsYou.map((s) =>
            row(
              s,
              <WaitingDot />,
              waitingLine(s, details[s.id]),
              details[s.id]?.requests.length ? (
                <ReviewButton onClick={() => review(s.id)} />
              ) : undefined,
            ),
          )}
          {groups.running.length > 0 && <GroupLabel>{t('group.running')}</GroupLabel>}
          {groups.running.map((s) => (
            <RunningRow key={s.id} summary={s} detail={details[s.id]}>
              {(line) => row(s, <RingSpinner aria-label={t('status.running')} />, line)}
            </RunningRow>
          ))}
          {groups.finished.length > 0 && <GroupLabel>{t('group.finished')}</GroupLabel>}
          {groups.finished.map((s) =>
            row(s, <UnreadDot failed={s.attention === 'error'} />, finishedLine(s, details[s.id])),
          )}
          {idle && groups.recent.length > 0 && (
            <>
              <Divider />
              <GroupLabel>{t('group.recent')}</GroupLabel>
              {groups.recent.map((s) =>
                row(
                  s,
                  s.status === 'failed' ? (
                    <XIcon
                      aria-label={t('status.failed')}
                      strokeWidth={1.9}
                      className="size-3 text-danger"
                    />
                  ) : (
                    <CheckIcon
                      aria-label={t('status.done')}
                      strokeWidth={1.9}
                      className="size-3 text-success"
                    />
                  ),
                  when(s.updatedAt),
                ),
              )}
            </>
          )}
        </div>
      </div>
      <Limits />
      <Footer />
    </>
  )
}

function busy(groups: TrayGroups): boolean {
  return groups.needsYou.length + groups.running.length + groups.finished.length > 0
}

/** A tool's step as a row's second line: "Run pnpm test", "Edit src/app.ts", or its title. */
function toolLine(tool: PendingTool, projectPath: string): string {
  const location = tool.locations[0]?.path
  if (tool.toolKind === 'execute') {
    const command = tool.rawInput ?? tool.title.replace(/^run\s+/i, '')
    return `${i18n.t('session:tool.verb.run')} ${command}`
  }
  if (tool.toolKind in VERB_KEY && location) {
    const verb = i18n.t(`session:tool.verb.${VERB_KEY[tool.toolKind as keyof typeof VERB_KEY]}`)
    return `${verb} ${relativePath(location, projectPath)}`
  }
  return tool.title
}

function waitingLine(summary: SessionSummary, detail: SessionDetail | undefined): string {
  const request = detail?.requests[0]
  if (!request) return ''
  return request.kind === 'origin' ? request.origin : toolLine(request.tool, summary.projectPath)
}

function finishedLine(summary: SessionSummary, detail: SessionDetail | undefined): string {
  const done =
    summary.attention === 'error'
      ? i18n.t('tray:failedAgo', { ago: ago(summary.updatedAt) })
      : i18n.t('tray:doneAgo', { ago: ago(summary.updatedAt) })
  const files = detail?.files ?? 0
  return files > 0 ? `${done} · ${i18n.t('tray:files', { count: files })}` : done
}

/** A running row's second line: the step the agent takes and the turn's time so far. */
function RunningRow({
  summary,
  detail,
  children,
}: {
  summary: SessionSummary
  detail: SessionDetail | undefined
  children: (line: string) => ReactNode
}) {
  const { t } = useTranslation('tray')
  const now = useNow()
  const what =
    summary.origin === 'routine'
      ? t('routine')
      : detail?.activity
        ? toolLine(detail.activity, summary.projectPath)
        : t('working')
  const started = detail?.turnStartedAt ?? null
  if (started === null) return children(what)
  const { h, m } = elapsed(now - started)
  const time = h > 0 ? t('elapsedHours', { h, m }) : t('elapsedMinutes', { count: m })
  return children(`${what} · ${time}`)
}

function Header({ groups, idle }: { groups: TrayGroups; idle: boolean }) {
  const { t } = useTranslation('tray')
  const remote = useTrayPanelStore((s) => s.remote)
  const latest = useTrayPanelStore((s) =>
    Object.values(s.sessions).reduce((at, x) => Math.max(at, x.updatedAt), 0),
  )
  const elsewhere = useTrayPanelStore((s) =>
    s.answeredElsewhere ? (s.sessions[s.answeredElsewhere]?.title ?? t('untitled')) : null,
  )
  const host = remote?.hostName ?? ''
  const parts = [
    groups.needsYou.length > 0 && t('headline.needsYou', { count: groups.needsYou.length }),
    groups.running.length > 0 && t('headline.running', { count: groups.running.length }),
  ].filter(Boolean)
  const title =
    parts.length > 0
      ? parts.join(' · ')
      : groups.finished.length > 0
        ? t('headline.finished', { count: groups.finished.length })
        : t('headline.quiet')
  const subtitle = idle && latest > 0 ? t('lastSession', { host, ago: ago(latest) }) : host
  return (
    <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
      <BrandIcon size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-control/[1.3] font-semibold text-primary">{title}</div>
        {elsewhere === null ? (
          <div className="truncate text-caption/[1.3] text-tertiary">{subtitle}</div>
        ) : (
          <div role="status" className="truncate text-caption/[1.3] text-tertiary">
            {t('answeredElsewhere', { title: elsewhere })}
          </div>
        )}
      </div>
      <IconButton label={`${t('newSession')} ⌘N`} onClick={() => open({ kind: 'new-session' })}>
        <PlusIcon className="size-3.75" />
      </IconButton>
      <IconButton label={t('settings')} onClick={() => open({ kind: 'settings' })}>
        <Settings2Icon className="size-3.75" />
      </IconButton>
    </div>
  )
}

function IconButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string
  onClick(): void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex size-6.5 shrink-0 items-center justify-center rounded-[7px] text-secondary outline-none focus-ring hover:bg-hover hover:text-primary',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** A session's agent mark; the panel never loads the agents store, so the dot comes from its own. */
function SessionMark({ agent }: { agent: AgentId }) {
  const dot = useTrayPanelStore((s) => s.agents.find((a) => a.id === agent)?.color ?? null)
  return <AgentMark agent={agent} size={16} dot={dot} />
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-6 items-center px-3.5 text-caption font-medium text-tertiary">
      {children}
    </div>
  )
}

function Divider() {
  return <div aria-hidden className="my-1.25 h-px bg-border-soft" />
}

function SessionRow({
  summary,
  line,
  mark,
  action,
  highlighted,
  onHover,
}: {
  summary: SessionSummary
  line: string
  mark: ReactNode
  action?: ReactNode
  highlighted: boolean
  onHover(): void
}) {
  const { t } = useTranslation('tray')
  return (
    <div
      onMouseMove={onHover}
      className={cn(
        'mx-1.5 flex min-h-12.5 items-center gap-2.25 rounded-tile px-2 py-1.25',
        highlighted && 'bg-selected',
      )}
    >
      <button
        type="button"
        onClick={() => open({ kind: 'session', sessionId: summary.id })}
        className="flex min-w-0 flex-1 items-center gap-2.25 rounded-md text-left outline-none focus-ring"
      >
        <SessionMark agent={summary.agentId} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-control/[1.3] text-primary">
            {summary.title ?? t('untitled')}
          </span>
          {line && <span className="block truncate text-caption/[1.3] text-tertiary">{line}</span>}
        </span>
      </button>
      {action}
      <span className="flex w-3.5 shrink-0 justify-center">{mark}</span>
    </div>
  )
}

function ReviewButton({ onClick }: { onClick(): void }) {
  const { t } = useTranslation('tray')
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 shrink-0 items-center rounded-xl bg-card px-3 text-control font-medium whitespace-nowrap text-primary shadow-[0_0_0_var(--hairline)_var(--border-default),var(--elevation-control)] outline-none focus-ring hover:bg-hover"
    >
      {t('review')}
    </button>
  )
}

function WaitingDot() {
  const { t } = useTranslation('tray')
  return (
    <span
      role="img"
      aria-label={t('status.needsYou')}
      className="size-1.75 rounded-full bg-attention-dot shadow-[0_0_0_3px_color-mix(in_srgb,var(--attention-dot)_18%,transparent)]"
    />
  )
}

function UnreadDot({ failed }: { failed: boolean }) {
  const { t } = useTranslation('tray')
  return (
    <span
      role="img"
      aria-label={t(failed ? 'status.failed' : 'status.unread')}
      className={cn('size-1.5 rounded-full', failed ? 'bg-danger' : 'bg-muted-foreground')}
    />
  )
}

function MenuRow({
  icon: Icon,
  label,
  keys,
  target,
  highlighted,
  onHover,
}: {
  icon: LucideIcon
  label: string
  keys: string
  target: TrayTarget
  highlighted: boolean
  onHover(): void
}) {
  return (
    <button
      type="button"
      onMouseMove={onHover}
      onClick={() => open(target)}
      className={cn(
        'flex h-7.5 w-full items-center gap-2.25 rounded-tile px-2 text-left text-menu whitespace-nowrap text-primary outline-none focus-ring',
        highlighted && 'bg-selected',
      )}
    >
      <span className="flex w-4 justify-center text-secondary">
        <Icon strokeWidth={1.4} className="size-3.75" />
      </span>
      <span className="min-w-0">{label}</span>
      <span className="ml-auto pl-4 text-small text-tertiary tabular">{keys}</span>
    </button>
  )
}

function Limits() {
  const { t } = useTranslation('tray')
  const agents = useTrayPanelStore((s) => s.agents)
  const now = useNow()
  const rows = limitRows(agents, now)
  if (rows.length === 0) return <div className="h-1.5" />
  return (
    <>
      <Divider />
      <GroupLabel>{t('group.limits')}</GroupLabel>
      {rows.map(({ agent, plan, limit }) => {
        const used = Math.round(limit.usedPercent ?? 0)
        return (
          <div key={agent.id} className="flex h-6 items-center gap-2 px-3.5">
            <AgentMark agent={agent.id} size={14} dot={agent.color ?? null} />
            <span className="min-w-0 flex-1 truncate text-small text-secondary">
              {plan ? t('limitLabel', { agent: agent.name, plan }) : agent.name}
            </span>
            <span className="h-1 w-17.5 overflow-hidden rounded-full bg-border-soft">
              <span
                className={cn('block h-full', LIMIT_FILL[limitLevel(limit)])}
                style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
              />
            </span>
            <span className="w-7.5 text-right text-caption text-primary tabular">{used}%</span>
          </div>
        )
      })}
      <div className="h-1.5" />
    </>
  )
}

function remoteLine(remote: RemoteStatus | null): { text: string; dot: string } {
  switch (remote?.state ?? 'off') {
    case 'on':
      return {
        text: i18n.t('tray:remote.devices', { count: remote!.online.length }),
        dot: 'bg-success',
      }
    case 'starting':
      return { text: i18n.t('tray:remote.starting'), dot: 'bg-warning' }
    case 'failed':
      return { text: i18n.t('tray:remote.failed'), dot: 'bg-danger' }
    default:
      return { text: i18n.t('tray:remote.off'), dot: 'bg-border-strong' }
  }
}

function Footer() {
  const { t } = useTranslation('tray')
  const remote = useTrayPanelStore((s) => s.remote)
  const connection = useTrayPanelStore((s) => s.connection)
  const down = connection === 'failed'
  const line = remoteLine(remote)
  return (
    <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--bg-subtle)_60%,transparent)] px-3 py-2 text-small leading-[normal] text-secondary shadow-[inset_0_1px_0_var(--border-subtle)]">
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', down ? 'bg-danger' : line.dot)}
      />
      <span className="min-w-0 flex-1 truncate whitespace-nowrap">
        {down ? t('hostDown') : line.text}
      </span>
      <button
        type="button"
        onClick={() => open({ kind: 'app' })}
        className="shrink-0 rounded-sm whitespace-nowrap text-secondary outline-none focus-ring hover:text-primary"
      >
        {t('openKettu')} ⌘O
      </button>
      <span aria-hidden className="text-border-strong">
        ·
      </span>
      <button
        type="button"
        onClick={() => trayApi().tray.quit()}
        className="shrink-0 rounded-sm text-tertiary outline-none focus-ring hover:text-primary"
      >
        {t('quit')}
      </button>
    </div>
  )
}

/** The request the user answers here: what the agent wants, and its answers by number. */
function Review({ summary, request }: { summary: SessionSummary; request: PendingRequest }) {
  const { t } = useTranslation(['tray', 'session'])
  const waiting = useTrayPanelStore((s) =>
    groupSessions(Object.values(s.sessions)).needsYou.reduce(
      (n, x) => n + Math.max(1, s.details[x.id]?.requests.length ?? 0),
      0,
    ),
  )
  // Questions are answered in the window: the panel has no room for their steps and text.
  const asks = request.kind === 'tool' && request.permission.questions !== undefined
  const options: { label: string; choice: AnswerChoice | null }[] = asks
    ? [{ label: t('answerInKettu'), choice: null }]
    : request.kind === 'tool'
      ? request.permission.options.map((o) => ({ label: o.name, choice: { optionId: o.id } }))
      : ORIGIN_DECISIONS.map((decision) => ({
          label: t(`session:browserOrigin.decision.${decision}`),
          choice: { decision },
        }))
  const primary =
    request.kind === 'tool' && !asks
      ? Math.max(
          0,
          request.permission.options.findIndex((o) => o.kind === 'allow_once'),
        )
      : 0
  const [highlight, setHighlight] = useState(primary)
  const [failure, setFailure] = useState<string | null>(null)
  const sending = useRef(false)
  const target = requestTarget(request, summary.projectPath)
  const wants = asks
    ? t('wants.question')
    : request.kind === 'origin'
      ? t('wants.origin')
      : t(`wants.${WANTS_KEY[request.tool.toolKind]}`)

  const choose = (index: number) => {
    const option = options[index]
    if (!option || sending.current) return
    if (option.choice === null) {
      open({ kind: 'session', sessionId: summary.id })
      return
    }
    sending.current = true
    setHighlight(index)
    void answer(summary.id, request, option.choice).then((message) => {
      sending.current = false
      if (message) setFailure(t('answerFailed', { message }))
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A held key repeats into the view it opened, which must never answer for the user.
      if (passes(event) || event.repeat) return
      if (event.key === 'Escape' || event.key === 'ArrowLeft') review(null)
      else if (event.key === 'ArrowDown') setHighlight((i) => (i + 1) % options.length)
      else if (event.key === 'ArrowUp')
        setHighlight((i) => (i - 1 + options.length) % options.length)
      else if (event.key === 'Enter') choose(highlight)
      else if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey) {
        choose(Number(event.key) - 1)
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2.5 shadow-[inset_0_-1px_0_var(--border-subtle)]">
        <IconButton label={t('back')} onClick={() => review(null)} className="size-6">
          <ChevronLeftIcon className="size-3.5" />
        </IconButton>
        <SessionMark agent={summary.agentId} />
        <span className="min-w-0 flex-1 truncate text-control font-semibold text-primary">
          {summary.title ?? t('untitled')}
        </span>
      </div>
      <div className="px-3 pt-2.5 pb-1 text-hint leading-[normal] text-secondary">{wants}</div>
      <div
        data-selectable
        className={cn(
          'mx-3 max-h-30 overflow-y-auto rounded-tile bg-code-block px-2.5 py-2 text-primary shadow-[inset_0_0_0_1px_var(--border-subtle)] wrap-anywhere whitespace-pre-wrap',
          target.code ? 'font-mono text-command leading-[normal]' : 'text-small leading-[normal]',
        )}
      >
        {target.text}
      </div>
      <div role="group" aria-label={t('answerGroup')} className="px-1.5 pt-2 pb-1.5">
        {options.map((option, i) => (
          <button
            key={i}
            type="button"
            onMouseMove={() => setHighlight(i)}
            onClick={() => choose(i)}
            className={cn(
              'flex h-8 w-full items-center gap-2.25 rounded-lg px-2 text-left text-control text-primary outline-none focus-ring',
              highlight === i && 'bg-selected',
            )}
          >
            <span
              className={cn(
                'flex h-4.5 min-w-4.5 items-center justify-center rounded-md text-[10.5px] font-semibold',
                highlight === i
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-secondary shadow-[0_0_0_var(--hairline)_var(--border-default),var(--elevation-control)]',
              )}
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {highlight === i && <span className="text-small text-tertiary">↵</span>}
          </button>
        ))}
      </div>
      {failure && <div className="px-3 pb-1.5 text-caption text-danger">{failure}</div>}
      <div className="px-3 pb-2.5 text-caption leading-[normal] text-tertiary">
        {waiting > 1 && <>{t('moreWaiting', { count: waiting - 1 })} · </>}
        <button
          type="button"
          onClick={() => open({ kind: 'session', sessionId: summary.id })}
          className="rounded-sm text-secondary underline outline-none focus-ring"
        >
          {t('openInKettu')}
        </button>
      </div>
    </>
  )
}
