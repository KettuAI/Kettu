import { useEffect, useRef, useState } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { FromDevice } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  PermissionRequest,
  type PermissionDecision,
  type PermissionScope,
} from '@renderer/components/affect/permission-request'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useWebHostStore } from '@renderer/stores/web-host'
import { answeredBy } from './helpers'

/** How long an access the user allows holds: this session, or always. */
export type AccessDecision = 'session' | 'always' | 'deny'

const SCOPE: Record<Exclude<AccessDecision, 'deny'>, PermissionScope> = {
  session: 'once',
  always: 'always',
}

/**
 * A request to open a site, use a device or use an app, on Permission Request like an agent's
 * own: how long on its Segmented Control, then Deny or Allow. Every client that shows the session
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
  answer,
  device,
  words,
  request,
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
  /** The answer, or null while it waits; anything but an allow reads as denied. */
  answer: string | null
  device: FromDevice | undefined
  words: {
    scope: Record<Exclude<AccessDecision, 'deny'>, string>
    allow: Record<Exclude<AccessDecision, 'deny'>, string>
    deny: string
    answer: (answer: string) => string
  }
  request: (decision: AccessDecision) => Promise<void>
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
    if (waiting) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
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
  const scopeOf = (scope: PermissionScope): 'session' | 'always' =>
    scope === 'always' ? 'always' : 'session'

  return (
    <div ref={card} data-entry-id={entryId} className={cn('min-w-0', className)}>
      <PermissionRequest
        className="ks-permission"
        agent={{
          name: agentName,
          avatar: agentId ? <AgentMark agent={agentId} size={14} /> : undefined,
        }}
        action={action}
        target={target}
        toolIcon={<Icon icon={glyph} size={12} />}
        risk="safe"
        reason={reason}
        scopes={[SCOPE.session, SCOPE.always]}
        renderScopes={({ scopes, scope, onChange }) => (
          <SegmentedControl
            aria-label={t('permission.card.howLong')}
            variant="tray"
            value={scope}
            onChange={onChange}
            disabled={answering !== null}
            options={scopes.map((s) => ({ value: s, label: words.scope[scopeOf(s)] }))}
          />
        )}
        decision={decision}
        onDecisionChange={(next) => {
          if (next) void send(next.allow ? scopeOf(next.scope) : 'deny')
        }}
        revocable={false}
        disabled={answering !== null}
        labels={{
          title: (name, what) => (
            <Trans
              t={t}
              i18nKey="permission.card.title"
              values={{ agent: name, action: what }}
              components={{ b: <b dir="auto" /> }}
            />
          ),
          allow: (scope) => words.allow[scopeOf(scope)],
          deny: words.deny,
          howLong: t('permission.card.howLong'),
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
