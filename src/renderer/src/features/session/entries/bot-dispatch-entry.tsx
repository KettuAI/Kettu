// Dispatch Card rendered inside a Bot's main conversation stream:
// Displays target host OS icon, project, agent/model, branch, external source pill (TG/Feishu/GH/Routine),
// external reply delivery status, live status, retry/cancel, open session, and detach-to-normal-session.

import { memo, useState } from 'react'
import {
  ArrowRight01Icon,
  Cancel01Icon,
  ComputerIcon,
  GitBranchIcon,
  LaptopIcon,
  PlayIcon,
  Tick02Icon,
  WifiDisconnected01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { Glyph } from '@renderer/features/shell/glyph'
import { SourceKindBadge } from '@renderer/features/sidebar/bot-group'
import { errorMessage } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useBotsStore } from '@renderer/stores/bots'
import { openSession } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'

export const BotDispatchEntry = memo(function BotDispatchEntry({
  sessionId,
  entryId,
}: {
  sessionId: string
  entryId: string
}) {
  const { t } = useTranslation('bots')
  const entry = useEntry(sessionId, entryId, 'bot_dispatch')
  const animation = useEntryAnimation(sessionId, entryId)
  const retryPending = useBotsStore((s) => s.retryPending)
  const cancelRequest = useBotsStore((s) => s.cancelRequest)
  const detachSession = useBotsStore((s) => s.detachSession)
  const [busy, setBusy] = useState(false)

  if (!entry) return null

  const badgeTone =
    entry.status === 'waiting_user'
      ? 'bg-(--attention-dot)/15 text-(--attention)'
      : entry.status === 'running'
        ? 'bg-(--info-tint) text-(--info)'
        : entry.status === 'waiting_host'
          ? 'bg-(--warning-tint) text-(--warning)'
          : entry.status === 'delivered'
            ? 'bg-(--success-tint) text-(--success)'
            : entry.status === 'failed'
              ? 'bg-(--danger-tint) text-(--danger)'
              : 'bg-(--bg-subtle) text-tertiary'

  const handleRetry = async () => {
    setBusy(true)
    try {
      await retryPending(entry.requestId)
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async () => {
    setBusy(true)
    try {
      await cancelRequest(entry.requestId)
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  const handleDetach = async () => {
    if (!entry.sessionId) return
    setBusy(true)
    try {
      const ok = await detachSession(entry.sessionId)
      if (ok) toast(t('work.detachedToast'), undefined, { tone: 'success' })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-entry-id={entry.id}
      className={cn(
        'my-1.5 flex flex-col gap-2 rounded-xl border bg-(--bg-surface) p-3 shadow-(--elevation-card)',
        entry.status === 'waiting_user'
          ? 'border-(--attention-dot)/50'
          : entry.status === 'waiting_host'
            ? 'border-(--warning)/40'
            : 'border-(--border-default)',
        animation,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5 text-caption text-tertiary">
            <SourceKindBadge kind={entry.sourceKind} label={entry.sourceLabel ?? undefined} />
            <span className="inline-flex items-center gap-1 font-medium text-secondary">
              {entry.targetHostId === null ? (
                <Glyph
                  icon={entry.targetPlatform === 'darwin' ? LaptopIcon : ComputerIcon}
                  size={12}
                />
              ) : (
                <HostIcon platform={entry.targetPlatform} className="size-3" />
              )}
              {entry.targetHostName}
            </span>
            <span>/</span>
            <span className="font-medium text-primary">{entry.projectName}</span>
            <span>·</span>
            <span>
              {agentName(entry.agentId, entry.targetHostId)}
              {entry.model ? ` · ${entry.model}` : ''}
            </span>
            {entry.branch && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-0.5 font-mono">
                  <Glyph icon={GitBranchIcon} size={11} />
                  {entry.branch}
                </span>
              </>
            )}
            {entry.sourceLabel && (
              <>
                <span>·</span>
                <span className="truncate text-tertiary">{entry.sourceLabel}</span>
              </>
            )}
          </div>
          <p className="text-small font-medium text-primary">{entry.title}</p>
        </div>

        <span
          className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', badgeTone)}
        >
          {t(`requestStatus.${entry.status}`)}
        </span>
      </div>

      {entry.status === 'waiting_host' && (
        <div className="flex items-center gap-1.5 rounded-lg bg-(--warning-tint) px-2.5 py-1.5 text-caption text-(--warning)">
          <Glyph icon={WifiDisconnected01Icon} size={13} className="shrink-0" />
          <span>{t('work.offlineSavedNote')}</span>
        </div>
      )}

      {entry.error && (
        <p className="rounded-lg bg-(--danger-tint) px-2.5 py-1.5 text-caption text-danger">
          {entry.error}
        </p>
      )}

      {entry.summary && entry.status !== 'waiting_host' && (
        <p className="line-clamp-3 text-caption leading-relaxed text-secondary">{entry.summary}</p>
      )}

      {entry.repliedAt && (
        <div className="inline-flex items-center gap-1 text-[11px] text-(--success)">
          <Glyph icon={Tick02Icon} size={11} />
          <span>{t('work.repliedExternal')}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {entry.sessionId && (
          <Button
            type="button"
            variant={entry.status === 'waiting_user' ? 'default' : 'outline'}
            size="xs"
            onClick={() =>
              openSession(entry.sessionId!, onHost(entry.targetHostId, entry.projectPath))
            }
          >
            {t('work.openSession')}
            <Glyph icon={ArrowRight01Icon} size={12} />
          </Button>
        )}
        {entry.sessionId && entry.targetHostId === null && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => void handleDetach()}
          >
            {t('work.detachSession')}
          </Button>
        )}
        {(entry.status === 'waiting_host' || entry.status === 'failed') && (
          <Button
            type="button"
            variant="default"
            size="xs"
            disabled={busy}
            onClick={() => void handleRetry()}
          >
            <Glyph icon={PlayIcon} size={12} />
            {t('work.dispatchNow')}
          </Button>
        )}
        {(entry.status === 'waiting_host' ||
          entry.status === 'queued' ||
          entry.status === 'running') && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => void handleCancel()}
          >
            <Glyph icon={Cancel01Icon} size={12} />
            {t('work.cancel')}
          </Button>
        )}
      </div>
    </div>
  )
})
