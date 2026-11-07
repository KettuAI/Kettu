import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  AiChat02Icon,
  AlertCircleIcon,
  ArrowRight01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { Button } from '@renderer/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { useMessageScroller } from '@renderer/components/ui/message-scroller'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { SessionMenuItems } from '@renderer/features/sidebar/session-menu'
import { runSessionMenuAccelerator } from '@renderer/features/sidebar/session-menu-model'
import { useRenaming } from '@renderer/features/sidebar/use-renaming'
import { duration } from '@renderer/lib/format'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { useRevealRequest, useRevealScroll } from '../reveal-subagent'
import { useLoadSubagent, useProgressOf, useSubagentDigest } from '../subagent/progress'
import { useEntry, useEntryAnimation } from '../use-thread'
import type { EntryProps } from './basic'

// How long a block brought into view stays marked.
const HIGHLIGHT_MS = 1600

/** A sub-agent's progress in its parent's thread, opening its detail page. */
export const SubagentCard = memo(function SubagentCard({ sessionId, entryId }: EntryProps) {
  const entry = useEntry(sessionId, entryId, 'subagent')
  const animation = useEntryAnimation(sessionId, entryId)
  const child = useSessionsStore((s) => (entry ? s.byId[entry.sessionId] : undefined))
  if (!entry) return null
  return (
    <SubagentBlock
      entryId={entryId}
      childId={entry.sessionId}
      child={child}
      className={animation}
    />
  )
})

function SubagentBlock({
  entryId,
  childId,
  child,
  className,
}: {
  entryId: string
  childId: string
  child: SessionSummary | undefined
  className?: string
}) {
  const { t } = useTranslation('session')
  // Both: the ref is current at once for a reveal, and the state lets the observer follow the
  // root, a new element once the context menu wraps it.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const attachRoot = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element
    setRoot(element)
  }, [])
  const header = useRef<HTMLButtonElement>(null)
  const waiting = !!child && (child.permissionCount > 0 || child.attention === 'permission')
  const visible = useInView(root)
  useLoadSubagent(child, visible)
  const digest = useSubagentDigest(childId)
  const progress = useProgressOf(child, digest)
  const rename = useRenaming(() => header.current)

  const { scrollToMessage } = useMessageScroller()
  const [highlight, setHighlight] = useState(0)
  const reveal = useRevealRequest(entryId)
  useRevealScroll(
    reveal,
    () => rootRef.current,
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
      ref={attachRoot}
      data-waiting={waiting || undefined}
      className={cn('ks-subagent', className)}
    >
      <Button
        ref={header}
        variant="ghost"
        disabled={!child}
        onClick={() => child && openSession(child.id, child.projectPath)}
        className="ks-subagent__head focus-visible:ring-inset"
      >
        <HugeiconsIcon
          icon={AiChat02Icon}
          strokeWidth={1.9}
          aria-hidden
          className="ks-subagent__icon size-4 shrink-0"
        />
        <span className="ks-subagent__name">
          {child ? sessionTitle(child) : t('subagent.fallbackTitle')}
        </span>
        <span className="ks-subagent__desc">{child?.description}</span>
        {meta && <span className="ks-subagent__meta tabular-nums">{meta}</span>}
        <span className="grid w-4 shrink-0 place-items-center">
          {waiting ? (
            <span
              role="img"
              aria-label={t('status.needsApproval')}
              className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]"
            />
          ) : failed ? (
            <HugeiconsIcon
              icon={AlertCircleIcon}
              strokeWidth={1.9}
              role="img"
              aria-label={t('status.failed')}
              className="size-3.5 text-danger"
            />
          ) : running ? (
            <RingSpinner aria-label={t('status.running')} className="size-3" />
          ) : child && !cancelled ? (
            <HugeiconsIcon
              icon={Tick02Icon}
              strokeWidth={1.9}
              role="img"
              aria-label={t('status.done')}
              className="size-3 text-success"
            />
          ) : null}
        </span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={1.9}
          aria-hidden
          className="ks-subagent__chevron size-4 shrink-0"
        />
      </Button>
      {highlight > 0 && (
        <span
          key={highlight}
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-out rounded-[inherit] ring-[1.5px] ring-focus ring-inset fade-out fill-mode-forwards delay-(--duration-slower) animation-duration-(--duration-slower)"
        />
      )}
    </div>
  )

  if (!child) return block
  return (
    <ContextMenu onOpenChangeComplete={rename.menu.onOpenChangeComplete}>
      <ContextMenuTrigger render={block} className="select-auto" />
      <ContextMenuContent
        finalFocus={rename.menu.finalFocus}
        onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
      >
        {/* A sub-agent's menu has no Delete: it goes when its parent goes. */}
        <SessionMenuItems
          summary={child}
          onNewSubSession={rename.menu.onLeave}
          onDelete={() => {}}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Whether the element is in its scroller's view, or within a screen's reach of it. */
function useInView(element: HTMLElement | null): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
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
  }, [element])
  return inView
}
