import { useTranslation } from 'react-i18next'
import { AgentFace } from '@renderer/components/affect/agent-cursors'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import type { CanvasAgent } from './canvas-editor'
import type { Presence } from './use-artifact'

/** The most faces the bar shows before the rest fold into +N. */
const MAX_FACES = 6

/**
 * Who is here, as affectUI's Agent Cursors shows it: the faces of the agents using the artifact,
 * whose ring turns while they work, and of the user's other devices; a click follows one.
 */
export function PresenceFaces({
  agents,
  presence,
  pageName,
  following,
  onFollow,
}: {
  agents: readonly CanvasAgent[]
  presence: Presence | null
  pageName: (id: string | null) => string | null
  following: string | null
  onFollow: (sessionId: string | null) => void
}) {
  const { t } = useTranslation('artifacts')
  const clients = presence?.clients ?? []
  const shown = agents.slice(0, MAX_FACES)
  const more = agents.length - shown.length
  if (agents.length === 0 && clients.length === 0) return null
  const doing = (agent: CanvasAgent) => {
    const page = pageName(agent.focus?.page ?? null) ?? null
    switch (agent.doing) {
      case 'read':
        return page ? t('board.agent.reading', { page }) : t('board.agent.readingArtifact')
      case 'draw':
        return page ? t('board.agent.drawing', { page }) : t('board.agent.writingArtifact')
      case 'move':
        return page ? t('board.agent.moving', { page }) : t('board.agent.writingArtifact')
      default:
        return page ? t('board.agent.writing', { page }) : t('board.agent.writingArtifact')
    }
  }
  return (
    <span className="ui-agc k-av-faces" role="group" aria-label={t('viewer.using')}>
      {clients.map((client) => {
        const page = pageName(client.page)
        const where = client.kind === 'host' ? t('board.device.host') : client.name
        return (
          <Tooltip key={client.kind === 'host' ? 'host' : client.id}>
            <TooltipTrigger render={<span className="ui-agc__face k-av-faces__you" />}>
              {t('board.device.you').slice(0, 1)}
            </TooltipTrigger>
            <TooltipContent>
              <span className="flex flex-col items-start">
                <span>{`${t('board.device.you')} · ${where}`}</span>
                <span className="opacity-60">
                  {page ? t('board.device.looking', { page }) : t('board.device.here')}
                </span>
              </span>
            </TooltipContent>
          </Tooltip>
        )
      })}
      {shown.map((agent) => (
        <AgentFace
          key={agent.sessionId}
          agent={{
            id: agent.sessionId,
            name: agent.name,
            avatar: <AgentMark agent={agent.agentId} size={14} />,
          }}
          here
          following={following === agent.sessionId}
          doing={doing(agent)}
          label={t(
            following === agent.sessionId ? 'board.agent.stopFollow' : 'board.agent.follow',
            {
              agent: agent.name,
            },
          )}
          onFollow={() => onFollow(following === agent.sessionId ? null : agent.sessionId)}
        />
      ))}
      {more > 0 && <span className="ui-agc__face ui-agc__face-more">{`+${more}`}</span>}
    </span>
  )
}
