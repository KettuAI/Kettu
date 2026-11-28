import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { Popover } from '@base-ui/react/popover'
import {
  ArrowMoveDownRightIcon,
  Cancel01Icon,
  Search01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { DelegateAgentsResult, DelegateTargetAgent } from '@shared/agent-host'
import { isFullAccessMode } from '@shared/agents'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { menuCollisionPadding } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { useOverlayPresence } from '@renderer/stores/overlays'
import {
  filterDelegateAgents,
  firstSelectableIndex,
  isSelectableDelegateAgent,
  moveSelectableHighlight,
  setDraftDelegateTarget,
  useDraftDelegateTarget,
  type DelegateTarget,
} from './delegation'

const VIEWPORT_BOUNDARY: Element[] = []

type DelegateAgentsLoader = (sessionId: string) => Promise<DelegateAgentsResult>

const defaultLoadDelegateAgents: DelegateAgentsLoader = (sessionId) =>
  host('sessions.delegateAgents', { sessionId })

/**
 * Removable recipient chip shown above the composer editor while a target agent is selected for
 * manual delegation. Clicking the recipient reopens the picker to switch targets; clicking ×
 * clears the recipient so normal sending to the current session resumes.
 */
export function DelegateRecipientChip({
  draft,
  hostId,
  visible = true,
  onChange,
  onLeave,
}: {
  draft: string
  hostId: string | null
  visible?: boolean
  onChange: () => void
  onLeave: () => void
}) {
  const { t } = useTranslation('composer')
  const target = useDraftDelegateTarget(draft)
  const liveName = useAgentsStore((s) =>
    target ? agentsOn(s, hostId).byId[target.agentId]?.name : undefined,
  )
  if (!visible || !target) return null
  const displayName = liveName ?? target.name

  return (
    <div
      role="region"
      aria-label={t('delegation.recipientLabel')}
      data-composer-own=""
      data-delegate-recipient=""
      className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 pb-1.5"
    >
      <div className="flex h-6.5 max-w-64 min-w-0 animate-in items-center gap-1 rounded-lg bg-subtle pr-0.5 pl-2 text-small text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] transition-shadow duration-(--duration-fast) fade-in animation-duration-(--duration-fast) hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]">
        <button
          type="button"
          aria-label={t('delegation.changeRecipient', { agent: displayName })}
          data-delegate-change=""
          onClick={onChange}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none transition-colors duration-(--duration-fast) hover:text-primary focus-ring"
        >
          <AgentMark agent={target.agentId} size={14} hostId={hostId} />
          <span className="min-w-0 truncate font-medium">
            {t('delegation.to', { agent: displayName })}
          </span>
        </button>
        <button
          type="button"
          aria-label={t('delegation.removeRecipient', { agent: displayName })}
          data-delegate-remove=""
          onClick={() => {
            setDraftDelegateTarget(draft, null)
            onLeave()
          }}
          className="flex size-5.5 shrink-0 items-center justify-center rounded-md text-tertiary outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-secondary focus-ring"
        >
          <HugeiconsIcon aria-hidden icon={Cancel01Icon} strokeWidth={1.9} className="size-3.5" />
        </button>
      </div>
      <span className="min-w-0 truncate text-caption text-tertiary">
        {t('delegation.chipHint')}
      </span>
    </div>
  )
}

/**
 * Searchable popover opened from the composer's `+` menu to pick a target agent for manual
 * delegation. Fetches the host's authoritative list of delegatable agents (including #2727
 * inherited permission modes), supports live search filtering and keyboard navigation, and writes
 * the chosen recipient into the session's draft.
 */
export function DelegateAgentPickerPopover({
  open,
  onOpenChange,
  anchor,
  draft,
  sessionId,
  hostId,
  onSelect,
  onPicked,
  loadAgents = defaultLoadDelegateAgents,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: RefObject<HTMLDivElement | null>
  draft: string
  sessionId: string | null
  hostId: string | null
  onSelect?: (target: DelegateTarget) => void
  onPicked: () => void
  loadAgents?: DelegateAgentsLoader
}) {
  const { t } = useTranslation('composer')
  const currentTarget = useDraftDelegateTarget(draft)
  const [query, setQuery] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  const [fetchState, setFetchState] = useState<{
    loading: boolean
    error: string | null
    agents: DelegateTargetAgent[]
  }>({ loading: open && sessionId !== null, error: null, agents: [] })
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setQuery('')
      setFetchState((prev) => ({ ...prev, loading: sessionId !== null, error: null }))
    }
  }
  const [highlight, setHighlight] = useState({ key: '', index: -1 })
  const searchInput = useRef<HTMLInputElement>(null)
  const listId = useId()

  useOverlayPresence(open, { dismissible: true })

  useEffect(() => {
    if (!open || !sessionId) return
    let cancelled = false
    loadAgents(sessionId)
      .then((result) => {
        if (cancelled) return
        setFetchState({
          loading: false,
          error: null,
          agents: result.canDelegate ? result.agents : [],
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFetchState({
          loading: false,
          error: errorMessage(error) || t('delegation.loadFailed'),
          agents: [],
        })
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId, loadAgents, t])

  const { loading, error: loadError, agents } = fetchState

  // Focus the search field once the popover opens after the '+' menu closes.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => searchInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const rows = useMemo(() => filterDelegateAgents(agents, query), [agents, query])
  const listKey = `${query}\0${rows.map((row) => `${row.id}:${row.status}`).join(',')}`
  if (highlight.key !== listKey) {
    setHighlight({ key: listKey, index: firstSelectableIndex(rows) })
  }
  const active =
    highlight.index >= 0 &&
    highlight.index < rows.length &&
    isSelectableDelegateAgent(rows[highlight.index]!)
      ? highlight.index
      : firstSelectableIndex(rows)
  const optionId = (index: number) => `${listId}-${index}`

  useLayoutEffect(() => {
    if (open && active >= 0) {
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, active, listId])

  const choose = (agent: DelegateTargetAgent) => {
    if (!isSelectableDelegateAgent(agent)) return
    const target: DelegateTarget = {
      agentId: agent.id,
      name: agent.name,
      ...(hostId ? { hostId } : {}),
    }
    setDraftDelegateTarget(draft, target)
    onSelect?.(target)
    onOpenChange(false)
    onPicked()
  }

  const close = () => {
    onOpenChange(false)
    onPicked()
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (rows.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setHighlight({
        key: listKey,
        index: moveSelectableHighlight(rows, active, event.key),
      })
      return
    }
    if (event.key === 'Enter' && active >= 0 && rows[active]) {
      event.preventDefault()
      choose(rows[active]!)
    }
  }

  const statusText = (agent: DelegateTargetAgent): { label: string; tone: string } | null => {
    if (agent.status === 'needs_sign_in') {
      return { label: t('delegation.statusSignIn'), tone: 'text-warning' }
    }
    if (agent.status === 'installing') {
      return { label: t('delegation.statusInstalling'), tone: 'text-tertiary' }
    }
    if (agent.status === 'failed') {
      return { label: t('delegation.statusFailed'), tone: 'text-danger' }
    }
    if (agent.inheritedMode) {
      return {
        label: agent.inheritedMode.name,
        tone: isFullAccessMode(agent.inheritedMode.id) ? 'text-danger' : 'text-tertiary',
      }
    }
    return null
  }

  const emptyMessage = loadError
    ? loadError
    : query.trim()
      ? t('delegation.noMatch')
      : t('delegation.empty')

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) onPicked()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={10}
          collisionBoundary={VIEWPORT_BOUNDARY}
          collisionPadding={menuCollisionPadding}
          className="isolate z-(--layer-menu) outline-none app-region-no-drag"
        >
          <Popover.Popup
            data-overlay-layer=""
            data-delegate-picker=""
            initialFocus={searchInput}
            finalFocus={false}
            className="flex max-h-[min(var(--available-height),340px)] w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) flex-col overflow-hidden rounded-2xl bg-popover p-1.5 text-popover-foreground shadow-menu outline-none animation-duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-1.5">
              <span className="flex min-w-0 items-center gap-1.5 text-small font-medium text-secondary">
                <HugeiconsIcon
                  aria-hidden
                  icon={ArrowMoveDownRightIcon}
                  strokeWidth={1.9}
                  className="size-3.5 shrink-0 text-tertiary"
                />
                <span className="truncate">{t('delegation.pickerTitle')}</span>
              </span>
              <span className="truncate text-caption text-tertiary">
                {t('delegation.pickerHint')}
              </span>
            </div>

            <div className="relative mb-1.5 flex items-center px-1">
              <HugeiconsIcon
                aria-hidden
                icon={Search01Icon}
                strokeWidth={1.9}
                className="pointer-events-none absolute left-3 size-3.5 text-tertiary"
              />
              <input
                ref={searchInput}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={t('delegation.searchPlaceholder')}
                aria-label={t('delegation.searchPlaceholder')}
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                className="h-7.5 w-full rounded-lg bg-subtle pr-7 pl-7.5 text-menu text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] outline-none placeholder:text-tertiary focus:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]"
              />
              {query && (
                <button
                  type="button"
                  aria-label={t('delegation.clearSearch')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 flex size-5 items-center justify-center rounded-sm text-tertiary hover:text-primary"
                >
                  <HugeiconsIcon
                    aria-hidden
                    icon={Cancel01Icon}
                    strokeWidth={1.9}
                    className="size-3"
                  />
                </button>
              )}
            </div>

            {loading ? (
              <div className="flex items-center gap-2 px-2.5 py-4 text-small text-tertiary">
                <Spinner className="size-3.5" />
                <span>{t('delegation.loading')}</span>
              </div>
            ) : rows.length === 0 ? (
              <div
                className={cn(
                  'px-2.5 py-5 text-center text-small',
                  loadError ? 'text-danger' : 'text-tertiary',
                )}
              >
                {emptyMessage}
              </div>
            ) : (
              <div
                role="listbox"
                id={listId}
                aria-label={t('delegation.pickerTitle')}
                className="min-h-0 flex-1 scroll-fade-y overflow-y-auto overscroll-contain"
              >
                {rows.map((agent, index) => {
                  const selectable = isSelectableDelegateAgent(agent)
                  const highlighted = index === active && selectable
                  const selected = currentTarget?.agentId === agent.id
                  const trailing = statusText(agent)
                  const subtitle = agent.harnessName !== agent.name ? agent.harnessName : null
                  return (
                    <div
                      key={agent.id}
                      role="option"
                      id={optionId(index)}
                      aria-selected={highlighted}
                      aria-disabled={!selectable || undefined}
                      data-highlighted={highlighted ? '' : undefined}
                      data-disabled={!selectable ? '' : undefined}
                      data-delegate-option={agent.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => {
                        if (selectable && index !== active) setHighlight({ key: listKey, index })
                      }}
                      onClick={() => choose(agent)}
                      className={cn(
                        'flex min-h-8.5 cursor-default items-center gap-2 rounded-lg px-2 py-1.25 text-menu outline-none select-none data-highlighted:bg-selected',
                        !selectable && 'opacity-50',
                      )}
                    >
                      <AgentMark agent={agent.id} size={16} hostId={hostId} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium text-primary">{agent.name}</span>
                          {agent.isCurrent && (
                            <span className="shrink-0 rounded bg-subtle px-1 py-0.5 text-caption leading-none text-tertiary">
                              {t('delegation.current')}
                            </span>
                          )}
                        </span>
                        {subtitle && (
                          <span className="truncate text-caption text-tertiary">{subtitle}</span>
                        )}
                      </span>
                      {trailing && (
                        <span className={cn('shrink-0 text-caption', trailing.tone)}>
                          {trailing.label}
                        </span>
                      )}
                      {selected && (
                        <HugeiconsIcon
                          aria-hidden
                          icon={Tick02Icon}
                          strokeWidth={2}
                          className="size-3.5 shrink-0 text-primary"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
