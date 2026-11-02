import { memo, useEffect, useRef, useState, type RefObject } from 'react'
import { BotIcon, CheckIcon, ChevronRightIcon, CircleAlertIcon, SquareIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { useMessageScroller } from '@renderer/components/ui/message-scroller'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { RingSpinner, Spinner } from '@renderer/components/ui/spinner'
import { SessionMenuItems, SessionTitleField } from '@renderer/features/sidebar/session-menu'
import { runSessionMenuAccelerator } from '@renderer/features/sidebar/session-menu-model'
import { useRenaming } from '@renderer/features/sidebar/use-renaming'
import { duration } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { openSession } from '@renderer/stores/view'
import { useRevealRequest, useRevealScroll } from '../reveal-subagent'
import {
  useLoadSubagent,
  useProgressOf,
  useSubagentDigest,
  type SubagentStep,
} from '../subagent/progress'
import { useEntry, useEntryAnimation } from '../use-thread'
import { PANEL, toolLabel } from './helpers'
import { ToolCard } from './tool-card'
import type { EntryProps } from './basic'

// An open block lists its latest steps; the full log has the rest.
const STEPS_SHOWN = 8
// How long a block brought into view stays marked.
const HIGHLIGHT_MS = 1600

/**
 * A sub-agent the agent started, in its parent's thread: name, task, tool calls and time, open to
 * its steps with Stop and its full log.
 */
export const SubagentCard = memo(function SubagentCard({
  sessionId,
  entryId,
  projectPath,
}: EntryProps & { projectPath: string }) {
  const entry = useEntry(sessionId, entryId, 'subagent')
  const animation = useEntryAnimation(sessionId, entryId)
  const child = useSessionsStore((s) => (entry ? s.byId[entry.sessionId] : undefined))
  if (!entry) return null
  return (
    <SubagentBlock
      entryId={entryId}
      childId={entry.sessionId}
      child={child}
      projectPath={projectPath}
      className={animation}
    />
  )
})

function SubagentBlock({
  entryId,
  childId,
  child,
  projectPath,
  className,
}: {
  entryId: string
  childId: string
  child: SessionSummary | undefined
  projectPath: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const root = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLButtonElement>(null)
  const waiting = !!child && (child.permissionCount > 0 || child.attention === 'permission')
  // Closed until the reader opens it, except while it waits for an answer the reader must give.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? waiting
  const visible = useInView(root)
  useLoadSubagent(child, { open, visible })
  const digest = useSubagentDigest(childId)
  const progress = useProgressOf(child, digest)
  const rename = useRenaming(() => header.current)

  const { scrollToMessage } = useMessageScroller()
  const [highlight, setHighlight] = useState(0)
  const reveal = useRevealRequest(entryId)
  useRevealScroll(
    reveal,
    () => root.current,
    (behavior) => scrollToMessage(entryId, { align: 'center', behavior }),
    () => setHighlight((n) => n + 1),
  )
  useEffect(() => {
    if (!highlight) return
    const timer = setTimeout(() => setHighlight(0), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlight])

  const { running } = progress
  const failed = !!child && (child.attention === 'error' || child.status === 'failed')
  const cancelled = !running && !failed && digest?.stopReason === 'cancelled'
  const meta = waiting
    ? t('status.needsApproval')
    : [
        cancelled ? t('status.cancelled') : null,
        progress.tools === null ? null : t('subagent.tools', { count: progress.tools }),
        progress.elapsedMs === null ? null : duration(progress.elapsedMs),
      ]
        .filter(Boolean)
        .join(t('summary.separator'))

  const block = (
    <div
      ref={root}
      className={cn(
        'relative overflow-hidden rounded-xl bg-card text-ui text-card-foreground shadow-card',
        // Open, the request's own card carries the ring.
        waiting && !open && 'shadow-attention',
        className,
      )}
    >
      <Collapsible open={open} onOpenChange={setUserOpen}>
        {rename.renaming && child ? (
          <div className={HEADER}>
            <BotTile />
            <SessionTitleField
              summary={child}
              onDone={rename.finish}
              className="h-6 min-w-0 flex-1 rounded-sm bg-transparent px-0.5 font-medium outline-[1.5px] outline-offset-0 outline-edit-ring outline-solid selection:bg-edit-selection aria-invalid:outline-danger"
            />
          </div>
        ) : (
          <CollapsibleTrigger
            ref={header}
            className={cn(
              HEADER,
              'group/header w-full rounded-t-xl text-left outline-none transition-colors duration-(--duration-fast) not-data-panel-open:rounded-b-xl hover:bg-hover focus-visible:outline-[1.5px] focus-visible:-outline-offset-[1.5px] focus-visible:outline-focus focus-visible:outline-solid',
            )}
          >
            <BotTile />
            <span className="max-w-1/2 min-w-0 shrink-0 truncate font-medium text-primary">
              {child ? sessionTitle(child) : t('subagent.fallbackTitle')}
            </span>
            <span className="min-w-0 flex-1 truncate text-tertiary">{child?.description}</span>
            {meta && (
              <span className="shrink-0 text-caption whitespace-nowrap text-tertiary tabular-nums">
                {meta}
              </span>
            )}
            <span className="grid w-4 shrink-0 place-items-center">
              {waiting ? (
                <span
                  role="img"
                  aria-label={t('status.needsApproval')}
                  className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_color-mix(in_srgb,var(--attention-dot)_16%,transparent)]"
                />
              ) : failed ? (
                <CircleAlertIcon
                  role="img"
                  aria-label={t('status.failed')}
                  className="size-3.5 text-danger"
                />
              ) : running ? (
                <RingSpinner aria-label={t('status.running')} className="size-3" />
              ) : child && !cancelled ? (
                <CheckIcon
                  role="img"
                  aria-label={t('status.done')}
                  strokeWidth={1.9}
                  className="size-3 text-success"
                />
              ) : null}
            </span>
            <span className="grid size-6 shrink-0 place-items-center rounded-tile text-tertiary transition-colors duration-(--duration-fast) group-hover/header:text-secondary">
              <ChevronRightIcon
                aria-hidden
                strokeWidth={1.6}
                className={cn(
                  'size-3 transition-transform duration-(--duration-base) ease-standard motion-reduce:transition-none',
                  open && 'rotate-90',
                )}
              />
            </span>
          </CollapsibleTrigger>
        )}
        <CollapsibleContent className={PANEL} keepMounted={false}>
          <SubagentSteps
            childId={childId}
            child={child}
            steps={digest?.steps ?? null}
            canCancel={!!digest?.canCancel}
            running={running}
            projectPath={projectPath}
          />
        </CollapsibleContent>
      </Collapsible>
      {highlight > 0 && (
        <span
          key={highlight}
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-out rounded-[inherit] ring-[1.5px] ring-focus ring-inset fade-out fill-mode-forwards animation-delay-(--duration-slower) animation-duration-(--duration-slower)"
        />
      )}
    </div>
  )

  if (!child) return block
  return (
    <ContextMenu onOpenChangeComplete={rename.menu.onOpenChangeComplete}>
      <ContextMenuTrigger render={block} className="select-auto" />
      <ContextMenuContent finalFocus={rename.menu.finalFocus} onKeyDown={runSessionMenuAccelerator}>
        {/* A sub-agent's menu has no Delete: it goes when its parent goes. */}
        <SessionMenuItems
          summary={child}
          onRename={rename.menu.onRename}
          onNewSubSession={rename.menu.onLeave}
          onDelete={() => {}}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

const HEADER = 'flex h-[38px] items-center gap-[9px] pr-2 pl-2.5'

function BotTile() {
  return (
    <span className="grid size-[22px] shrink-0 place-items-center rounded-tile bg-subtle text-secondary">
      <BotIcon aria-hidden strokeWidth={1.4} className="size-[13px]" />
    </span>
  )
}

/** The open block: its latest steps, the running one turning, then Stop and Open full log. */
function SubagentSteps({
  childId,
  child,
  steps,
  canCancel,
  running,
  projectPath,
}: {
  childId: string
  child: SessionSummary | undefined
  steps: SubagentStep[] | null
  canCancel: boolean
  running: boolean
  projectPath: string
}) {
  const { t } = useTranslation('session')
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = steps?.slice(-STEPS_SHOWN) ?? []
  const earlier = (steps?.length ?? 0) - shown.length

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await host('sessions.cancel', { sessionId: childId })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStopping(false)
    }
  }

  return (
    // Lined up with the name: the header's 10 px, the 22 px tile and the 9 px gap.
    <div className="border-t border-subtle pt-1 pr-3 pb-2.5 pl-[41px]">
      {steps === null ? (
        <div aria-hidden className="flex flex-col">
          <span className="flex h-6 items-center">
            <Skeleton className="h-2.5 w-44 rounded-sm" />
          </span>
          <span className="flex h-6 items-center">
            <Skeleton className="h-2.5 w-28 rounded-sm" />
          </span>
        </div>
      ) : (
        <ol className="flex flex-col">
          {earlier > 0 && (
            <li className="flex h-6 items-center text-hint text-tertiary">
              {t('subagent.earlier', { count: earlier })}
            </li>
          )}
          {shown.map((step) => (
            <Step
              key={step.id}
              childId={childId}
              step={step}
              agentId={child?.agentId}
              projectPath={projectPath}
            />
          ))}
        </ol>
      )}
      <div className="mt-2.5 flex min-w-0 items-center gap-1.5">
        {running && canCancel && (
          <Button
            variant="outline"
            size="sm"
            className="h-6.5 px-3"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? (
              <Spinner data-icon="inline-start" className="size-3.5" />
            ) : (
              <SquareIcon data-icon="inline-start" strokeWidth={1.5} className="size-3.5" />
            )}
            {t('subagent.stop')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          // Alone, its text lines up with the steps above.
          className="h-6.5 px-3 first:-ml-3"
          disabled={!child}
          onClick={() => child && openSession(child.id, child.projectPath)}
        >
          {t('subagent.openLog')}
        </Button>
        {error && (
          <span role="alert" className="min-w-0 truncate text-xs text-danger">
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

/** A step as a line, verb and target; one waiting for an answer as its card, to answer it here. */
function Step({
  childId,
  step,
  agentId,
  projectPath,
}: {
  childId: string
  step: SubagentStep
  agentId: SessionSummary['agentId'] | undefined
  projectPath: string
}) {
  const { t } = useTranslation('session')
  // The card reads the entry from the watched thread, which a waiting sub-agent has.
  const card = useThreadsStore((s) => step.waiting && !!s.replicas[childId]?.state?.byId[step.id])
  if (card && agentId) {
    return (
      <li className="-ml-[29px] py-1">
        <ToolCard
          sessionId={childId}
          entryId={step.id}
          projectPath={projectPath}
          agentName={agentName(agentId)}
        />
      </li>
    )
  }
  const label = toolLabel(step, projectPath)
  const active = step.status === 'pending' || step.status === 'in_progress'
  return (
    <li className="flex h-6 min-w-0 items-center gap-2 text-hint text-tertiary">
      {step.waiting ? (
        <span
          role="img"
          aria-label={t('status.needsApproval')}
          className="size-1.5 shrink-0 rounded-full bg-attention-dot"
        />
      ) : (
        active && <RingSpinner aria-label={t('status.running')} className="size-[11px]" />
      )}
      {label.verb && (
        <span
          className={cn(
            'shrink-0 font-medium',
            step.status === 'failed' ? 'text-danger' : 'text-secondary',
          )}
        >
          {label.verb}
        </span>
      )}
      {label.target && (
        <span
          className={cn('min-w-0 truncate', label.kind !== 'title' && 'font-mono text-caption')}
        >
          {label.target}
        </span>
      )}
    </li>
  )
}

/** Whether the element is in its scroller's view, or within a screen's reach of it. */
function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.at(-1)?.isIntersecting ?? false),
      {
        root: element.closest('[data-slot="message-scroller-viewport"]'),
        rootMargin: '50% 0px',
      },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return inView
}
