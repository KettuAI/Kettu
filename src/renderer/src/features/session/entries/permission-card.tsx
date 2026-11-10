import type { Ref } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { PermissionKind, ToolEntry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  PermissionRequest,
  type PermissionDecision,
  type PermissionLabels,
} from '@renderer/components/affect/permission-request'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { ACTION_KEY } from '../decisions/permission'
import { toolLabel } from './helpers'
import { StepCard } from './tool-call'
import { KIND_GLYPH, stepFacts, useToolCallLabels } from './tool-call-model'

const ANSWER_KEY = {
  allow_once: 'allowOnce',
  allow_always: 'allowAlways',
  reject_once: 'rejectOnce',
  reject_always: 'rejectAlways',
} as const satisfies Record<PermissionKind, string>

/** How an answered request reads on the folded card. */
function decisionOf(result: NonNullable<ToolEntry['permissionResult']>): PermissionDecision {
  if (typeof result !== 'object') return { allow: false, scope: 'once', at: 0 }
  return {
    allow: result.kind === 'allow_once' || result.kind === 'allow_always',
    scope: result.kind === 'allow_always' ? 'always' : 'once',
    at: 0,
  }
}

/**
 * A tool call that asks for permission. While it waits, the Decision Card above the composer asks
 * it and the call shows here opened, so its command or diff is in view. Once answered, a line of
 * what was chosen, which an allowed call's own card follows.
 */
export function PermissionEntry({
  ref,
  sessionId,
  entry,
  projectPath,
  agentName,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  projectPath: string
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const toolLabels = useToolCallLabels()
  const permission = entry.permission
  const result = entry.permissionResult
  const label = toolLabel(entry, projectPath)
  const command = label.kind === 'command' ? label.target : null
  const action = t(`permission.card.action.${ACTION_KEY[entry.toolKind]}`)
  const target = command ? command.split('\n')[0]! : label.target
  const decision = permission ? null : result ? decisionOf(result) : null

  // The folded card's line: what was answered, and what follows from it.
  const answeredWords = (): { headline: string; note: string } => {
    if (result === 'cancelled') {
      return {
        headline: t('permission.answer.cancelled'),
        note: t('permission.card.note.cancelled'),
      }
    }
    if (result === 'withdrawn' || !result) {
      return {
        headline: t('permission.answer.withdrawn'),
        note: t('permission.card.note.withdrawn', { agent: agentName }),
      }
    }
    const key = ANSWER_KEY[result.kind]
    const note = t(`permission.card.note.${key}`, { agent: agentName })
    return {
      headline: t(`permission.answer.${key}`),
      note: result.device
        ? t('permission.answer.onDevice', { answer: note, device: result.device.name })
        : note,
    }
  }

  const labels: Partial<PermissionLabels> = {
    title: (name, what) => (
      <Trans
        t={t}
        i18nKey="permission.card.title"
        values={{ agent: name, action: what }}
        components={{ b: <b dir="auto" /> }}
      />
    ),
    result: () => answeredWords(),
  }

  const allowed = typeof result === 'object' && result !== null && decision?.allow === true
  // The waiting call and the allowed one are the same card in the same place, so it stays open.
  const facts = permission || allowed ? stepFacts(sessionId, entry) : null

  return (
    <div
      ref={ref}
      data-entry-id={entry.id}
      className={cn('flex min-w-0 flex-col gap-3.5', className)}
    >
      {decision ? (
        <div className="min-w-0">
          <PermissionRequest
            className="ks-permission"
            agent={{
              name: agentName,
              avatar: agentId ? <AgentMark agent={agentId} size={14} /> : undefined,
            }}
            action={action}
            target={target ?? undefined}
            toolIcon={<Icon icon={KIND_GLYPH[entry.toolKind]} size={12} />}
            decision={decision}
            revocable={false}
            labels={labels}
          />
        </div>
      ) : null}
      {facts && (
        <StepCard
          {...facts}
          icon={<Icon icon={facts.glyph} size={14} />}
          sessionId={sessionId}
          entry={entry}
          projectPath={projectPath}
          labels={toolLabels}
          defaultOpen={!!permission}
          note={permission ? t('decision.waitingStep') : undefined}
        />
      )}
    </div>
  )
}
