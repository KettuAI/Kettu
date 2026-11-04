// Comments on artifacts, as the agent host keeps them: threads on a page or an element, kept with
// the artifact and apart from its versions.

/** The person every comment is from today: the host's owner. */
export const OWNER = 'owner'

export const COMMENT_CHARS = 4_000
/** The threads one artifact holds, and the comments one thread holds. */
export const THREADS_PER_ARTIFACT = 1_000
export const COMMENTS_PER_THREAD = 200

/** `thr_` and a ULID. */
export const THREAD_ID = /^thr_[0-9A-HJKMNP-TV-Z]{26}$/

/** Who wrote a comment: a person, and the session when that person's agent wrote it. */
export interface CommentAuthor {
  person: string
  session: string | null
}

/**
 * Where a thread points: a page, or an element of it by its start tag. Its text and page are what
 * the page reported, data that may be false, only ever shown as plain text.
 */
export interface CommentAnchor {
  /** The version `offset` points into; a later version moves it, or marks it `missing`. */
  version: number
  /** The HTML file the element is in. */
  path: string
  /** The canvas page in reading order from 1 and its name; null for a single page. */
  page: { number: number; name: string | null } | null
  /** The element's start tag in `path`, or null for the page itself or an element a script made. */
  offset: number | null
  tag: string | null
  /** The start of the element's text. */
  text: string
  /** A later version has no element that matches, so the thread stays on its page. */
  missing: boolean
}

export interface ArtifactComment {
  author: CommentAuthor
  createdAt: number
  body: string
}

export interface CommentThread {
  id: string
  anchor: CommentAnchor
  /** The first opens the thread; replies follow, oldest first. */
  comments: ArtifactComment[]
  resolvedAt: number | null
  /** When the user last sent it to a session, and which; a reply of theirs clears both. */
  sentAt: number | null
  sentTo: string | null
}

/** Whether the thread waits for the user to send it: open and not sent since their last word. */
export function isPending(thread: CommentThread): boolean {
  return thread.resolvedAt === null && thread.sentAt === null
}

/** Whether someone other than the person who opened it answered: an agent, today. */
export function isAnswered(thread: CommentThread): boolean {
  return thread.comments.slice(1).some((comment) => comment.author.session !== null)
}
