import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Cancel01Icon, Tick02Icon, TickDouble02Icon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { FromDevice } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  PermissionRequest,
  type PermissionDecision,
  type PermissionPreviewItem,
} from '@renderer/components/affect/permission-request'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useWebHostStore } from '@renderer/stores/web-host'
import { answeredBy, revealWaiting } from './helpers'

/** How long an access the user allows holds: this session, or always. */
export type AccessDecision = 'session' | 'always' | 'deny'

/**
 * A request to open a site, use a device or use an app, on Permission Request like an agent's
 * own: Deny, the allow for this session, then the allow that lasts. Every client that shows the session
 * answers it through the host and the first answer counts; once answered it folds to one line.
 */
export function AccessCard({
  sessionId,
  entryId,
  agentName,
  className,
  action,
  target,
  glyph,
  reason,
  preview,
  previewTitle,
  answer,
  device,
  words,
  request,
  trailing,
  title,
}: {
  sessionId: string
  entryId: string
  agentName: string
  className?: string
  /** What the agent wants to do, after "wants to". */
  action: string
  target: string
  glyph: IconSvgElement
  reason: string
  /** What an allow starts, listed under the reason. */
  preview?: PermissionPreviewItem[]
  previewTitle?: string
  /** The answer, or null while it waits; anything but an allow reads as denied. */
  answer: string | null
  device: FromDevice | undefined
  words: {
    allow: Record<Exclude<AccessDecision, 'deny'>, string>
    deny: string
    answer: (answer: string) => string
  }
  request: (decision: AccessDecision) => Promise<void>
  /** Another action in place of the lasting allow, which answers nothing by itself; null for none. */
  trailing?: { glyph: IconSvgElement; label: string; onClick: () => void } | null
  /** The card's title in place of "wants to", from the agent's name and the action. */
  title?: (agent: string, action: string) => ReactNode
}) {
  const { t } = useTranslation('session')
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const other = useOtherHost(hostId)
  const served = useWebHostStore((s) => s.host?.name ?? null)
  const [answering, setAnswering] = useState<AccessDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const waiting = answer === null

  useEffect(() => {
    if (waiting) revealWaiting(card.current)
  }, [waiting])

  const send = async (decision: AccessDecision) => {
    if (answering) return
    setAnswering(decision)
    setError(null)
    try {
      await request(decision)
    } catch (caught) {
      const by = answeredBy(caught)
      if (by !== undefined) {
        // The card takes the first answer as its patch lands, so the note goes in a toast.
        const where = by?.name ?? (hostId !== null ? (other?.name ?? null) : served)
        toast(
          where ? t('permission.answeredOn', { device: where }) : t('permission.answeredInWindow'),
        )
      } else {
        setError(errorMessage(caught))
      }
    } finally {
      setAnswering(null)
    }
  }

  const allowed = answer === 'session' || answer === 'always'
  const decision: PermissionDecision | null =
    answer === null
      ? null
      : { allow: allowed, scope: answer === 'always' ? 'always' : 'once', at: 0 }

  return (
    <div ref={card} data-entry-id={entryId} className={cn('min-w-0', className)}>
      <PermissionRequest
        className="ks-permission"
        agent={{
          name: agentName,
          avatar: agentId ? <AgentMark agent={agentId} size={14} hostId={hostId} /> : undefined,
        }}
        action={action}
        target={target}
        toolIcon={<Icon icon={glyph} size={12} />}
        risk="safe"
        reason={reason}
        {...(preview ? { preview, previewTitle, previewLimit: preview.length } : {})}
        scopes={['once']}
        decision={decision}
        onDecisionChange={(next) => {
          if (next) void send(next.allow ? 'session' : 'deny')
        }}
        revocable={false}
        disabled={answering !== null}
        trailingActions={
          trailing === null ? undefined : trailing ? (
            <button
              type="button"
              className="ui-prc__btn"
              disabled={answering !== null}
              onClick={trailing.onClick}
            >
              <Icon icon={trailing.glyph} size={14} />
              {trailing.label}
            </button>
          ) : (
            <button
              type="button"
              className="ui-prc__btn ks-permission__always"
              disabled={answering !== null}
              onClick={() => void send('always')}
            >
              <Icon icon={TickDouble02Icon} size={14} />
              {words.allow.always}
            </button>
          )
        }
        labels={{
          title: (name, what) =>
            title ? (
              title(name, what)
            ) : (
              <Trans
                t={t}
                i18nKey="permission.card.title"
                values={{ agent: name, action: what }}
                components={{ b: <b dir="auto" /> }}
              />
            ),
          allow: () => (
            <>
              <Icon icon={Tick02Icon} size={14} />
              {words.allow.session}
            </>
          ),
          deny: (
            <>
              <Icon icon={Cancel01Icon} size={14} />
              {words.deny}
            </>
          ),
          result: () => {
            const headline = words.answer(answer ?? '')
            return {
              headline,
              note: device
                ? t('permission.answer.onDevice', { answer: target, device: device.name })
                : target,
            }
          },
        }}
      />
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}
