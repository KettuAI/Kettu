// Right-hand 4-tab panel on the Bot workbench:
// Work (managed computers + active/offline/completed ledger with detach & archive),
// Role (rendered ROLE.md viewer + toggleable source editor), Memory (Bot layer 3 memory),
// and Channels & Settings (dynamic plugin-provided Bot channels, bound Routines, limits & delete).

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Add01Icon,
  Archive01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  Cancel01Icon,
  ComputerIcon,
  Delete02Icon,
  LaptopIcon,
  PencilEdit02Icon,
  PlayIcon,
  PlugSocketIcon,
  RefreshIcon,
  Search01Icon,
  Settings02Icon,
  Tick02Icon,
  WifiDisconnected01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  BOT_TERMINAL_STATUSES,
  formatChannelHowToAsk,
  type BotChannelConnectionState,
  type BotChannelView,
  type BotHostTarget,
  type BotRequest,
  type BotView,
} from '@shared/bots'
import type { BotChannelReplyMode } from '@shared/plugin-bot-channels'
import type { MemoryEntry } from '@shared/memory'
import { pluginText } from '@shared/plugins'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { toast } from '@renderer/components/ui/toast'
import { openPlugin } from '@renderer/features/marketplace/plugin-hooks'
import { Markdown } from '@renderer/features/session/markdown'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { Glyph } from '@renderer/features/shell/glyph'
import { SourceKindBadge } from '@renderer/features/sidebar/bot-group'
import { errorMessage, host } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { isBotBoundToChannel, requestsOfBot, useBotsStore } from '@renderer/stores/bots'
import { useRoutinesStore } from '@renderer/stores/routines'
import {
  openBotEditor,
  openMarketplace,
  openNewSession,
  openRoutine,
  openSession,
} from '@renderer/stores/view'

export type BotPanelTab = 'work' | 'role' | 'memory' | 'settings'

export function BotWorkPanel({
  bot,
  targets,
  tab: controlledTab,
  onTabChange,
}: {
  bot: BotView
  targets: BotHostTarget[]
  tab?: BotPanelTab
  onTabChange?: (next: BotPanelTab) => void
}) {
  const { t } = useTranslation('bots')
  const [internalTab, setInternalTab] = useState<BotPanelTab>('work')
  const tab = controlledTab ?? internalTab
  const setTab = onTabChange ?? setInternalTab

  return (
    <aside className="flex h-full w-[356px] shrink-0 flex-col border-l border-(--border-subtle) bg-(--bg-sidebar)/50">
      <div className="flex items-center gap-1 border-b border-(--border-subtle) px-2.5 py-2">
        {(
          [
            ['work', t('tabs.work')],
            ['role', t('tabs.role')],
            ['memory', `${t('tabs.memory')}${bot.memoryCount > 0 ? ` (${bot.memoryCount})` : ''}`],
            ['settings', t('tabs.channelsSettings')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              'rounded-md px-2 py-1 text-caption font-medium transition-colors',
              tab === id
                ? 'bg-(--bg-raised) text-primary shadow-xs'
                : 'text-tertiary hover:text-primary',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'work' && <WorkTab bot={bot} targets={targets} />}
        {tab === 'role' && <RoleTab key={bot.id} bot={bot} />}
        {tab === 'memory' && <MemoryTab key={bot.id} bot={bot} />}
        {tab === 'settings' && <ChannelsSettingsTab key={bot.id} bot={bot} />}
      </div>
    </aside>
  )
}

function WorkTab({ bot, targets }: { bot: BotView; targets: BotHostTarget[] }) {
  const { t } = useTranslation('bots')
  const requestsById = useBotsStore((s) => s.requestsById)
  const retryPending = useBotsStore((s) => s.retryPending)
  const cancelRequest = useBotsStore((s) => s.cancelRequest)
  const archiveDone = useBotsStore((s) => s.archiveDone)
  const detachSession = useBotsStore((s) => s.detachSession)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)

  const all = useMemo(() => requestsOfBot(requestsById, bot.id), [requestsById, bot.id])
  const active = all.filter(
    (r) =>
      r.archivedAt === null &&
      (r.status === 'received' ||
        r.status === 'queued' ||
        r.status === 'running' ||
        r.status === 'waiting_user'),
  )
  const pendingHost = all.filter((r) => r.archivedAt === null && r.status === 'waiting_host')
  const completed = all.filter((r) => r.archivedAt === null && BOT_TERMINAL_STATUSES.has(r.status))

  const handleRetry = async (id: string) => {
    setBusyId(id)
    try {
      await retryPending(id)
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusyId(null)
    }
  }

  const handleCancel = async (id: string) => {
    setBusyId(id)
    try {
      await cancelRequest(id)
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusyId(null)
    }
  }

  const handleDetach = async (req: BotRequest) => {
    if (!req.sessionId) return
    setBusyId(req.id)
    try {
      const ok = await detachSession(req.sessionId)
      if (ok) toast(t('work.detachedToast'), undefined, { tone: 'success' })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusyId(null)
    }
  }

  const handleArchiveAll = async () => {
    setArchiving(true)
    try {
      const count = await archiveDone(bot.id)
      toast(t('work.archivedCount', { count }), undefined, { tone: 'success' })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1.5">
        <h3 className="text-caption font-medium text-tertiary">{t('work.computers')}</h3>
        <div className="flex flex-col gap-1.5">
          {targets.map((target) => (
            <div
              key={target.hostId ?? 'local'}
              className="flex items-center gap-2 rounded-lg border border-(--border-subtle) bg-(--bg-surface) px-2.5 py-2 text-caption"
            >
              {target.self ? (
                <Glyph
                  icon={target.platform === 'darwin' ? LaptopIcon : ComputerIcon}
                  size={14}
                  className="shrink-0 text-secondary"
                />
              ) : (
                <HostIcon platform={target.platform} className="size-3.5 shrink-0 text-secondary" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-primary">{target.name}</span>
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      target.online ? 'bg-(--success)' : 'bg-(--border-strong)',
                    )}
                  />
                </div>
                <span className="text-[11px] text-tertiary">
                  {target.online
                    ? t('work.workingCount', { count: target.load?.workingSessions ?? 0 })
                    : t('work.offline')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {pendingHost.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-1.5 text-caption font-medium text-(--warning)">
            <Glyph icon={WifiDisconnected01Icon} size={12} />
            {t('work.pendingOffline')} ({pendingHost.length})
          </h3>
          <div className="flex flex-col gap-2">
            {pendingHost.map((req) => (
              <WorkRow
                key={req.id}
                request={req}
                busy={busyId === req.id}
                onRetry={() => void handleRetry(req.id)}
                onCancel={() => void handleCancel(req.id)}
              />
            ))}
          </div>
        </section>
      )}

      {active.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-caption font-medium text-tertiary">
            {t('work.active')} ({active.length})
          </h3>
          <div className="flex flex-col gap-2">
            {active.map((req) => (
              <WorkRow
                key={req.id}
                request={req}
                busy={busyId === req.id}
                onCancel={() => void handleCancel(req.id)}
                onDetach={
                  req.sessionId && req.targetHostId === null
                    ? () => void handleDetach(req)
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      {completed.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-caption font-medium text-tertiary">
              {t('work.completed')} ({completed.length})
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={archiving}
              onClick={() => void handleArchiveAll()}
            >
              <Glyph icon={Archive01Icon} size={12} />
              {t('work.archiveDone')}
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {completed.map((req) => (
              <WorkRow
                key={req.id}
                request={req}
                busy={busyId === req.id}
                onRetry={req.status === 'failed' ? () => void handleRetry(req.id) : undefined}
                onDetach={
                  req.sessionId && req.targetHostId === null
                    ? () => void handleDetach(req)
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      {active.length === 0 && pendingHost.length === 0 && completed.length === 0 && (
        <p className="rounded-xl border border-dashed border-(--border-default) p-4 text-center text-caption leading-relaxed text-tertiary">
          {t('work.empty')}
        </p>
      )}
    </div>
  )
}

function WorkRow({
  request,
  busy,
  onRetry,
  onCancel,
  onDetach,
}: {
  request: BotRequest
  busy: boolean
  onRetry?: () => void
  onCancel?: () => void
  onDetach?: () => void
}) {
  const { t } = useTranslation('bots')
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-(--border-subtle) bg-(--bg-surface) p-2.5 text-caption">
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <SourceKindBadge kind={request.source.kind} label={request.source.channelShortLabel} />
          <span className="truncate font-medium text-primary">{request.title}</span>
        </div>
        <span className="shrink-0 rounded-full bg-(--bg-subtle) px-1.5 py-0.5 text-[10.5px] text-secondary">
          {t(`requestStatus.${request.status}`)}
        </span>
      </div>
      <div className="flex items-center gap-1 text-[11px] text-tertiary">
        {request.targetHostId === null ? (
          <Glyph icon={request.targetPlatform === 'darwin' ? LaptopIcon : ComputerIcon} size={11} />
        ) : (
          <HostIcon platform={request.targetPlatform} className="size-2.5" />
        )}
        <span className="truncate">
          {request.targetHostName} / {request.projectName}
        </span>
      </div>
      {request.source.repliedAt && (
        <span className="inline-flex items-center gap-1 text-[10.5px] text-(--success)">
          <Glyph icon={Tick02Icon} size={10} />
          {t('work.repliedExternal')}
        </span>
      )}
      {request.error && <p className="text-[11px] text-danger">{request.error}</p>}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {request.sessionId && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() =>
              openSession(request.sessionId!, onHost(request.targetHostId, request.projectPath))
            }
          >
            {t('work.openSession')}
            <Glyph icon={ArrowRight01Icon} size={11} />
          </Button>
        )}
        {onDetach && (
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onDetach}>
            {t('work.detachSession')}
          </Button>
        )}
        {onRetry && (
          <Button type="button" variant="default" size="xs" disabled={busy} onClick={onRetry}>
            <Glyph icon={PlayIcon} size={11} />
            {t('work.dispatchNow')}
          </Button>
        )}
        {onCancel && (
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onCancel}>
            <Glyph icon={Cancel01Icon} size={11} />
            {t('work.cancel')}
          </Button>
        )}
      </div>
    </div>
  )
}

function RoleTab({ bot }: { bot: BotView }) {
  const { t } = useTranslation('bots')
  const update = useBotsStore((s) => s.update)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const value = draft ?? bot.roleMarkdown
  const dirty = value !== bot.roleMarkdown
  const hasContent = bot.roleMarkdown.trim().length > 0

  const startEdit = () => {
    setDraft(bot.roleMarkdown)
    setEditing(true)
  }

  const cancelEdit = () => {
    setDraft(null)
    setEditing(false)
  }

  const save = async () => {
    setSaving(true)
    try {
      await update(bot.id, { roleMarkdown: value })
      setDraft(null)
      setEditing(false)
      toast(t('role.saved'), undefined, { tone: 'success' })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-small font-medium text-primary">{t('role.title')}</h3>
          <p className="mt-0.5 text-caption text-tertiary">{t('role.hint')}</p>
        </div>
        {!editing && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={startEdit}
          >
            <Glyph icon={PencilEdit02Icon} size={12} />
            {t('role.edit')}
          </Button>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('role.placeholder')}
            rows={14}
            autoFocus
            className="min-h-[260px] flex-1 resize-y rounded-lg border border-(--border-default) bg-(--bg-surface) p-2.5 font-mono text-caption leading-relaxed text-primary focus:border-(--focus) focus:outline-none"
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={cancelEdit}>
              {t('work.cancel')}
            </Button>
            <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              {t('saveChanges')}
            </Button>
          </div>
        </>
      ) : hasContent ? (
        <div
          data-selectable=""
          className="min-h-[200px] flex-1 overflow-y-auto rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-3.5"
        >
          <Markdown
            markdown={bot.roleMarkdown}
            className="text-[13px] leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13.5px]"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          className="rounded-xl border border-dashed border-(--border-default) p-5 text-center text-caption text-tertiary transition-colors hover:border-(--border-strong) hover:text-secondary"
        >
          {t('role.empty')}
        </button>
      )}
    </div>
  )
}

function MemoryTab({ bot }: { bot: BotView }) {
  const { t } = useTranslation('bots')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  const loadEntries = useCallback(async () => {
    try {
      const list = await host('memory.list', { scope: { layer: 'bot', botId: bot.id } })
      setEntries(list)
    } catch {
      setEntries([])
    }
  }, [bot.id])

  useEffect(() => {
    let cancelled = false
    host('memory.list', { scope: { layer: 'bot', botId: bot.id } })
      .then((list) => {
        if (!cancelled) setEntries(list)
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [bot.id])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q),
    )
  }, [entries, query])

  const addEntry = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await host('memory.save', {
        scope: { layer: 'bot', botId: bot.id },
        id: null,
        draft: { title: title.trim(), description: description.trim(), body: body.trim() },
      })
      setTitle('')
      setDescription('')
      setBody('')
      setAdding(false)
      await loadEntries()
      await useBotsStore.getState().load()
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setSaving(false)
    }
  }

  const removeEntry = async (id: string) => {
    try {
      await host('memory.remove', { scope: { layer: 'bot', botId: bot.id }, id })
      await loadEntries()
      await useBotsStore.getState().load()
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-small font-medium text-primary">{t('memory.title')}</h3>
          <p className="mt-0.5 text-caption text-tertiary">{t('memory.subtitle')}</p>
        </div>
        <Button type="button" variant="outline" size="xs" onClick={() => setAdding((v) => !v)}>
          <Glyph icon={Add01Icon} size={12} />
          {t('memory.add')}
        </Button>
      </div>

      {adding && (
        <div className="flex flex-col gap-2 rounded-lg border border-(--border-default) bg-(--bg-surface) p-2.5">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('memory.fieldTitle')}
            className="h-8 rounded-md border border-(--border-default) bg-(--bg-app) px-2 text-caption focus:border-(--focus) focus:outline-none"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('memory.fieldDescription')}
            className="h-8 rounded-md border border-(--border-default) bg-(--bg-app) px-2 text-caption focus:border-(--focus) focus:outline-none"
          />
          <textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('memory.fieldBody')}
            className="resize-y rounded-md border border-(--border-default) bg-(--bg-app) p-2 text-caption focus:border-(--focus) focus:outline-none"
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={() => setAdding(false)}>
              {t('work.cancel')}
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={!title.trim() || saving}
              onClick={() => void addEntry()}
            >
              {t('memory.save')}
            </Button>
          </div>
        </div>
      )}

      <div className="relative">
        <Glyph
          icon={Search01Icon}
          size={13}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-tertiary"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('memory.search')}
          className="h-8 w-full rounded-lg border border-(--border-subtle) bg-(--bg-surface) pr-2.5 pl-8 text-caption focus:border-(--focus) focus:outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-(--border-default) p-4 text-center text-caption text-tertiary">
          {t('memory.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-1 rounded-lg border border-(--border-subtle) bg-(--bg-surface) p-2.5 text-caption"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-primary">{entry.title}</span>
                <button
                  type="button"
                  aria-label={t('memory.delete')}
                  onClick={() => void removeEntry(entry.id)}
                  className="text-tertiary hover:text-danger"
                >
                  <Glyph icon={Delete02Icon} size={13} />
                </button>
              </div>
              {entry.description && <p className="text-secondary">{entry.description}</p>}
              {entry.body && (
                <div data-selectable="" className="pt-0.5 text-secondary">
                  <Markdown
                    markdown={entry.body}
                    className="text-[12px] leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_h1]:text-[13.5px] [&_h2]:text-[13px] [&_h3]:text-[12.5px]"
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ChannelStatusDot({
  state,
  needsSetup,
}: {
  state: BotChannelConnectionState
  needsSetup: boolean
}) {
  const { t } = useTranslation('bots')
  const effective = needsSetup ? 'off' : state
  const label = needsSetup ? t('channels.state.needsSetup') : t(`channels.state.${state}`)
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-tertiary">
      <span
        className={cn(
          'size-1.5 rounded-full',
          effective === 'connected'
            ? 'bg-(--success)'
            : effective === 'connecting' || effective === 'reconnecting'
              ? 'animate-pulse bg-(--warning)'
              : effective === 'error'
                ? 'bg-(--danger)'
                : 'bg-(--border-strong)',
        )}
      />
      <span>{label}</span>
    </span>
  )
}

function PluginChannelCard({
  bot,
  channel,
  onCopy,
}: {
  bot: BotView
  channel: BotChannelView
  onCopy: (text: string, label: string) => void
}) {
  const { t, i18n } = useTranslation('bots')
  const configureChannel = useBotsStore((s) => s.configureChannel)
  const bindChannel = useBotsStore((s) => s.bindChannel)
  const testChannel = useBotsStore((s) => s.testChannel)
  const startPairing = useBotsStore((s) => s.startPairing)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const savedScopeText = (bot.channels?.[channel.channelKey]?.scope ?? []).join(', ')
  const [draftScope, setDraftScope] = useState<string | null>(null)
  const scopeInput = draftScope ?? savedScopeText

  const title = pluginText(channel.title, channel.pluginTitle, i18n.language)
  const description = channel.description ? pluginText(channel.description, '', i18n.language) : ''
  const needsSetup = channel.missingRequiredSettings.length > 0
  const bound = isBotBoundToChannel(bot, channel)
  const isDefault = channel.config.defaultBotId === bot.id
  const replyModes = channel.capabilities.replyModes ?? []
  const currentReplyMode: BotChannelReplyMode =
    bot.channels?.[channel.channelKey]?.replyMode ?? replyModes[0] ?? 'summary'
  const howToAsk = formatChannelHowToAsk(channel.howToAsk, bot.handle)

  const toggleBotBinding = async (checked: boolean) => {
    setBusy(true)
    try {
      await bindChannel(bot.id, channel.channelKey, { enabled: checked })
      // Auto-enable the shared channel connection the first time a user binds a Bot (when setup is complete).
      if (checked && !channel.config.enabled && !needsSetup) {
        await configureChannel(channel.channelKey, {
          enabled: true,
          ...(channel.config.defaultBotId ? {} : { defaultBotId: bot.id }),
        })
      }
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  const updateShared = async (patch: Parameters<typeof configureChannel>[1]) => {
    setBusy(true)
    try {
      await configureChannel(channel.channelKey, patch)
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  const updateReplyMode = async (replyMode: BotChannelReplyMode) => {
    setBusy(true)
    try {
      await bindChannel(bot.id, channel.channelKey, {
        enabled: bound,
        replyMode,
        ...(channel.capabilities.scopes
          ? { scope: bot.channels?.[channel.channelKey]?.scope ?? [] }
          : {}),
      })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  const saveScopes = async () => {
    const scope = [
      ...new Set(
        scopeInput
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ]
    setBusy(true)
    try {
      await bindChannel(bot.id, channel.channelKey, {
        enabled: bound,
        replyMode: currentReplyMode,
        scope,
      })
      setDraftScope(null)
      toast(t('channels.saved'), undefined, { tone: 'success' })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    setBusy(true)
    try {
      const res = await testChannel(channel.channelKey)
      if (res.ok) {
        toast(t('channels.testOk', { label: res.label ?? title }), undefined, { tone: 'success' })
      } else {
        toast(res.error ?? t('channels.testFailed'), undefined, { tone: 'warning' })
      }
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  const runPair = async () => {
    setBusy(true)
    try {
      await startPairing(channel.channelKey)
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {channel.pluginIcon ? (
            <img
              src={channel.pluginIcon}
              alt=""
              className="size-5 shrink-0 rounded-md object-cover"
            />
          ) : (
            <span className="grid size-5 shrink-0 place-items-center rounded-md bg-(--bg-subtle) text-secondary">
              <Glyph icon={PlugSocketIcon} size={12} />
            </span>
          )}
          <span className="min-w-0 truncate font-medium text-primary">{title}</span>
          {isDefault && (
            <span className="shrink-0 rounded-full bg-(--bg-subtle) px-1.5 py-0.5 text-[10px] text-secondary">
              {t('channels.defaultBadge')}
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <ChannelStatusDot state={channel.state} needsSetup={needsSetup} />
          <Switch
            size="sm"
            checked={bound}
            disabled={busy}
            aria-label={title}
            onCheckedChange={(checked) => void toggleBotBinding(checked)}
          />
        </div>
      </div>

      {description && <p className="text-[11px] text-tertiary">{description}</p>}

      {needsSetup && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-(--bg-subtle) px-2.5 py-1.5">
          <span className="text-[11px] text-secondary">{t('channels.pluginNeedsSetup')}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => openPlugin(channel.pluginId, 'plugins')}
          >
            {t('channels.configurePlugin')}
          </Button>
        </div>
      )}

      {(bound || expanded) && (
        <div className="flex flex-col gap-2 border-t border-(--border-subtle) pt-2">
          <div className="flex flex-col gap-1 rounded-lg bg-(--bg-subtle) px-2.5 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-medium text-tertiary">
                {t('channels.howToAskGeneric')}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onCopy(howToAsk, title)}
              >
                {t('channels.copy')}
              </Button>
            </div>
            <code className="truncate font-mono text-[11px] text-primary">{howToAsk}</code>
          </div>

          {replyModes.length > 1 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-secondary">{t('channels.replyPolicy')}</span>
              <select
                value={currentReplyMode}
                disabled={busy}
                onChange={(e) => void updateReplyMode(e.target.value as BotChannelReplyMode)}
                className="h-7 rounded-md border border-(--border-default) bg-(--bg-app) px-1.5 text-[11px] text-primary"
              >
                {replyModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`channels.replyMode.${mode}`)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <label className="flex cursor-pointer items-center justify-between gap-2 text-[11px] text-secondary">
            <span>{t('channels.channelEnabled')}</span>
            <Switch
              size="sm"
              checked={channel.config.enabled}
              disabled={busy || needsSetup}
              onCheckedChange={(checked) => void updateShared({ enabled: checked })}
            />
          </label>

          <label className="flex cursor-pointer items-center justify-between gap-2 text-[11px] text-secondary">
            <span>{t('channels.defaultBotForChannel')}</span>
            <Switch
              size="sm"
              checked={isDefault}
              disabled={busy}
              onCheckedChange={(checked) =>
                void updateShared({ defaultBotId: checked ? bot.id : null })
              }
            />
          </label>

          {channel.capabilities.scopes && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-secondary">{t('channels.scopesLabel')}</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={scopeInput}
                  disabled={busy}
                  onChange={(e) => setDraftScope(e.target.value)}
                  placeholder={t('channels.scopesPlaceholder')}
                  className="h-7 min-w-0 flex-1 rounded-md border border-(--border-default) bg-(--bg-app) px-2 font-mono text-[11px] text-primary focus:border-(--focus) focus:outline-none"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy || scopeInput.trim() === savedScopeText.trim()}
                  onClick={() => void saveScopes()}
                >
                  {t('channels.save')}
                </Button>
              </div>
            </div>
          )}

          {channel.capabilities.group && channel.capabilities.direct !== false && (
            <label className="flex cursor-pointer items-center justify-between gap-2 text-[11px] text-secondary">
              <span>{t('channels.allowGroupMention')}</span>
              <Switch
                size="sm"
                checked={channel.config.allowGroupMention}
                disabled={busy}
                onCheckedChange={(checked) => void updateShared({ allowGroupMention: checked })}
              />
            </label>
          )}

          {channel.capabilities.pairing !== false && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-secondary">
                  {channel.config.ownerIds.length > 0
                    ? t('channels.ownersPaired', { count: channel.config.ownerIds.length })
                    : t('channels.ownerNotPaired')}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => void runPair()}
                >
                  {t('channels.generatePair')}
                </Button>
              </div>
              {channel.pairingCode && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-(--bg-subtle) px-2.5 py-1.5">
                  <code className="font-mono text-[11.5px] font-semibold text-primary">
                    /pair {channel.pairingCode.code}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onCopy(`/pair ${channel.pairingCode!.code}`, '/pair')}
                  >
                    {t('channels.copy')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {channel.detail && channel.state === 'error' && (
            <p className="text-[11px] text-danger">{channel.detail}</p>
          )}

          <div className="flex items-center justify-end gap-1.5 pt-0.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || needsSetup}
              onClick={() => void runTest()}
            >
              {t('channels.test')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => openPlugin(channel.pluginId, 'plugins')}
            >
              <Glyph icon={Settings02Icon} size={11} />
              {t('channels.pluginSettings')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

function ChannelsSettingsTab({ bot }: { bot: BotView }) {
  const { t } = useTranslation('bots')
  const setPaused = useBotsStore((s) => s.setPaused)
  const resetMain = useBotsStore((s) => s.resetMain)
  const remove = useBotsStore((s) => s.remove)
  const requestsById = useBotsStore((s) => s.requestsById)
  const channels = useBotsStore((s) => s.channels)
  const refreshChannels = useBotsStore((s) => s.refreshChannels)
  const routinesById = useRoutinesStore((s) => s.byId)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [keepSessions, setKeepSessions] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshChannels()
  }, [bot.id, refreshChannels])

  const boundRoutines = useMemo(
    () => Object.values(routinesById).filter((r) => r.botId === bot.id),
    [routinesById, bot.id],
  )

  const sessionCount = useMemo(
    () => Object.values(requestsById).filter((r) => r.botId === bot.id && r.sessionId).length,
    [requestsById, bot.id],
  )

  const copyText = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      toast(t('channels.copied', { label }), undefined, { tone: 'success' })
    })
  }

  const handleDelete = async () => {
    setBusy(true)
    try {
      await remove(bot.id, keepSessions)
      openNewSession(null, null)
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 text-caption">
      {/* External Channels Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-small font-medium text-primary">{t('channels.title')}</h3>
          <p className="text-[11px] text-tertiary">{t('channels.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={() => openMarketplace({ tab: 'plugins' })}
        >
          <Glyph icon={PlugSocketIcon} size={11} />
          {t('channels.managePlugins')}
        </Button>
      </div>

      {/* Installed Bot Channel Plugins */}
      {channels.length === 0 ? (
        <section className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-(--border-default) bg-(--bg-surface)/60 px-3.5 py-4 text-center">
          <span className="grid size-8 place-items-center rounded-lg bg-(--bg-subtle) text-secondary">
            <Glyph icon={PlugSocketIcon} size={16} />
          </span>
          <div className="space-y-0.5">
            <p className="font-medium text-primary">{t('channels.emptyTitle')}</p>
            <p className="text-[11px] leading-relaxed text-tertiary">{t('channels.emptyBody')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => openMarketplace({ tab: 'plugins' })}
          >
            <Glyph icon={Add01Icon} size={11} />
            {t('channels.installChannelPlugin')}
          </Button>
        </section>
      ) : (
        <div className="flex flex-col gap-2">
          {channels.map((channel) => (
            <PluginChannelCard
              key={channel.channelKey}
              bot={bot}
              channel={channel}
              onCopy={copyText}
            />
          ))}
        </div>
      )}

      {/* Bound Routines */}
      <section className="flex flex-col gap-2 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-primary">
            <Glyph icon={Calendar03Icon} size={13} className="text-secondary" />
            {t('channels.routinesTitle')}
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={() => openRoutine(null)}>
            <Glyph icon={Add01Icon} size={11} />
            {t('channels.newRoutine')}
          </Button>
        </div>
        {boundRoutines.length === 0 ? (
          <p className="text-[11px] text-tertiary">{t('channels.routinesEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {boundRoutines.map((routine) => (
              <li
                key={routine.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-(--bg-subtle)/70 px-2 py-1.5"
              >
                <button
                  type="button"
                  onClick={() => openRoutine(routine.id)}
                  className="min-w-0 flex-1 truncate text-left text-[11.5px] font-medium text-primary hover:underline"
                >
                  {routine.name}
                </button>
                <span className="shrink-0 text-[10.5px] text-tertiary">
                  {routine.enabled ? t('work.online') : t('paused')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Bot Guardrails & Identity Summary */}
      <div className="flex flex-col gap-2 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-3">
        <div className="flex justify-between gap-2">
          <span className="text-tertiary">{t('changeCard.fieldHandle')}</span>
          <span className="font-mono font-medium text-primary">@{bot.handle}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-tertiary">{t('changeCard.fieldAgent')}</span>
          <span className="font-medium text-primary">
            {agentName(bot.agentId, null)}
            {bot.model ? ` · ${bot.model}` : ''}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-tertiary">{t('changeCard.fieldScope')}</span>
          <span className="text-primary">{t(`editor.scope.${bot.scope.level}`)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-tertiary">{t('changeCard.fieldLimits')}</span>
          <span className="tabular-nums text-primary">
            {bot.limits.maxConcurrent} / {bot.limits.maxDaily} / {bot.limits.timeLimitMinutes}m
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <Button type="button" variant="outline" size="xs" onClick={() => openBotEditor(bot.id)}>
          <Glyph icon={PencilEdit02Icon} size={12} />
          {t('editBot')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void setPaused(bot.id, !bot.paused)}
        >
          {bot.paused ? t('resume') : t('pause')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="col-span-2"
          onClick={() => void resetMain(bot.id)}
        >
          <Glyph icon={RefreshIcon} size={12} />
          {t('resetMain')}
        </Button>
      </div>

      <div className="rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-2.5">
        {!confirmDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-full text-danger hover:bg-(--danger-tint) hover:text-danger"
            onClick={() => setConfirmDelete(true)}
          >
            <Glyph icon={Delete02Icon} size={13} />
            {t('deleteBot')}
          </Button>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="font-medium text-primary">
              {t('deleteConfirmTitle', { name: bot.name })}
            </p>
            <p className="text-secondary">{t('deleteConfirmBody')}</p>
            <label className="flex cursor-pointer items-start gap-2 text-primary">
              <input
                type="checkbox"
                checked={keepSessions}
                onChange={(e) => setKeepSessions(e.target.checked)}
                className="mt-0.5 size-3.5 accent-(--control-on)"
              />
              <span>
                <span className="block font-medium">
                  {t('keepSessionsLabel', { count: sessionCount })}
                </span>
                <span className="block text-[11px] text-tertiary">{t('keepSessionsHint')}</span>
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setConfirmDelete(false)}
              >
                {t('work.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="xs"
                disabled={busy}
                onClick={() => void handleDelete()}
              >
                {t('deleteBot')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
