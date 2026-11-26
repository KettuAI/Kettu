// 受控 MCP 自管理（create_bot / update_bot / delete_bot）的强制交互确认卡片（D5）。
// 任何权限模式（含 Full access）下均等待用户点确认，删除时默认勾选保留历史工作会话为普通会话。

import { memo, useEffect, useRef, useState } from 'react'
import {
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BotChangeEntry as Entry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { PermissionRequest } from '@renderer/components/affect/permission-request'
import { emitAppEvent } from '@renderer/app/events'
import { BotAvatar } from '@renderer/features/bots/bot-avatar'
import { host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { openBot } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'
import { revealWaiting } from './helpers'
import { useSessionHost } from './session-host'
import { useAnswering } from './use-answering'

export const BotChangeEntry = memo(function BotChangeEntry({
  sessionId,
  entryId,
  agentName: asker,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const entry = useEntry(sessionId, entryId, 'bot_change')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return entry.outcome === null ? (
    <BotChangeCard sessionId={sessionId} entry={entry} agentName={asker} className={animation} />
  ) : (
    <BotChangeLine entry={entry} className={animation} />
  )
})

function BotChangeCard({
  sessionId,
  entry,
  agentName: asker,
  className,
}: {
  sessionId: string
  entry: Entry
  agentName: string
  className?: string
}) {
  const { t } = useTranslation(['bots', 'session'])
  const { answering, error, away, send } = useAnswering(sessionId)
  const { hostId } = useSessionHost(sessionId)
  const card = useRef<HTMLDivElement>(null)
  const [doing, setDoing] = useState(false)
  const [keepSessions, setKeepSessions] = useState(entry.bot.keepSessions !== false)

  useEffect(() => {
    revealWaiting(card.current)
  }, [])

  const answer = async (decision: 'confirm' | 'decline') => {
    if (away || answering !== null || doing) return
    const focused = !!card.current?.contains(document.activeElement)
    const sent = await send(decision, () =>
      host('bots.answerChange', {
        sessionId,
        entryId: entry.id,
        decision,
        ...(entry.action === 'delete' ? { keepSessions } : {}),
      }),
    )
    if (sent && decision === 'confirm') setDoing(true)
    if (sent && focused) emitAppEvent({ kind: 'focus-composer' })
  }

  const title = t(`bots:changeCard.title_${entry.action}`)
  const confirmLabel = t(`bots:changeCard.confirm_${entry.action}`)
  const who = t('bots:changeCard.who', { agent: asker })
  const agentLabel = [agentName(entry.bot.agentId, hostId), entry.bot.model, entry.bot.effort]
    .filter(Boolean)
    .join(' · ')
  const scopeLabel = t(`bots:editor.scope.${entry.bot.scope.level}`)
  const limitsLabel = `${entry.bot.limits.maxConcurrent} / ${entry.bot.limits.maxDaily} / ${entry.bot.limits.timeLimitMinutes}m`
  const targetsLabel =
    entry.bot.targets.length > 0
      ? t('bots:changeCard.targetsCount', { count: entry.bot.targets.length })
      : t('bots:changeCard.targetsAny')

  return (
    <div ref={card} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <PermissionRequest
        className={cn(
          'ks-permission ks-settings-card ks-routine-card',
          entry.action === 'delete' && 'ks-routine-card--danger',
        )}
        agent={{
          name: asker,
          avatar: <BotAvatar avatar={entry.bot.avatar} name={entry.bot.name} size={20} />,
        }}
        action={title}
        target={who}
        risk="risky"
        scopes={['once']}
        decision={null}
        onDecisionChange={(next) => {
          if (next) void answer(next.allow ? 'confirm' : 'decline')
        }}
        revocable={false}
        disabled={answering !== null || doing || away}
        actions={
          entry.botId !== null && (
            <button
              type="button"
              className="ui-prc__btn ks-permission__other ks-settings-card__view"
              onClick={() => openBot(entry.botId!)}
            >
              {t('bots:changeCard.openBot')}
              <Icon icon={ArrowRight01Icon} size={12} />
            </button>
          )
        }
        labels={{
          title: () => <b>{title}</b>,
          risk: () => t('session:status.needsApproval'),
          allow: () => (
            <>
              <Icon icon={entry.action === 'delete' ? Delete02Icon : Tick02Icon} size={14} />
              {doing ? t('bots:changeCard.doing') : confirmLabel}
            </>
          ),
          deny: (
            <>
              <Icon icon={Cancel01Icon} size={14} />
              {t('bots:changeCard.decline')}
            </>
          ),
        }}
      >
        <div className="ks-settings-rows ks-routine-rows" data-selectable="">
          <ul>
            <li className="ks-settings-rows__row">
              <span className="ks-routine-rows__label">{t('bots:changeCard.fieldName')}</span>
              <span className="ks-settings-rows__value ks-routine-rows__value">
                {entry.before && entry.before.name !== entry.bot.name && (
                  <>
                    <del>{entry.before.name}</del>
                    <span aria-hidden className="ks-settings-rows__arrow">
                      →
                    </span>
                  </>
                )}
                <ins>{entry.bot.name}</ins>
              </span>
            </li>
            <li className="ks-settings-rows__row">
              <span className="ks-routine-rows__label">{t('bots:changeCard.fieldHandle')}</span>
              <span className="ks-settings-rows__value ks-routine-rows__value">
                <ins>@{entry.bot.handle}</ins>
              </span>
            </li>
            <li className="ks-settings-rows__row">
              <span className="ks-routine-rows__label">{t('bots:changeCard.fieldAgent')}</span>
              <span className="ks-settings-rows__value ks-routine-rows__value">
                <ins>{agentLabel}</ins>
              </span>
            </li>
            {entry.action !== 'delete' && (
              <>
                <li className="ks-settings-rows__row">
                  <span className="ks-routine-rows__label">
                    {t('bots:changeCard.fieldTargets')}
                  </span>
                  <span className="ks-settings-rows__value ks-routine-rows__value">
                    <ins>{targetsLabel}</ins>
                  </span>
                </li>
                <li className="ks-settings-rows__row">
                  <span className="ks-routine-rows__label">{t('bots:changeCard.fieldScope')}</span>
                  <span className="ks-settings-rows__value ks-routine-rows__value">
                    <ins>{scopeLabel}</ins>
                  </span>
                </li>
                <li className="ks-settings-rows__row">
                  <span className="ks-routine-rows__label">{t('bots:changeCard.fieldLimits')}</span>
                  <span className="ks-settings-rows__value ks-routine-rows__value">
                    <ins>{limitsLabel}</ins>
                  </span>
                </li>
              </>
            )}
          </ul>

          {entry.bot.roleMarkdown &&
            (entry.action === 'create' ||
              entry.action === 'role_edit' ||
              entry.before?.roleMarkdown !== entry.bot.roleMarkdown) && (
              <div className="ks-routine-rows__block">
                <span className="ks-routine-rows__label">{t('bots:changeCard.fieldRole')}</span>
                <pre className="mt-1 max-h-32 overflow-y-auto rounded-md bg-(--bg-surface) p-2 font-mono text-caption whitespace-pre-wrap text-secondary">
                  {entry.bot.roleMarkdown}
                </pre>
              </div>
            )}

          {entry.action === 'delete' && (
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-small text-primary">
              <input
                type="checkbox"
                checked={keepSessions}
                onChange={(e) => setKeepSessions(e.target.checked)}
                className="size-3.5 accent-(--control-on)"
              />
              <span>{t('bots:keepSessionsLabel', { count: entry.sessions ?? 0 })}</span>
            </label>
          )}

          {error && <p className="mt-1.5 text-caption text-danger">{error}</p>}
        </div>
      </PermissionRequest>
    </div>
  )
}

function BotChangeLine({ entry, className }: { entry: Entry; className?: string }) {
  const { t } = useTranslation('bots')
  const outcome = entry.outcome!
  const done = outcome.kind === 'done'
  const text = done
    ? t(`changeCard.done_${entry.action}`, { name: entry.bot.name })
    : outcome.kind === 'failed'
      ? t('changeCard.notDone_failed', { message: outcome.message })
      : t(`changeCard.notDone_${outcome.kind}`, { name: entry.bot.name })

  return (
    <div
      data-entry-id={entry.id}
      className={cn(
        'flex items-center gap-2 rounded-lg border border-(--border-subtle) bg-(--bg-subtle)/50 px-3 py-1.5 text-small text-secondary',
        className,
      )}
    >
      <span className={done ? 'inline-flex text-(--success)' : 'inline-flex text-tertiary'}>
        <Icon icon={done ? CheckmarkCircle02Icon : CancelCircleIcon} size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {done && entry.action !== 'delete' && (
        <button
          type="button"
          onClick={() => openBot(outcome.botId)}
          className="inline-flex shrink-0 items-center gap-0.5 text-caption font-medium text-(--primary-foreground) hover:underline"
        >
          {t('changeCard.openBot')}
          <Icon icon={ArrowRight01Icon} size={12} />
        </button>
      )}
    </div>
  )
}
