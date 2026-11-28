// Bot main workbench screen:
// - Header: Bot avatar, name, @handle, Home Host badge, connected external channel pills,
//   online hosts count, quick dispatch, pause/resume, edit, and right panel toggle.
// - Center: native SessionView for the isolated main conversation (or clean first-message state).
// - Right: 4-tab BotWorkPanel (Work / Role / Memory / Channels & Settings).

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  Rocket01Icon,
  SentIcon,
  SidebarRight01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BotView } from '@shared/bots'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { SessionView } from '@renderer/features/session/session-view'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { isBotBoundToChannel, useBotsStore } from '@renderer/stores/bots'
import { openBotEditor } from '@renderer/stores/view'
import { BotAvatar } from './bot-avatar'
import { BotWorkPanel, type BotPanelTab } from './bot-work-panel'

export default function BotWorkbench({ botId }: { botId: string }) {
  const { t } = useTranslation('bots')
  const bot = useBotsStore((s) => s.byId[botId])
  const targets = useBotsStore((s) => s.targets)
  const channels = useBotsStore((s) => s.channels)
  const refreshTargets = useBotsStore((s) => s.refreshTargets)
  const setPaused = useBotsStore((s) => s.setPaused)
  const sendMain = useBotsStore((s) => s.sendMain)
  const dispatch = useBotsStore((s) => s.dispatch)

  const [panelOpen, setPanelOpen] = useState(true)
  const [panelTab, setPanelTab] = useState<BotPanelTab>('work')
  const [quickOpen, setQuickOpen] = useState(false)
  const [firstPrompt, setFirstPrompt] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    void refreshTargets()
  }, [botId, refreshTargets])

  const homeName = useMemo(
    () => targets.find((item) => item.self)?.name ?? t('thisComputer'),
    [targets, t],
  )
  const onlineCount = targets.filter((item) => item.online).length

  const channelBadges = useMemo(() => {
    if (!bot) return []
    return channels
      .filter((ch) => isBotBoundToChannel(bot, ch))
      .map((ch) => {
        const needsSetup = ch.missingRequiredSettings.length > 0
        return {
          key: ch.channelKey,
          label: ch.shortLabel,
          state: needsSetup ? ('off' as const) : ch.state,
          tooltip: needsSetup
            ? t('channels.state.needsSetup')
            : ch.detail || t(`channels.state.${ch.state}`),
        }
      })
  }, [bot, channels, t])

  if (!bot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-small text-secondary">{t('sidebar.empty')}</p>
        <Button type="button" size="sm" onClick={() => openBotEditor(null)}>
          {t('newBot')}
        </Button>
      </div>
    )
  }

  const handleFirstSend = async (event: FormEvent) => {
    event.preventDefault()
    const text = firstPrompt.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await sendMain(bot.id, text)
      setFirstPrompt('')
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--bg-app)">
      <header className="app-region-drag flex shrink-0 items-center justify-between gap-3 border-b border-(--border-subtle) px-4 py-2.5">
        <div className="app-region-no-drag flex min-w-0 items-center gap-2.5">
          <BotAvatar
            avatar={bot.avatar}
            name={bot.name}
            botId={bot.id}
            size={32}
            status={bot.status}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h1 className="truncate text-[14.5px] font-semibold text-primary">{bot.name}</h1>
              <span className="shrink-0 rounded-md bg-(--bg-subtle) px-1.5 py-0.5 font-mono text-[11px] text-secondary">
                @{bot.handle}
              </span>
              <span className="hidden shrink-0 rounded-full border border-(--border-subtle) px-2 py-0.5 text-[11px] text-tertiary sm:inline-flex">
                {t('homeHost', { name: homeName })}
              </span>
              {channelBadges.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setPanelOpen(true)
                    setPanelTab('settings')
                  }}
                  title={item.tooltip}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-(--border-subtle) bg-(--bg-surface) px-2 py-0.5 text-[10.5px] font-medium text-secondary transition-colors hover:border-(--border-strong) hover:text-primary"
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      item.state === 'connected'
                        ? 'bg-(--success)'
                        : item.state === 'connecting' || item.state === 'reconnecting'
                          ? 'animate-pulse bg-(--warning)'
                          : item.state === 'error'
                            ? 'bg-(--danger)'
                            : 'bg-(--border-strong)',
                    )}
                  />
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-caption text-tertiary">
              {bot.description && <span className="truncate">{bot.description}</span>}
              {targets.length > 0 && (
                <span className="shrink-0 tabular-nums">
                  {t('onlineHosts', { online: onlineCount, total: targets.length })}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="app-region-no-drag flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={bot.paused}
            onClick={() => setQuickOpen((v) => !v)}
          >
            <Glyph icon={Rocket01Icon} size={13} />
            {t('workbench.quickDispatch')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void setPaused(bot.id, !bot.paused)}
          >
            <Glyph icon={bot.paused ? PlayIcon : PauseIcon} size={13} />
            {bot.paused ? t('resume') : t('pause')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('editBot')}
            onClick={() => openBotEditor(bot.id)}
          >
            <Glyph icon={PencilEdit02Icon} size={14} />
          </Button>
          <Button
            type="button"
            variant={panelOpen ? 'secondary' : 'ghost'}
            size="icon-xs"
            aria-label={t('tabs.work')}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <Glyph icon={SidebarRight01Icon} size={14} />
          </Button>
        </div>
      </header>

      {bot.paused && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--border-subtle) bg-(--warning-tint) px-4 py-1.5 text-caption text-(--warning)">
          <span>{t('workbench.pausedBanner')}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void setPaused(bot.id, false)}
          >
            {t('resume')}
          </Button>
        </div>
      )}

      {quickOpen && (
        <QuickDispatchBar
          bot={bot}
          onClose={() => setQuickOpen(false)}
          onDispatch={async (params) => {
            await dispatch({ botId: bot.id, ...params })
            setQuickOpen(false)
          }}
        />
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {bot.mainSessionId ? (
            <SessionView key={bot.mainSessionId} sessionId={bot.mainSessionId} hideHeader />
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-6">
              <div className="flex w-full max-w-[580px] flex-col items-center gap-4 text-center">
                <BotAvatar
                  avatar={bot.avatar}
                  name={bot.name}
                  botId={bot.id}
                  size={64}
                  status={bot.status}
                />
                <div className="space-y-1">
                  <h2 className="text-base font-semibold text-primary">
                    {t('workbench.emptyTitle', { name: bot.name })}
                  </h2>
                  <p className="text-small text-secondary">
                    {t('workbench.emptyBody', { name: bot.name })}
                  </p>
                </div>

                <form
                  onSubmit={(e) => void handleFirstSend(e)}
                  className="mt-2 flex w-full flex-col gap-2 rounded-2xl border border-(--border-default) bg-(--bg-surface) p-3 shadow-(--elevation-float)"
                >
                  <textarea
                    rows={3}
                    value={firstPrompt}
                    onChange={(e) => setFirstPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void handleFirstSend(e)
                      }
                    }}
                    placeholder={t('workbench.placeholder', {
                      name: bot.name,
                      handle: bot.handle,
                    })}
                    className="w-full resize-none bg-transparent text-small text-primary placeholder:text-(--text-placeholder) focus:outline-none"
                  />
                  <div className="flex items-center justify-end">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!firstPrompt.trim() || sending}
                      className="rounded-full"
                    >
                      <Glyph icon={SentIcon} size={14} />
                      {t('workbench.send')}
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>

        {panelOpen && (
          <BotWorkPanel bot={bot} targets={targets} tab={panelTab} onTabChange={setPanelTab} />
        )}
      </div>
    </div>
  )
}

function QuickDispatchBar({
  bot,
  onClose,
  onDispatch,
}: {
  bot: BotView
  onClose: () => void
  onDispatch: (params: {
    targetHostId: string | null
    projectPath: string
    title: string
    prompt: string
    worktree: boolean
  }) => Promise<void>
}) {
  const { t } = useTranslation('bots')
  const targets = useBotsStore((s) => s.targets)
  const options = useMemo(() => {
    const rows: Array<{
      key: string
      hostId: string | null
      hostName: string
      online: boolean
      projectPath: string
      projectName: string
    }> = []
    for (const host of targets) {
      for (const proj of host.projects) {
        rows.push({
          key: `${host.hostId ?? 'local'}::${proj.path}`,
          hostId: host.hostId,
          hostName: host.name,
          online: host.online,
          projectPath: proj.path,
          projectName: proj.name,
        })
      }
    }
    return rows
  }, [targets])

  const defaultChoice =
    bot.targets.length > 0
      ? `${bot.targets[0]!.hostId ?? 'local'}::${bot.targets[0]!.projectPath}`
      : (options[0]?.key ?? '')
  const [selectedKey, setSelectedKey] = useState(defaultChoice)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const picked = options.find((o) => o.key === selectedKey)
    if (!picked || !title.trim() || !prompt.trim()) return
    setBusy(true)
    try {
      await onDispatch({
        targetHostId: picked.hostId,
        projectPath: picked.projectPath,
        title: title.trim(),
        prompt: prompt.trim(),
        worktree,
      })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex shrink-0 flex-col gap-2.5 border-b border-(--border-subtle) bg-(--bg-subtle)/60 px-4 py-3 text-caption"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-primary">{t('workbench.quickDispatchTitle')}</span>
        <button type="button" onClick={onClose} className="text-tertiary hover:text-primary">
          {t('work.cancel')}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <select
          value={selectedKey}
          onChange={(e) => setSelectedKey(e.target.value)}
          className="h-8 rounded-lg border border-(--border-default) bg-(--bg-surface) px-2 text-caption text-primary"
        >
          {options.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.hostName} / {opt.projectName}
              {opt.online ? '' : ` (${t('work.offline')})`}
            </option>
          ))}
        </select>
        <input
          type="text"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('workbench.quickDispatchTask')}
          className="h-8 rounded-lg border border-(--border-default) bg-(--bg-surface) px-2.5 text-caption text-primary"
        />
      </div>
      <textarea
        rows={2}
        required
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t('workbench.quickDispatchPrompt')}
        className="resize-none rounded-lg border border-(--border-default) bg-(--bg-surface) p-2 text-caption text-primary"
      />
      <div className="flex items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-secondary">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(e) => setWorktree(e.target.checked)}
            className="size-3.5 accent-(--control-on)"
          />
          <span>{t('workbench.quickDispatchWorktree')}</span>
        </label>
        <Button
          type="submit"
          size="xs"
          disabled={busy || !selectedKey || !title.trim() || !prompt.trim()}
        >
          {t('workbench.quickDispatchSubmit')}
        </Button>
      </div>
    </form>
  )
}
