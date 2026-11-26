// Bot 主工作台右侧 4 标签面板：工作（受管电脑 + 活跃/离线待办/已完成一键归档）/ 职责（ROLE.md）
// / 记忆（第 3 层 Bot 记忆管理）/ 设置（配额与删除确认）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Add01Icon,
  Archive01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  ComputerIcon,
  Delete02Icon,
  LaptopIcon,
  PencilEdit02Icon,
  PlayIcon,
  RefreshIcon,
  Search01Icon,
  WifiDisconnected01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  BOT_TERMINAL_STATUSES,
  type BotHostTarget,
  type BotRequest,
  type BotView,
} from '@shared/bots'
import type { MemoryEntry } from '@shared/memory'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { requestsOfBot, useBotsStore } from '@renderer/stores/bots'
import { openBotEditor, openNewSession, openSession } from '@renderer/stores/view'

type PanelTab = 'work' | 'role' | 'memory' | 'settings'

export function BotWorkPanel({ bot, targets }: { bot: BotView; targets: BotHostTarget[] }) {
  const { t } = useTranslation('bots')
  const [tab, setTab] = useState<PanelTab>('work')

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-(--border-subtle) bg-(--bg-sidebar)/50">
      <div className="flex items-center gap-1 border-b border-(--border-subtle) px-2.5 py-2">
        {(
          [
            ['work', t('tabs.work')],
            ['role', t('tabs.role')],
            ['memory', `${t('tabs.memory')}${bot.memoryCount > 0 ? ` (${bot.memoryCount})` : ''}`],
            ['settings', t('tabs.settings')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-caption font-medium transition-colors',
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
        {tab === 'settings' && <SettingsTab bot={bot} />}
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
      {/* 受管电脑实时在线与负载概览 */}
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
}: {
  request: BotRequest
  busy: boolean
  onRetry?: () => void
  onCancel?: () => void
}) {
  const { t } = useTranslation('bots')
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-(--border-subtle) bg-(--bg-surface) p-2.5 text-caption">
      <div className="flex items-start justify-between gap-1.5">
        <span className="font-medium text-primary">{request.title}</span>
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
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const value = draft ?? bot.roleMarkdown
  const dirty = value !== bot.roleMarkdown

  const save = async () => {
    setSaving(true)
    try {
      await update(bot.id, { roleMarkdown: value })
      setDraft(null)
      toast(t('role.saved'), undefined, { tone: 'success' })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2.5">
      <div>
        <h3 className="text-small font-medium text-primary">{t('role.title')}</h3>
        <p className="mt-0.5 text-caption text-tertiary">{t('role.hint')}</p>
      </div>
      <textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('role.placeholder')}
        rows={14}
        className="min-h-[260px] flex-1 resize-y rounded-lg border border-(--border-default) bg-(--bg-surface) p-2.5 font-mono text-caption leading-relaxed text-primary focus:border-(--focus) focus:outline-none"
      />
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {t('saveChanges')}
        </Button>
      </div>
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
                <p className="line-clamp-3 whitespace-pre-wrap text-[11px] text-tertiary">
                  {entry.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SettingsTab({ bot }: { bot: BotView }) {
  const { t } = useTranslation('bots')
  const setPaused = useBotsStore((s) => s.setPaused)
  const resetMain = useBotsStore((s) => s.resetMain)
  const remove = useBotsStore((s) => s.remove)
  const requestsById = useBotsStore((s) => s.requestsById)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [keepSessions, setKeepSessions] = useState(true)
  const [busy, setBusy] = useState(false)

  const sessionCount = useMemo(
    () => Object.values(requestsById).filter((r) => r.botId === bot.id && r.sessionId).length,
    [requestsById, bot.id],
  )

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

      <div className="flex flex-col gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={() => openBotEditor(bot.id)}>
          <Glyph icon={PencilEdit02Icon} size={14} />
          {t('editBot')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void setPaused(bot.id, !bot.paused)}
        >
          {bot.paused ? t('resume') : t('pause')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void resetMain(bot.id)}>
          <Glyph icon={RefreshIcon} size={14} />
          {t('resetMain')}
        </Button>
      </div>

      <div className="mt-2 rounded-xl border border-(--danger-border) bg-(--danger-tint) p-3">
        {!confirmDelete ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-full"
            onClick={() => setConfirmDelete(true)}
          >
            <Glyph icon={Delete02Icon} size={14} />
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
