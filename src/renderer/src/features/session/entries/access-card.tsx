import type { IconSvgElement } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { FromDevice } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  PermissionRequest,
  type PermissionDecision,
} from '@renderer/components/affect/permission-request'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'

/** How long an access the user allows holds: this session, or always. */
export type AccessDecision = 'session' | 'always' | 'deny'

/** What a request for access asks and how it is answered, which its card and the Decision Card share. */
export interface AccessAsk {
  /** What the agent wants to do, after "wants to". */
  action: string
  target: string
  /** The target's label on the Decision Card. */
  targetLabel: string
  glyph: IconSvgElement
  reason: string
  /** What an allow starts, which the Decision Card lists in place of the target. */
  preview?: string[]
  words: {
    allow: Record<Exclude<AccessDecision, 'deny'>, string>
    deny: string
    answer: (answer: string) => string
  }
  request: (decision: AccessDecision) => Promise<void>
}

/**
 * A request to open a site, use a device or use an app once answered, on Permission Request like
 * an agent's own, folded to one line. While it waits, the Decision Card above the composer asks
 * it; every client that shows the session answers through the host and the first answer counts.
 */
export function AccessCard({
  sessionId,
  entryId,
  agentName,
  className,
  action,
  target,
  glyph,
  answer,
  device,
  words,
}: AccessAsk & {
  sessionId: string
  entryId: string
  agentName: string
  className?: string
  /** The answer, or null while it waits; anything but an allow reads as denied. */
  answer: string | null
  device: FromDevice | undefined
}) {
  const { t } = useTranslation('session')
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))

  if (answer === null) return null
  const decision: PermissionDecision = {
    allow: answer === 'session' || answer === 'always',
    scope: answer === 'always' ? 'always' : 'once',
    at: 0,
  }
  return (
    <div data-entry-id={entryId} className={cn('min-w-0', className)}>
      <PermissionRequest
        className="ks-permission"
        agent={{
          name: agentName,
          avatar: agentId ? <AgentMark agent={agentId} size={14} hostId={hostId} /> : undefined,
        }}
        action={action}
        target={target}
        toolIcon={<Icon icon={glyph} size={12} />}
        decision={decision}
        revocable={false}
        labels={{
          title: (name, what) => (
            <Trans
              t={t}
              i18nKey="permission.card.title"
              values={{ agent: name, action: what }}
              components={{ b: <b dir="auto" /> }}
            />
          ),
          result: () => ({
            headline: words.answer(answer),
            note: device
              ? t('permission.answer.onDevice', { answer: target, device: device.name })
              : target,
          }),
        }}
      />
    </div>
  )
}
