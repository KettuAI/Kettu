// Export conversation…: reads the thread from its host a page at a time, as the thread reads older
// pages, writes it as Markdown and saves it, through the save dialog or as a browser download.

import type { SessionSummary } from '@shared/agent-host'
import { exportWith } from '@renderer/features/artifacts/menu-entries'
import { fullTime } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'
import { hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import {
  conversationMarkdown,
  exportItems,
  modelName,
  type ExportContext,
  type ExportItem,
} from './conversation-markdown'
import { toolLabel } from './entries/helpers'

function agentName(summary: SessionSummary): string {
  const agent = agentsOn(useAgentsStore.getState(), hostOfSession(summary)).byId[summary.agentId]
  if (!agent) return summary.agentId
  const harness = agent.harnessName ?? agent.name
  return agent.name !== harness
    ? i18n.t('sidebar:row.agentOf', { harness, agent: agent.name })
    : harness
}

function exportContext(summary: SessionSummary): ExportContext {
  const t = i18n.t
  const projectPath = hostPath(summary.projectPath)
  return {
    toolLabel: (entry) => toolLabel(entry, projectPath, true),
    sessionTitle: (id) => {
      const found = useSessionsStore.getState().byId[id]
      return found ? sessionTitle(found) : null
    },
    words: {
      you: t('sidebar:export.you'),
      kettu: t('sidebar:export.fromKettu'),
      from: (title) => t('sidebar:export.from', { title }),
      fromParent: t('sidebar:export.fromParent'),
      attachments: t('sidebar:export.attachments'),
      image: (number) => t('sidebar:export.image', { number }),
      audio: t('sidebar:export.audio'),
      video: t('sidebar:export.video'),
      subagent: t('sidebar:export.subagent'),
      startedSession: (title) =>
        title
          ? t('sidebar:export.startedSession', { title })
          : t('sidebar:export.startedSessionMissing'),
      failed: t('session:status.failed'),
      cancelled: t('session:status.cancelled'),
      separator: t('session:summary.separator'),
    },
  }
}

async function conversationOf(summary: SessionSummary, title: string): Promise<string> {
  const sessionId = summary.id
  const context = exportContext(summary)
  const snapshot = await host('sessions.snapshot', { sessionId })
  // Newest first; each page is turned into text as it arrives, so its entries are not kept.
  const pages: ExportItem[][] = [exportItems(snapshot.entries, context)]
  let older = snapshot.older
  while (older !== null) {
    const page = await host('sessions.page', { sessionId, before: older })
    pages.push(exportItems(page.entries, context))
    older = page.older
  }
  const agent = agentName(summary)
  const model = modelName(snapshot.session)
  const facts = [
    i18n.t('sidebar:export.agent', { name: agent }),
    ...(model ? [i18n.t('sidebar:export.model', { name: model })] : []),
    ...(summary.scratch
      ? []
      : [i18n.t('sidebar:export.project', { path: hostPath(summary.projectPath) })]),
    i18n.t('sidebar:export.started', { date: fullTime(summary.createdAt) }),
    i18n.t('sidebar:export.exportedAt', { date: fullTime(Date.now()) }),
  ]
  return conversationMarkdown({ title, facts, agent }, pages.reverse().flat())
}

/** Saves the session's conversation as a Markdown file, with a toast that says how it went. */
export function exportConversation(summary: SessionSummary): void {
  const title = sessionTitle(summary)
  exportWith(
    title,
    async () =>
      window.kettu.dialogs.exportConversation(title, await conversationOf(summary, title)),
    {
      exporting: i18n.t('sidebar:export.exporting', { title }),
      exported: i18n.t('sidebar:export.exported', { title }),
      failed: (error) => i18n.t('sidebar:export.failed', { title, error }),
    },
  )
}
