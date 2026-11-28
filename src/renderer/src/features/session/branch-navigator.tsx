import { useCallback, useEffect, useState } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  GitBranchIcon,
  InformationCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { SessionBranchesResult, SessionBranchNode, SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession } from '@renderer/stores/sessions'
import {
  branchSwitchBlockReason,
  fetchSessionBranches,
  formatBranchTime,
  supportsNativeBranches,
  switchSessionBranch,
  type BranchSwitchBlockReason,
} from './branch-navigator-model'

/** Max visual nesting depth for indentation inside the branch list. */
const MAX_INDENT_DEPTH = 4

function blockedMessage(t: TFunction<'session'>, reason: BranchSwitchBlockReason): string {
  switch (reason) {
    case 'running':
      return t('branches.blockedRunning')
    case 'starting':
      return t('branches.blockedStarting')
    case 'rewound':
      return t('branches.blockedRewound')
    case 'archived':
      return t('branches.blockedArchived')
  }
}

function previewText(t: TFunction<'session'>, node: SessionBranchNode): string {
  if (node.preview) return node.preview
  return t(`branches.fallback.${node.previewRole}`)
}

/**
 * Header entry for browsing and switching native branches inside a single Pi session.
 * Renders nothing for harnesses without `capabilities.branches` (e.g. Claude Code, Codex, OpenCode).
 */
export function BranchNavigator({
  summary,
  session,
  archived,
}: {
  summary: SessionSummary
  session: SessionView | undefined
  archived: boolean
}) {
  const { t } = useTranslation('session')
  const hostId = hostOfSession(summary)
  const agent = useAgentsStore((s) => agentsOn(s, hostId).byId[summary.agentId])
  const supported = supportsNativeBranches(agent, summary)
  const [open, setOpen] = useState(false)
  const [cached, setCached] = useState<{
    sessionId: string
    data: SessionBranchesResult
  } | null>(null)

  const blocked = branchSwitchBlockReason(session, summary, archived)
  const acpSessionId = session?.acpSessionId ?? null
  const status = session?.status ?? summary.status
  const refreshKey = `${summary.id}:${summary.updatedAt}:${acpSessionId ?? ''}:${status}`

  // Keep the header chip count fresh as turns complete, without polling while idle.
  useEffect(() => {
    if (!supported) return
    if (status === 'starting') return
    let cancelled = false
    void fetchSessionBranches(summary)
      .then((data) => {
        if (!cancelled) setCached({ sessionId: summary.id, data })
      })
      .catch(() => {
        // Opening the popover surfaces load errors cleanly; background count stays quiet.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refreshKey` tracks the relevant session changes
  }, [supported, refreshKey])

  if (!supported) return null

  const data = cached?.sessionId === summary.id ? cached.data : null
  const branchCount = data?.branchCount ?? 0
  const hasBranches = data?.hasBranches === true
  const tooltipText =
    blocked !== null
      ? blockedMessage(t, blocked)
      : hasBranches
        ? t('branches.triggerCount', { count: branchCount })
        : t('branches.triggerLabel')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={blocked !== null ? t('branches.triggerLocked') : tooltipText}
                  data-locked={blocked !== null ? '' : undefined}
                  data-testid="session-branches-trigger"
                  className="ks-chip ks-branch-chip"
                >
                  <Icon icon={GitBranchIcon} size={13} />
                  {hasBranches && (
                    <span className="ks-chip__text tabular">
                      {t('branches.triggerCount', { count: branchCount })}
                    </span>
                  )}
                  <Icon icon={ArrowDown01Icon} size={12} />
                </button>
              }
            />
          }
        />
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="ks-branch-pop w-[360px] max-w-[min(400px,calc(100vw-24px))] gap-0 overflow-hidden p-0"
      >
        {open && (
          <BranchNavigatorPopoverContent
            summary={summary}
            initialData={data}
            blocked={blocked}
            onUpdated={(next) => setCached({ sessionId: summary.id, data: next })}
            onClose={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Mounted only while open so fresh branch state is loaded on demand and errors stay scoped. */
export function BranchNavigatorPopoverContent({
  summary,
  initialData,
  blocked,
  onUpdated,
  onClose,
}: {
  summary: Pick<SessionSummary, 'id' | 'projectPath'>
  initialData: SessionBranchesResult | null
  blocked: BranchSwitchBlockReason | null
  onUpdated: (data: SessionBranchesResult) => void
  onClose: () => void
}) {
  const { t } = useTranslation('session')
  const locale = currentLocale()
  const [data, setData] = useState<SessionBranchesResult | null>(initialData)
  const [loading, setLoading] = useState(initialData === null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    setLoading((prev) => prev || data === null)
    try {
      const next = await fetchSessionBranches(summary)
      setData(next)
      onUpdated(next)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by session identity
  }, [summary.id, summary.projectPath, onUpdated])

  useEffect(() => {
    let cancelled = false
    void fetchSessionBranches(summary)
      .then((next) => {
        if (cancelled) return
        setData(next)
        setLoadError(null)
        onUpdated(next)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(errorMessage(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount / session change
  }, [summary.id, summary.projectPath])

  const handleSelect = async (node: SessionBranchNode) => {
    if (blocked !== null || switchingId !== null || node.isCurrent) return
    setSwitchError(null)
    setSwitchingId(node.id)
    try {
      const next = await switchSessionBranch(summary, node.id)
      setData(next)
      onUpdated(next)
      onClose()
    } catch (error) {
      setSwitchError(errorMessage(error))
    } finally {
      setSwitchingId(null)
    }
  }

  const blockedText = blocked !== null ? blockedMessage(t, blocked) : null
  const nodes = data?.nodes ?? []

  return (
    <div className="ks-branch" data-testid="session-branches-popover">
      <div className="ks-branch__head">
        <div className="ks-branch__title-row">
          <Icon icon={GitBranchIcon} size={13} />
          <span className="ks-branch__title">{t('branches.title')}</span>
          {data && data.branchCount > 0 && (
            <span className="ks-branch__count tabular">
              {t('branches.triggerCount', { count: data.branchCount })}
            </span>
          )}
          {switchingId !== null && (
            <span className="ks-branch__switching" role="status">
              <Spinner className="size-3" />
              <span>{t('branches.switching')}</span>
            </span>
          )}
        </div>
        {blockedText && (
          <div className="ks-branch__notice" role="status" data-testid="session-branches-blocked">
            <span className="mt-0.5 grid shrink-0">
              <Icon icon={InformationCircleIcon} size={13} />
            </span>
            <span>{blockedText}</span>
          </div>
        )}
        {switchError && (
          <div className="ks-branch__error" role="alert" data-testid="session-branches-error">
            <span className="mt-0.5 grid shrink-0">
              <Icon icon={Alert02Icon} size={13} />
            </span>
            <span>{t('branches.switchFailed', { error: switchError })}</span>
          </div>
        )}
      </div>
      {loading && nodes.length === 0 ? (
        <div className="ks-branch__state" data-testid="session-branches-loading">
          <Spinner className="size-3.5" />
          <span>{t('branches.loading')}</span>
        </div>
      ) : loadError && nodes.length === 0 ? (
        <div className="ks-branch__state ks-branch__state--error" role="alert">
          <div className="ks-branch__error">
            <span className="mt-0.5 grid shrink-0">
              <Icon icon={Alert02Icon} size={13} />
            </span>
            <span>{t('branches.loadFailed', { error: loadError })}</span>
          </div>
          <Button variant="quiet" size="compact" onClick={() => void load()}>
            {t('branches.retry')}
          </Button>
        </div>
      ) : nodes.length === 0 ? (
        <div className="ks-branch__empty" data-testid="session-branches-empty">
          {t('branches.empty')}
        </div>
      ) : (
        <div
          className="ks-branch__list"
          role="list"
          aria-label={t('branches.listLabel')}
          data-testid="session-branches-list"
        >
          {nodes.map((node) => {
            const indent = Math.min(node.depth, MAX_INDENT_DEPTH)
            const disabled = blocked !== null || switchingId !== null
            const isSwitching = switchingId === node.id
            const title = previewText(t, node)
            const time = formatBranchTime(node.timestamp, locale)
            const rowTooltip = blockedText ?? (node.isCurrent ? t('branches.currentBadge') : title)

            return (
              <div key={node.id} role="listitem">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void handleSelect(node)}
                  aria-current={node.isCurrent ? 'true' : undefined}
                  aria-disabled={disabled ? 'true' : undefined}
                  data-current={node.isCurrent ? '' : undefined}
                  data-active-path={node.onActivePath ? '' : undefined}
                  data-testid={`session-branch-item-${node.id}`}
                  title={rowTooltip}
                  style={indent > 0 ? { paddingLeft: `${10 + indent * 14}px` } : undefined}
                  className={cn(
                    'ks-branch__row',
                    indent > 0 && 'ks-branch__row--nested',
                    disabled && !node.isCurrent && 'ks-branch__row--disabled',
                  )}
                >
                  <span className="ks-branch__node-slot" aria-hidden>
                    {isSwitching ? (
                      <Spinner className="size-3" />
                    ) : (
                      <span
                        className={cn(
                          'ks-branch__dot',
                          node.isCurrent
                            ? 'ks-branch__dot--current'
                            : node.onActivePath
                              ? 'ks-branch__dot--path'
                              : 'ks-branch__dot--other',
                        )}
                      />
                    )}
                  </span>
                  <span className="ks-branch__main">
                    <span className="ks-branch__row-top">
                      {node.label && <span className="ks-branch__label">{node.label}</span>}
                      <span className="ks-branch__row-title">{title}</span>
                      {node.isCurrent && (
                        <span className="ks-branch__badge ks-branch__badge--current">
                          <Icon icon={Tick02Icon} size={10} />
                          {t('branches.currentBadge')}
                        </span>
                      )}
                    </span>
                    <span className="ks-branch__row-meta tabular">
                      {node.turnCount > 0 && (
                        <span>{t('branches.turns', { count: node.turnCount })}</span>
                      )}
                      {!node.isLeaf && (
                        <>
                          {node.turnCount > 0 && <span aria-hidden>&middot;</span>}
                          <span>{t('branches.forkPoint')}</span>
                        </>
                      )}
                      {time && (
                        <>
                          {(node.turnCount > 0 || !node.isLeaf) && (
                            <span aria-hidden>&middot;</span>
                          )}
                          <span>{time}</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
