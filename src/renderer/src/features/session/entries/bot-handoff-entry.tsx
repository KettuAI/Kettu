// Lightweight inline row inside a regular session for @Bot handoffs and Bot reply summaries.

import { memo, useState } from 'react'
import { ArrowRight01Icon, MailSend01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { BotAvatar } from '@renderer/features/bots/bot-avatar'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useBotsStore } from '@renderer/stores/bots'
import { openBot } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'

export const BotHandoffEntry = memo(function BotHandoffEntry({
  sessionId,
  entryId,
}: {
  sessionId: string
  entryId: string
}) {
  const { t } = useTranslation('bots')
  const entry = useEntry(sessionId, entryId, 'bot_handoff')
  const animation = useEntryAnimation(sessionId, entryId)
  const bot = useBotsStore((s) => (entry ? s.byId[entry.botId] : undefined))
  const [sending, setSending] = useState(false)

  if (!entry) return null

  const label =
    entry.status === 'completed'
      ? t('handoff.completed', { name: entry.botName })
      : entry.status === 'failed'
        ? t('handoff.failed', { name: entry.botName })
        : t('handoff.sent', { name: entry.botName, handle: entry.botHandle })

  const forwardSummary = async () => {
    if (!entry.summary || sending) return
    setSending(true)
    try {
      await host('sessions.queue', {
        sessionId,
        content: [
          {
            type: 'text',
            text: `[Report from Bot ${entry.botName} (@${entry.botHandle})]\n${entry.summary}`,
          },
        ],
      })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      data-entry-id={entry.id}
      className={cn(
        'my-1 flex flex-col gap-1.5 rounded-xl border border-(--border-subtle) bg-(--bg-subtle)/60 px-3 py-2 text-small',
        animation,
      )}
    >
      <div className="flex items-center gap-2">
        <BotAvatar
          avatar={
            bot?.avatar ?? { kind: 'monogram', text: entry.botName.slice(0, 2), palette: 'fox' }
          }
          name={entry.botName}
          botId={entry.botId}
          size={20}
          status={bot?.status}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-primary">{label}</span>
        <Button type="button" variant="ghost" size="xs" onClick={() => openBot(entry.botId)}>
          {t('handoff.openBot')}
          <Glyph icon={ArrowRight01Icon} size={12} />
        </Button>
      </div>
      <p className="line-clamp-2 text-caption text-tertiary">{entry.prompt}</p>
      {entry.summary && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-(--border-subtle) bg-(--bg-surface) p-2">
          <p className="line-clamp-4 text-caption leading-relaxed text-secondary">
            {entry.summary}
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={sending}
              onClick={() => void forwardSummary()}
            >
              <Glyph icon={MailSend01Icon} size={12} />
              {t('handoff.sendToAgent')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
})
