import { memo } from 'react'
import { InformationCircleIcon, PlugSocketIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { cn } from '@renderer/lib/utils'
import type { ProjectMcpAnswer, ProjectMcpDecision } from '@shared/thread'
import { host } from '@renderer/lib/host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard, type AccessDecision } from './access-card'

const ANSWER_TEXT = {
  use: 'projectMcp.answer.use',
  all: 'projectMcp.answer.all',
  skip: 'projectMcp.answer.skip',
  timeout: 'projectMcp.answer.timeout',
} as const satisfies Record<ProjectMcpAnswer, string>

// The card's scopes: these servers, or all of the project's, later ones too.
const DECISION = {
  session: 'use',
  always: 'all',
  deny: 'skip',
} as const satisfies Record<AccessDecision, ProjectMcpDecision>

// How AccessCard reads an answer: an allow by its scope, anything else as denied.
const SHOWN = {
  use: 'session',
  all: 'always',
  skip: 'deny',
  timeout: 'timeout',
} as const satisfies Record<ProjectMcpAnswer, string>

/** The session's folder declares MCP servers or settings of its own, which wait for the user. */
export const ProjectMcpEntry = memo(function ProjectMcpEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'project_mcp')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  if (entry.notice) {
    const names = [
      ...entry.servers.map((server) => server.name),
      ...(entry.items ?? []).map((item) => item.target),
    ]
    return (
      <Marker variant="separator" className={cn('text-xs text-muted-foreground', animation)}>
        <MarkerIcon className="size-3.5">
          <HugeiconsIcon
            icon={InformationCircleIcon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3.5"
          />
        </MarkerIcon>
        <MarkerContent data-selectable="">
          <Trans
            t={t}
            i18nKey="projectMcp.notice"
            values={{
              agent: agentName,
              names: names.join(', '),
              files: (entry.files ?? []).join(', '),
            }}
            components={{ b: <b className="font-medium" dir="auto" /> }}
          />
        </MarkerContent>
      </Marker>
    )
  }
  // A card for the folder's settings as a whole names its files and lists every kind.
  const whole = entry.files !== undefined
  const rows = [
    ...entry.servers.map((server, index) => ({
      id: `server:${index}`,
      label: server.target ? `${server.name} · ${server.target}` : server.name,
      ...(whole ? { meta: t('projectMcp.kind.server') } : {}),
    })),
    ...(entry.items ?? []).map((item, index) => ({
      id: `item:${index}`,
      label: item.target,
      meta: t(`projectMcp.kind.${item.kind}`),
    })),
  ]
  const named = [
    ...entry.servers.map((server) => server.name),
    ...(entry.items ?? []).map((item) => item.target),
  ]
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t(whole ? 'access.action.projectSettings' : 'access.action.projectMcp')}
      target={named.join(', ')}
      glyph={PlugSocketIcon}
      reason={
        whole
          ? [
              t('projectMcp.whereFiles', { files: (entry.files ?? []).join(', ') }),
              ...(entry.selfRun && entry.selfRun.length > 0
                ? [
                    t('projectMcp.selfRun', {
                      agent: agentName,
                      names: entry.selfRun.join(', '),
                      count: entry.selfRun.length,
                    }),
                  ]
                : []),
            ].join(' ')
          : t('projectMcp.where')
      }
      preview={rows}
      previewTitle={t(whole ? 'projectMcp.everything' : 'projectMcp.servers')}
      answer={entry.decision === null ? null : SHOWN[entry.decision]}
      device={entry.device}
      words={{
        allow: { session: t('projectMcp.decision.use'), always: t('projectMcp.decision.all') },
        deny: t('projectMcp.decision.skip'),
        answer: () => t(ANSWER_TEXT[entry.decision ?? 'skip']),
      }}
      request={(decision) =>
        host('sessions.answerProjectMcp', {
          sessionId,
          entryId: entry.id,
          decision: DECISION[decision],
        })
      }
    />
  )
})
