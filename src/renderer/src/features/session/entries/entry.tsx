import { memo } from 'react'
import { useThreadsStore } from '@renderer/stores/threads'
import {
  AgentEntry,
  CompactionEntry,
  GitEventEntry,
  NoticeEntry,
  PlanEntry,
  SessionMessageEntry,
  ThoughtEntry,
  TurnEndEntry,
  UserEntry,
} from './basic'
import { ArtifactEntry } from './artifact-entry'
import { SubagentCard } from './subagent-card'
import { ToolCard } from './tool-card'

/** One thread entry, by its kind. */
export const Entry = memo(function Entry({
  sessionId,
  entryId,
  projectPath,
  agentName,
}: {
  sessionId: string
  entryId: string
  projectPath: string
  agentName: string
}) {
  const kind = useThreadsStore((s) => s.replicas[sessionId]?.state?.byId[entryId]?.kind)
  const props = { sessionId, entryId }
  switch (kind) {
    case 'user':
      return <UserEntry {...props} />
    case 'agent':
      return <AgentEntry {...props} />
    case 'thought':
      return <ThoughtEntry {...props} />
    case 'tool':
      return <ToolCard {...props} projectPath={projectPath} agentName={agentName} />
    case 'subagent':
      return <SubagentCard {...props} projectPath={projectPath} />
    case 'session_message':
      return <SessionMessageEntry {...props} />
    case 'plan':
      return <PlanEntry {...props} />
    case 'notice':
      return <NoticeEntry {...props} />
    case 'compaction':
      return <CompactionEntry {...props} />
    case 'turn_end':
      return <TurnEndEntry {...props} />
    case 'git':
      return <GitEventEntry {...props} />
    case 'artifact':
      return <ArtifactEntry {...props} projectPath={projectPath} />
    default:
      return null
  }
})
