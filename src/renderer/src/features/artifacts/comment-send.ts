// Sending comment threads to a session.

import type { CommentThread } from '@shared/artifact-comments'
import { host } from '@renderer/lib/host'
import { commentsPrompt } from './anchors'
import { sendToSession } from './send-targets'

export interface CommentsArtifact {
  id: string
  title: string
  version: number
  project: string
}

/**
 * Sends the threads to a session as one user message and marks them sent; a new session gets the
 * message drafted, and they stay unsent until it is sent from there.
 */
export async function sendThreads(
  artifact: CommentsArtifact,
  threads: readonly CommentThread[],
  target: string,
): Promise<'sent' | 'drafted'> {
  const how = await sendToSession(artifact.project, target, commentsPrompt(artifact, threads))
  if (how === 'sent') {
    await host('artifacts.markSent', {
      id: artifact.id,
      threadIds: threads.map((thread) => thread.id),
      sessionId: target,
    })
  }
  return how
}
