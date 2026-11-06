import { memo } from 'react'
import { useThreadsStore } from '@renderer/stores/threads'
import {
  AgentEntry,
  CompactionEntry,
  GitEventEntry,
  NoticeEntry,
  SessionMessageEntry,
  ThoughtEntry,
  TurnEndEntry,
  UserEntry,
} from './basic'
import { ArtifactEntry } from './artifact-entry'
import { BrowserOriginEntry } from './browser-origin-entry'
import { DeviceAccessEntry } from './device-access-entry'
import { ComputerAppEntry } from './computer-app-entry'
import { SessionStartedEntry } from './session-started-entry'
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
      return <SubagentCard {...props} />
    case 'session_started':
      return <SessionStartedEntry {...props} />
    case 'session_message':
      return <SessionMessageEntry {...props} />
    case 'plan':
      return null
    case 'notice':
      return <NoticeEntry {...props} />
    case 'compaction':
      return <CompactionEntry {...props} />
    case 'turn_end':
      return <TurnEndEntry {...props} />
    case 'git':
      return <GitEventEntry {...props} />
    case 'artifact':
      return <ArtifactEntry {...props} />
    case 'browser_origin':
      return <BrowserOriginEntry {...props} agentName={agentName} />
    case 'device_access':
      return <DeviceAccessEntry {...props} agentName={agentName} />
    case 'computer_app':
      return <ComputerAppEntry {...props} agentName={agentName} />
    default:
      return null
  }
})
