// 侧边栏 Bots 分组（D3）：位于顶部导航下方、电脑项目分组上方。
// 展开单个 Bot 时挂载其未归档的活跃工作会话与离线待办（展示目标电脑 OS 图标 + 项目名 + 状态），
// 干完归档即收起，避免淹没项目列表。

import { useMemo, useState } from 'react'
import {
  Add01Icon,
  ArrowRight01Icon,
  ComputerIcon,
  LaptopIcon,
  WifiDisconnected01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BotRequest, BotView } from '@shared/bots'
import { BOT_TERMINAL_STATUSES } from '@shared/bots'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { BotAvatar } from '@renderer/features/bots/bot-avatar'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { Glyph } from '@renderer/features/shell/glyph'
import { onHost } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { sortedBots, useBotsStore } from '@renderer/stores/bots'
import { openBot, openBotEditor, openSession, useViewStore } from '@renderer/stores/view'

/** 侧边栏 Bots 分组。 */
export function BotsGroup() {
  const { t } = useTranslation('bots')
  const byId = useBotsStore((s) => s.byId)
  const requestsById = useBotsStore((s) => s.requestsById)
  const loaded = useBotsStore((s) => s.loaded)
  const main = useViewStore((s) => s.main)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const bots = useMemo(() => sortedBots(byId), [byId])
  const workByBot = useMemo(() => {
    const map = new Map<string, BotRequest[]>()
    for (const req of Object.values(requestsById)) {
      if (req.archivedAt !== null) continue
      // 仅挂载活跃、待批、排队、离线待办，以及最近未归档的失败/刚完成项
      const list = map.get(req.botId) ?? []
      list.push(req)
      map.set(req.botId, list)
    }
    for (const [id, list] of map.entries()) {
      list.sort((a, b) => b.updatedAt - a.updatedAt)
      map.set(id, list.slice(0, 6))
    }
    return map
  }, [requestsById])

  if (!loaded) return null

  const toggle = (botId: string) =>
    setExpanded((prev) => ({ ...prev, [botId]: !(prev[botId] ?? true) }))

  return (
    <section aria-label={t('sidebar.section')} className="ui-as-side__group">
      <div className="ui-as-side__label kettu-projects-label">
        <span className="inline-flex items-center gap-1.5">
          <span>{t('sidebar.section')}</span>
          {bots.length > 0 && <span className="tabular-nums text-tertiary">{bots.length}</span>}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('sidebar.add')}
                onClick={() => openBotEditor(null)}
                className="size-5 rounded-md text-tertiary hover:text-primary"
              />
            }
          >
            <Glyph icon={Add01Icon} size={13} />
          </TooltipTrigger>
          <TooltipContent side="right">{t('sidebar.add')}</TooltipContent>
        </Tooltip>
      </div>

      {bots.length === 0 ? (
        <button
          type="button"
          onClick={() => openBotEditor(null)}
          className="mx-1.5 my-0.5 flex items-center gap-2 rounded-lg border border-dashed border-(--border-default) px-2.5 py-2 text-left text-caption text-tertiary transition-colors hover:border-(--border-strong) hover:bg-(--bg-hover) hover:text-primary"
        >
          <Glyph icon={Add01Icon} size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 leading-snug">{t('sidebar.empty')}</span>
        </button>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {bots.map((bot) => {
            const active =
              (main.kind === 'bot' && main.botId === bot.id) ||
              (main.kind === 'bot-edit' && main.botId === bot.id)
            const items = workByBot.get(bot.id) ?? []
            const isOpen =
              expanded[bot.id] ?? items.some((r) => !BOT_TERMINAL_STATUSES.has(r.status))
            return (
              <BotSidebarRow
                key={bot.id}
                bot={bot}
                active={active}
                items={items}
                open={isOpen}
                onToggle={() => toggle(bot.id)}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}

function BotSidebarRow({
  bot,
  active,
  items,
  open,
  onToggle,
}: {
  bot: BotView
  active: boolean
  items: BotRequest[]
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('bots')
  const activeItems = items.filter(
    (r) => !BOT_TERMINAL_STATUSES.has(r.status) || r.status === 'failed',
  )
  const hasChildren = activeItems.length > 0

  return (
    <li className="flex flex-col">
      <div
        className={cn(
          'group flex h-[30px] items-center gap-1.5 rounded-lg px-1.5 text-[13.5px] transition-colors',
          active
            ? 'bg-(--bg-raised) font-medium text-primary shadow-(--elevation-raised)'
            : 'text-primary hover:bg-(--bg-hover)',
        )}
      >
        <button
          type="button"
          aria-label={bot.name}
          aria-expanded={hasChildren ? open : undefined}
          onClick={() => {
            if (hasChildren) onToggle()
            else openBot(bot.id)
          }}
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded text-tertiary transition-transform hover:text-primary',
            !hasChildren && 'opacity-0 pointer-events-none',
            open && 'rotate-90',
          )}
        >
          <Glyph icon={ArrowRight01Icon} size={11} />
        </button>

        <button
          type="button"
          onClick={() => openBot(bot.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
        >
          <BotAvatar
            avatar={bot.avatar}
            name={bot.name}
            botId={bot.id}
            size={20}
            status={bot.status}
          />
          <span className="min-w-0 flex-1 truncate">{bot.name}</span>
          {bot.needsYouCount > 0 ? (
            <span className="shrink-0 rounded-full bg-(--attention-dot)/15 px-1.5 py-0.5 text-[10.5px] font-medium text-(--attention) tabular-nums">
              {bot.needsYouCount}
            </span>
          ) : bot.pendingHostCount > 0 ? (
            <span
              title={t('sidebar.pendingHost', { count: bot.pendingHostCount })}
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-(--warning-tint) px-1.5 py-0.5 text-[10.5px] text-(--warning) tabular-nums"
            >
              <Glyph icon={WifiDisconnected01Icon} size={10} />
              {bot.pendingHostCount}
            </span>
          ) : bot.activeCount > 0 ? (
            <span className="shrink-0 text-caption text-tertiary tabular-nums">
              {bot.activeCount}
            </span>
          ) : bot.paused ? (
            <span className="shrink-0 text-[10.5px] text-tertiary">{t('paused')}</span>
          ) : null}
        </button>
      </div>

      {hasChildren && open && (
        <ul className="mt-0.5 ml-[22px] flex flex-col gap-0.5 border-l border-(--border-subtle) pl-2">
          {activeItems.map((req) => (
            <li key={req.id}>
              <button
                type="button"
                onClick={() => {
                  if (req.sessionId) {
                    openSession(req.sessionId, onHost(req.targetHostId, req.projectPath))
                  } else {
                    openBot(bot.id)
                  }
                }}
                className="flex h-[26px] w-full items-center gap-1.5 rounded-md px-1.5 text-left text-caption text-secondary transition-colors hover:bg-(--bg-hover) hover:text-primary"
              >
                {req.targetHostId === null ? (
                  <Glyph
                    icon={req.targetPlatform === 'darwin' ? LaptopIcon : ComputerIcon}
                    size={12}
                    className="shrink-0 text-tertiary"
                  />
                ) : (
                  <HostIcon
                    platform={req.targetPlatform}
                    className="size-3 shrink-0 text-tertiary"
                  />
                )}
                <span className="shrink-0 font-medium text-tertiary">{req.projectName}</span>
                <span className="min-w-0 flex-1 truncate">{req.title}</span>
                <RequestDot status={req.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function RequestDot({ status }: { status: BotRequest['status'] }) {
  if (status === 'waiting_user') {
    return <span className="size-1.5 shrink-0 rounded-full bg-(--attention-dot)" />
  }
  if (status === 'running') {
    return <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-(--thread-fox)" />
  }
  if (status === 'waiting_host') {
    return <span className="size-1.5 shrink-0 rounded-full bg-(--warning)" />
  }
  if (status === 'failed') {
    return <span className="size-1.5 shrink-0 rounded-full bg-(--danger)" />
  }
  return <span className="size-1.5 shrink-0 rounded-full bg-(--border-strong)" />
}
