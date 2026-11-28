// The viewer's tools over whatever kind it shows: comments with their pins, drafts and threads,
// asking an agent about a selection, the properties of a picked element, and the history. The
// content tells them where things are through `ToolContent`; the cards and popovers are the same
// for every kind.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isPending, type CommentAnchor, type CommentThread } from '@shared/artifact-comments'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import type { ArtifactSummary, VersionSummary } from '@shared/artifacts'
import type { CanvasDoc } from '@shared/canvas-doc'
import { emitAppEvent } from '@renderer/app/events'
import { toast } from '@renderer/components/ui/toast'
import { flushDraft, readDraft, writeDraft } from '@renderer/features/session/composer/drafts'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName } from '@renderer/stores/agents'
import {
  openCanvasFrame,
  setViewerState,
  viewerStateOf,
  type ViewerMode,
} from '@renderer/stores/artifact-viewer'
import { setPaneSelection } from '@renderer/stores/artifacts'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { openSessionWithArtifact, showArtifactPage } from '@renderer/stores/view'
import { anchorOf, anchorsOfGroup } from './anchors'
import { AskPop } from './ask-pop'
import {
  anchorChip,
  anchorMessage,
  elementPicture,
  type AskChip,
  type AskMessage,
} from './ask-subject'
import {
  useArtifactHostConnected,
  useArtifactHostName,
  useArtifactRecord,
  whenArtifactHostConnected,
} from './artifact-host'
import { docLayout } from './canvas-model'
import { CommentDraft, DeleteCommentDialog, ThreadPop } from './comment-pop'
import { matchingOpenThread, pinsFor, threadNumbers } from './comment-threads'
import { CommentsCard } from './comments-card'
import { sendThreads, type CommentsArtifact } from './comment-send'
import { EditPanel, type HeldBy } from './edit-panel'
import type { AnchorTrackSpec, ArtifactEditor, EditorState } from './editor'
import { frameHandOff } from './handoff'
import { pointBox, unionRects, type LiveAnchor } from './pop-place'
import { NEW_SESSION, useSendTargets, useTargetName } from './send-targets'
import type { Presence, ShownVersion } from './use-artifact'
import { HistoryCard } from './version-history'
import type { RightContent } from './viewer-shell'
import './viewer-tools.css'

type Box = { left: number; top: number; right: number; bottom: number }

/**
 * How a kind handled revealing a thread chosen in the Comments card: `'inline'` when the content
 * opens the thread itself (such as under a document block or on a slide), a viewport box beside its
 * pin, or `null` to open the thread popover centred in the content area.
 */
export type RevealOutcome = 'inline' | Box | null

/**
 * What a kind's content tells the tools: how to bring a thread's anchor into view. The canvas opens
 * or frames the frame it is in; a page scrolls to it and locates its pin; a document or a deck,
 * which draw their own pins, bring their own place forward when the thread is pinned there.
 */
export interface ToolContent {
  reveal(thread: CommentThread): RevealOutcome | Promise<RevealOutcome>
}

/** What Ask is about: frames of a canvas, one element, or the whole artifact. */
type AskSubject =
  | { kind: 'frames'; ids: string[] }
  | { kind: 'element'; anchor: CommentAnchor; page: number | null; fromIframe?: boolean }
  | { kind: 'whole'; path: string }

/** Resolves the canvas page index for a comment thread's anchor, or null for single-page artifacts. */
function threadPageIndex(
  thread: CommentThread,
  doc: CanvasDoc | null,
  shown: ShownVersion | null,
): number | null {
  if (!shown?.canvas) return null
  if (doc) {
    const page = doc.pages.find((p) => p.file === thread.anchor.path)
    if (!page) return null
    const index = shown.canvas.pages.findIndex((p) => p.id === page.id)
    return index >= 0 ? index : null
  }
  const number = thread.anchor.page?.number
  if (number === undefined) return null
  const index = shown.canvas.pages.findIndex((p) => p.number === number)
  return index >= 0 ? index : null
}

export interface ToolsInput {
  id: string
  title: string
  summary: ArtifactSummary | null
  shown: ShownVersion | null
  head: number | null
  /** The latest version shows and can be changed. */
  latest: boolean
  editable: 'yes' | 'earlier' | 'deleted'
  mode: ViewerMode
  right: 'comments' | 'history' | 'tweaks' | null
  picked: number | null
  editor: ArtifactEditor | null
  editing: EditorState
  threads: CommentThread[] | null
  commentsError: string | null
  versions: VersionSummary[] | null
  versionsError: string | null
  presence: Presence | null
  /** The canvas document shown, and its page on screen. */
  doc: CanvasDoc | null
  page: string | null
  /** The session beside the artifact, in a side panel; null in the main area. */
  beside: { panel: string; projectPath: string } | null
  content: ToolContent
  /** The content area, for a popover's place when nothing on it says where. */
  area: React.RefObject<HTMLDivElement | null>
  root: React.RefObject<HTMLDivElement | null>
}

/** The viewer's tools: the right card they fill, the popovers over the content, and their acts. */
export function useViewerTools(input: ToolsInput) {
  const { t } = useTranslation('artifacts')
  const { id, title, summary, shown, head, latest, editor, editing, threads, versions } = input
  const beside = input.beside
  const offline = !useArtifactHostConnected(id)
  const hostName = useArtifactHostName(id)
  // A comment written while the computer is away stays in its draft and is saved once it is back.
  const waiting = offline
    ? hostName
      ? t('viewer.offline.sendsLater', { host: hostName })
      : t('viewer.offline.sendsLaterLocal')
    : null
  const besideSession = useSessionsStore((s) =>
    beside && s.byId[beside.panel] ? beside.panel : null,
  )
  const project = summary?.project ?? beside?.projectPath ?? ''

  const targets = useSendTargets({
    versions,
    presence: input.presence,
    lastWriter: summary?.sessionId ?? null,
    beside: besideSession,
  })
  const [picked, setPicked] = useState<string | null>(null)
  const target =
    picked && (picked === NEW_SESSION || targets.sessions.some((s) => s.id === picked))
      ? picked
      : (targets.sessions[0]?.id ?? NEW_SESSION)
  const targetName = useTargetName()
  // An older host cannot move a thread's anchor or delete comment threads, so hide unsupported acts.
  const canEditComments = input.editable !== 'deleted'
  const canRepin = useArtifactRecord(id, 'repin') && input.editable === 'yes'
  const canDeleteComment = useArtifactRecord(id, 'deleteComment') && canEditComments

  const [tab, setTab] = useState<'open' | 'resolved'>('open')
  const [selected, setSelected] = useState<string | null>(null)
  /** A thread opened from the Comments card (e.g. missing anchor, View mode, or resolved thread). */
  const [cardThread, setCardThread] = useState<{ id: string; at: Box | null } | null>(null)
  /** An explicit new-thread draft opened from an existing thread on the same element. */
  const [forcedDraft, setForcedDraft] = useState<{
    id: number
    artifactId: string
    anchor: CommentAnchor
    page: number | null
    at: Box | null
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{
    artifactId: string
    thread: CommentThread
    onDeleted?: () => void
  } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const activeForcedDraft = forcedDraft?.artifactId === id ? forcedDraft : null
  const activeDeleteTarget = deleteTarget?.artifactId === id ? deleteTarget : null
  const focusSeq = useRef(0)
  const popSeq = useRef(0)
  const [repinning, setRepinning] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ id: number; at: Box | null; subject: AskSubject } | null>(null)
  const commentsOpen = input.right === 'comments' || input.mode === 'comment'
  const numbers = useMemo(() => threadNumbers(threads ?? []), [threads])
  const closeCardThread = useCallback(() => {
    focusSeq.current += 1
    setCardThread(null)
  }, [])
  useEffect(
    () => () => {
      focusSeq.current += 1
    },
    [],
  )
  // A direct click or marquee selection supersedes a card-opened thread, explicit draft, or prior Ask.
  useEffect(() => {
    if (!editor) return
    return editor.subscribe(() => {
      const state = editor.get()
      if (state.pin || state.picked || state.pickedGroup) {
        closeCardThread()
        setForcedDraft(null)
      }
      if (state.pickedGroup) setAsk(null)
    })
  }, [editor, closeCardThread])
  // A click in Comment pins a draft there, or reuses an existing open thread on the same element.
  const draftPick = editing.mode === 'comment' ? editing.picked : null
  const draftAnchor = draftPick && !repinning && shown && latest ? anchorOf(draftPick, shown) : null
  const matchedPickThread = draftAnchor
    ? matchingOpenThread(threads ?? [], draftAnchor, selected)
    : null
  const activeCardThread = commentsOpen && !editing.pin && !matchedPickThread ? cardThread : null
  const openThread = repinning
    ? null
    : editing.pin
      ? ((threads ?? []).find((th) => numbers.get(th.id) === editing.pin!.n) ?? null)
      : matchedPickThread
        ? matchedPickThread
        : activeCardThread
          ? ((threads ?? []).find((th) => th.id === activeCardThread.id) ?? null)
          : null
  const openThreadNumber = editing.pin
    ? editing.pin.n
    : openThread
      ? (numbers.get(openThread.id) ?? 0)
      : 0
  const openThreadAt = editing.pin
    ? (editing.pin.box ?? (editing.pin.point ? pointBox(editing.pin.point) : null))
    : matchedPickThread
      ? (draftPick?.box ?? (draftPick?.point ? pointBox(draftPick.point) : null))
      : (activeCardThread?.at ?? null)
  const openThreadPage = editing.pin
    ? editing.pin.page
    : matchedPickThread
      ? (draftPick?.page ?? null)
      : openThread
        ? threadPageIndex(openThread, input.doc, shown)
        : null

  // Pins show while the comments do: the open ones, or the resolved ones in their tab.
  useEffect(() => {
    if (!editor || !shown) return
    editor.setPins(
      latest && commentsOpen
        ? pinsFor(threads, shown, {
            resolved: tab === 'resolved',
            active: openThread?.id ?? selected,
          })
        : () => [],
    )
  }, [editor, shown, threads, latest, commentsOpen, tab, selected, openThread?.id])

  const summaryProject = summary?.project ?? null
  const summaryVersion = summary?.version ?? null
  const artifactInfo = useMemo<CommentsArtifact | null>(
    () =>
      summaryProject !== null && summaryVersion !== null
        ? { id, title, version: head ?? summaryVersion, project: summaryProject }
        : null,
    [id, title, head, summaryVersion, summaryProject],
  )

  // Marquee multi-selection in Edit mode opens AskPop automatically when not beside a session.
  const marqueeGroup =
    !beside &&
    input.mode === 'edit' &&
    editing.mode === 'select' &&
    editing.pickedGroup &&
    editing.pickedGroup.selections.length > 0 &&
    shown &&
    artifactInfo
      ? editing.pickedGroup
      : null
  const marqueeAnchors = useMemo(
    () => (marqueeGroup && shown ? anchorsOfGroup(marqueeGroup, shown) : []),
    [marqueeGroup, shown],
  )

  // Track the anchored element(s) inside their iframe whenever an iframe-backed popover is open.
  let activeAnchorSpec: AnchorTrackSpec | null = null
  if (ask && artifactInfo) {
    if (ask.subject.kind === 'element' && ask.subject.fromIframe) {
      activeAnchorSpec = {
        page: ask.subject.page,
        target: ask.subject.anchor.offset !== null ? ask.subject.anchor.offset : 'picked',
      }
    }
  } else if (marqueeGroup) {
    activeAnchorSpec = { page: marqueeGroup.page, target: 'picked' }
  } else if (activeForcedDraft && shown && latest) {
    if (!activeForcedDraft.anchor.missing && activeForcedDraft.anchor.offset !== null) {
      activeAnchorSpec = { page: activeForcedDraft.page, target: activeForcedDraft.anchor.offset }
    }
  } else if (openThread) {
    if (!openThread.anchor.missing && openThread.anchor.offset !== null && !summary?.type) {
      activeAnchorSpec = { page: openThreadPage, target: openThread.anchor.offset }
    }
  } else if (draftPick && draftAnchor && !repinning && editor && shown && latest) {
    activeAnchorSpec = { page: draftPick.page, target: 'picked' }
  }

  const anchorPage = activeAnchorSpec?.page ?? null
  const anchorTarget = activeAnchorSpec?.target ?? null
  useEffect(() => {
    if (!editor) return
    if (anchorTarget === null) {
      editor.trackAnchor(null)
      return
    }
    editor.trackAnchor({ page: anchorPage, target: anchorTarget }, input.area.current)
    return () => editor.trackAnchor(null)
  }, [editor, anchorPage, anchorTarget, input.area])

  const liveAnchor = useMemo<LiveAnchor | null>(
    () =>
      editor && anchorTarget !== null
        ? {
            get: () => editor.getAnchor(),
            subscribe: (listener) => editor.subscribeAnchor(listener),
            onHostLayout: () => editor.recomputeAnchor(),
          }
        : null,
    [editor, anchorTarget],
  )
  const returnToAnchor = useCallback(() => {
    editor?.scrollToAnchor()
  }, [editor])

  useEffect(() => {
    if (!repinning || !shown || !editor) return
    return editor.subscribe(() => {
      const state = editor.get()
      if (state.mode !== 'comment') return
      let anchor: CommentAnchor
      if (state.picked) {
        anchor = anchorOf(state.picked, shown)
        editor.clearPick()
      } else if (state.pin) {
        const hit = (threads ?? []).find((th) => numbers.get(th.id) === state.pin!.n)
        editor.clearPin()
        if (!hit || hit.anchor.missing || (hit.anchor.offset === null && hit.anchor.tag === null)) {
          return
        }
        anchor = { ...hit.anchor, version: shown.version, missing: false }
      } else {
        return
      }
      setRepinning(null)
      host('artifacts.repin', {
        id,
        threadId: repinning,
        anchor,
      }).catch((reason: unknown) =>
        toast(t('comments.repinFailed', { error: errorMessage(reason) }), undefined, {
          tone: 'warning',
        }),
      )
    })
  }, [repinning, shown, editor, id, t, threads, numbers])

  const sendPending = useCallback(() => {
    const pending = (threads ?? []).filter(isPending)
    if (!artifactInfo || pending.length === 0) return
    sendThreads(artifactInfo, pending, target).catch((reason: unknown) =>
      toast(t('comments.sendFailed', { error: errorMessage(reason) }), undefined, {
        tone: 'warning',
      }),
    )
  }, [threads, artifactInfo, target, t])

  /** Leaving Comment with comments not sent says so, with Send. */
  const leftComment = useCallback(
    (next: ViewerMode) => {
      if (input.mode !== 'comment' || next === 'comment') return
      setRepinning(null)
      setForcedDraft(null)
      closeCardThread()
      const count = (threads ?? []).filter(isPending).length
      if (count === 0) return
      toast(
        t('comments.leftUnsent', { count, session: targetName(targets, target) }),
        { label: t('comments.send'), onClick: sendPending },
        { tone: 'info' },
      )
    },
    [input.mode, threads, t, targetName, targets, target, sendPending, closeCardThread],
  )

  const focusThread = (thread: CommentThread) => {
    const seq = ++focusSeq.current
    setSelected(thread.id)
    setAsk(null)
    setRepinning(null)
    setForcedDraft(null)
    editor?.clearPick()
    editor?.clearPin()
    const outcome = input.content.reveal(thread)
    const apply = (result: RevealOutcome) => {
      if (focusSeq.current !== seq) return
      setCardThread(result === 'inline' ? null : { id: thread.id, at: result })
    }
    if (outcome && typeof outcome === 'object' && 'then' in outcome) {
      void outcome.then(apply, () => apply(null))
    } else {
      apply(outcome)
    }
  }

  const requestDelete = (thread: CommentThread, onDeleted?: () => void) => {
    if (!canDeleteComment) return
    setDeleteError(null)
    setDeleteTarget({ artifactId: id, thread, onDeleted })
  }

  const confirmDelete = () => {
    if (!activeDeleteTarget || deleting) return
    const { thread, onDeleted } = activeDeleteTarget
    setDeleting(true)
    setDeleteError(null)
    host('artifacts.deleteComment', { id, threadId: thread.id })
      .then(
        () => {
          setDeleteTarget(null)
          if (selected === thread.id) setSelected(null)
          if (repinning === thread.id) setRepinning(null)
          if (cardThread?.id === thread.id) closeCardThread()
          if (openThread?.id === thread.id) {
            editor?.clearPin()
            editor?.clearPick()
            closeCardThread()
          } else if (openThread && editing.pin) {
            // Deleting an earlier thread shifts pin numbers, so anchor the open popover by id.
            setCardThread({ id: openThread.id, at: openThreadAt })
            editor?.clearPin()
          }
          onDeleted?.()
        },
        (reason: unknown) => setDeleteError(errorMessage(reason)),
      )
      .finally(() => setDeleting(false))
  }

  const resolveFromCard = (thread: CommentThread, nextResolved: boolean) => {
    if (!canEditComments) return
    host('artifacts.resolve', { id, threadId: thread.id, resolved: nextResolved })
      .then(() => {
        if (nextResolved && openThread?.id === thread.id) {
          editor?.clearPin()
          editor?.clearPick()
          closeCardThread()
        } else if (!nextResolved) {
          setTab('open')
        }
      })
      .catch((reason: unknown) =>
        toast(t('comments.resolveFailed', { error: errorMessage(reason) }), undefined, {
          tone: 'warning',
        }),
      )
  }

  // Beside a session there is no popover: what is selected rides above its composer.
  const toComposer = (anchor: CommentAnchor, others: CommentAnchor[] = []) => {
    if (!beside) return
    setPaneSelection({ projectPath: beside.projectPath, artifactId: id, title, anchor, others })
    emitAppEvent({ kind: 'focus-composer' })
  }

  const frameAnchor = (frameId: string): CommentAnchor | null => {
    const page = shown?.canvas?.pages.find((p) => p.id === frameId)
    if (!page || !shown) return null
    return {
      version: shown.version,
      path: page.file ?? ARTIFACT_ENTRY,
      page: { number: page.number, name: page.name },
      offset: null,
      tag: null,
      text: '',
      missing: false,
    }
  }

  /** Ask about canvas frames, from the bar over them. */
  const askFrames = (ids: string[]) => {
    if (ids.length === 0) return
    if (beside) {
      const anchors = ids.map(frameAnchor).filter((a): a is CommentAnchor => a !== null)
      if (anchors[0]) toComposer(anchors[0], anchors.slice(1))
      return
    }
    const boxes = [...(input.root.current?.querySelectorAll('.k-ce-sel') ?? [])].map((el) =>
      el.getBoundingClientRect(),
    )
    const at = unionRects(boxes)
    setAsk({ id: ++popSeq.current, at, subject: { kind: 'frames', ids } })
  }

  /** Ask about the element picked in Edit. */
  const askElement = () => {
    if (!editing.picked || !shown) return
    const anchor = anchorOf(editing.picked, shown)
    if (beside) return toComposer(anchor)
    const at =
      editor?.getAnchor()?.box ??
      editing.picked.box ??
      (editing.picked.point ? pointBox(editing.picked.point) : null)
    setAsk({
      id: ++popSeq.current,
      at,
      subject: { kind: 'element', anchor, page: editing.picked.page, fromIframe: true },
    })
  }

  /** Ask about the whole artifact, from a sheet's or a deck's dock; a document names its text file. */
  const askWhole = (path: string = ARTIFACT_ENTRY) => {
    if (!shown) return
    const anchor: CommentAnchor = {
      version: shown.version,
      path,
      page: null,
      offset: null,
      tag: null,
      text: '',
      missing: false,
    }
    if (beside) return toComposer(anchor)
    setAsk({ id: ++popSeq.current, at: null, subject: { kind: 'whole', path } })
  }

  /** Ask about an anchor a kind found itself, such as words selected in a document, beside `at`. */
  const askAnchor = (anchor: CommentAnchor | null, at: Box | null, wholePath?: string) => {
    if (!anchor) return askWhole(wholePath)
    if (beside) return toComposer(anchor)
    setAsk({ id: ++popSeq.current, at, subject: { kind: 'element', anchor, page: null } })
  }

  /** A saved comment shows in the card, on its tab, picked. */
  const saveComment = async (anchor: CommentAnchor, body: string) => {
    await whenArtifactHostConnected(id)
    const thread = await host('artifacts.comment', { id, anchor, body })
    setViewerState(id, { right: 'comments' })
    setSelected(thread.id)
    setTab('open')
  }

  /** What a document, which lays out its own pins, opens under a block: a draft or a thread. */
  const docDraft = (anchor: CommentAnchor, close: () => void) => (
    <CommentDraft
      anchor={anchor}
      at={null}
      waiting={waiting}
      inline
      onCancel={close}
      onSave={async (body) => {
        await saveComment(anchor, body)
        close()
      }}
    />
  )
  const docThread = (
    thread: CommentThread,
    n: number,
    close: () => void,
    onNewThread?: (() => void) | null,
  ) => (
    <ThreadPop
      key={thread.id}
      artifactId={id}
      thread={thread}
      n={n}
      versions={versions}
      at={null}
      inline
      canResolve={canEditComments}
      onClose={close}
      onRepin={null}
      onReopened={() => setTab('open')}
      onDelete={canDeleteComment ? () => requestDelete(thread, close) : null}
      onNewThread={
        latest && input.editable === 'yes' && thread.resolvedAt === null && !thread.anchor.missing
          ? (onNewThread ?? null)
          : null
      }
    />
  )

  /** Comment on the element picked in Edit: in Comment the pick opens a draft where it is. */
  const commentElement = () => setViewerState(id, { mode: 'comment', right: 'comments' })

  const askChips: AskChip[] =
    ask?.subject.kind === 'frames'
      ? ask.subject.ids.map((frameId) => ({
          key: frameId,
          label: shown?.canvas?.pages.find((p) => p.id === frameId)?.name ?? frameId,
        }))
      : ask?.subject.kind === 'element'
        ? [anchorChip(ask.subject.anchor)]
        : [{ key: 'whole', label: title }]

  const askMessage = (): AskMessage => {
    const subject = ask!.subject
    const version = shown?.version ?? head ?? 1
    if (subject.kind === 'frames' && input.doc) {
      const first = input.doc.pages.find((p) => p.id === subject.ids[0])
      const layout = docLayout(input.doc, first?.canvas ?? input.doc.canvases[0]!.id)
      return (words) =>
        frameHandOff({ artifact: { id, title, version }, layout, ids: subject.ids, ask: words })
    }
    const anchor = subject.kind === 'element' ? subject.anchor : null
    const page =
      subject.kind === 'element' && subject.page !== null
        ? (shown?.canvas?.pages[subject.page] ?? null)
        : null
    const rect = input.area.current?.getBoundingClientRect()
    return anchorMessage(
      {
        artifactId: id,
        title,
        anchor: anchor ?? {
          version,
          path: subject.kind === 'whole' ? subject.path : ARTIFACT_ENTRY,
          page: null,
          offset: null,
          tag: null,
          text: '',
          missing: false,
        },
      },
      async () => {
        // A document and a deck are drawn by their own viewer, which a picture does not show.
        if (summary?.type) return null
        const box = anchor && editor ? await editor.locatePicked() : null
        return elementPicture({
          artifactId: id,
          version,
          file: page?.file ?? null,
          width: page?.width ?? rect?.width ?? 1280,
          height: page?.height ?? rect?.height ?? 800,
          box,
        })
      },
    )
  }

  const openSession = (sessionId: string) => {
    const session = useSessionsStore.getState().byId[sessionId]
    if (session) openSessionWithArtifact(session.id, session.projectPath, id)
    setAsk(null)
    if (marqueeGroup) editor?.clearPick()
  }

  const attachSession =
    target !== NEW_SESSION ? (targets.sessions.find((s) => s.id === target) ?? null) : null

  const attachAnchorsToComposer = (anchors: CommentAnchor[], draftText: string) => {
    if (!attachSession || anchors.length === 0) return
    setPaneSelection({
      projectPath: attachSession.projectPath,
      artifactId: id,
      title,
      anchor: anchors[0]!,
      others: anchors.slice(1),
    })
    if (draftText.trim()) {
      const existing = readDraft(attachSession.id)
      writeDraft(attachSession.id, existing.trim() ? `${existing}\n\n${draftText}` : draftText)
      flushDraft(attachSession.id)
      emitAppEvent({ kind: 'draft-written', draft: attachSession.id })
    }
    setAsk(null)
    openSessionWithArtifact(attachSession.id, attachSession.projectPath, id)
    requestAnimationFrame(() => emitAppEvent({ kind: 'focus-composer' }))
  }

  const marqueeMessage = (): AskMessage => {
    const group = marqueeGroup!
    const version = shown?.version ?? head ?? 1
    const page = group.page !== null ? (shown?.canvas?.pages[group.page] ?? null) : null
    const rect = input.area.current?.getBoundingClientRect()
    return anchorMessage(
      {
        artifactId: id,
        title,
        anchor: marqueeAnchors[0]!,
        others: marqueeAnchors.slice(1),
      },
      async () => {
        if (summary?.type) return null
        const boxes = editor ? await editor.locatePickedGroup() : []
        return elementPicture({
          artifactId: id,
          version,
          file: page?.file ?? null,
          width: page?.width ?? rect?.width ?? 1280,
          height: page?.height ?? rect?.height ?? 800,
          boxes,
        })
      },
    )
  }

  // Who holds the picked element: an agent whose running turn wrote its frame or the artifact.
  const heldBy = useHeldBy(input, editing)
  const askLabel = t('edit.askAbout', {
    agent: targets.sessions[0] ? agentName(targets.sessions[0].agentId) : t('ask.agent'),
  })

  // The right card for the tools that have one.
  let right: RightContent | null = null
  const close = () => {
    closeCardThread()
    setForcedDraft(null)
    editor?.clearPin()
    editor?.clearPick()
    setViewerState(id, (s) => ({ right: null, version: s.right === 'history' ? null : s.version }))
  }
  const propsShown =
    input.mode === 'edit' &&
    editing.mode === 'select' &&
    !!editing.picked &&
    !editing.pickedGroup &&
    !!editor &&
    !!head
  if (propsShown && editor && shown && editing.picked) {
    right = {
      key: `props:${editing.picked.page}:${editing.picked.selection.path}:${editing.picked.selection.src}`,
      body: (
        <EditPanel
          id={id}
          version={shown.version}
          editable={input.editable}
          picked={editing.picked}
          editor={editor}
          heldBy={heldBy}
          askLabel={askLabel}
          onAsk={askElement}
          onComment={commentElement}
          onOpenSession={openSession}
        />
      ),
      onClose: () => editor.clearPick(),
    }
  } else if (input.right === 'history') {
    right = {
      key: 'history',
      body: (
        <HistoryCard
          id={id}
          versions={versions}
          error={input.versionsError}
          shown={input.picked}
          head={head}
        />
      ),
      onClose: close,
    }
  } else if (input.right === 'comments' && artifactInfo) {
    right = {
      key: 'comments',
      body: (
        <CommentsCard
          artifact={artifactInfo}
          threads={threads}
          error={input.commentsError}
          versions={versions}
          targets={targets}
          target={target}
          onTarget={setPicked}
          selected={openThread?.id ?? selected}
          tab={tab}
          onTab={setTab}
          pageFiles={
            input.doc
              ? new Set(
                  input.doc.pages
                    .filter((p) => p.canvas === (input.page ?? input.doc!.canvases[0]?.id))
                    .map((p) => p.file),
                )
              : null
          }
          onFocus={focusThread}
          canResolve={canEditComments}
          onResolve={resolveFromCard}
          onDelete={canDeleteComment ? (thread) => requestDelete(thread) : null}
          hint={
            input.mode === 'comment'
              ? t(input.doc ? 'comments.hintCanvas' : 'comments.hintPage')
              : t('comments.hintOff')
          }
          emptyText={
            input.mode === 'comment'
              ? t(input.doc ? 'comments.emptyTextOn' : 'comments.emptyTextPageOn')
              : t(input.doc ? 'comments.emptyText' : 'comments.emptyTextPage')
          }
        />
      ),
      onClose: close,
    }
  }

  // The popovers over the content.
  let popover: React.ReactNode = null
  if (ask && artifactInfo) {
    popover = (
      <AskPop
        key={`ask:${ask.id}`}
        at={ask.at}
        liveAnchor={liveAnchor}
        onReturnToAnchor={liveAnchor ? returnToAnchor : null}
        chips={askChips}
        onRemoveChip={
          ask.subject.kind === 'frames'
            ? (key) =>
                setAsk((was) =>
                  was && was.subject.kind === 'frames'
                    ? {
                        ...was,
                        subject: { kind: 'frames', ids: was.subject.ids.filter((x) => x !== key) },
                      }
                    : was,
                )
            : null
        }
        targets={targets}
        target={target}
        onTarget={setPicked}
        project={project}
        message={askMessage()}
        onOpenSession={openSession}
        onClose={() => setAsk(null)}
      />
    )
  } else if (marqueeGroup && marqueeAnchors.length > 0 && artifactInfo) {
    const marqueeChips = marqueeAnchors.map((anchor, index) => anchorChip(anchor, index))
    const multi = marqueeAnchors.length > 1
    popover = (
      <AskPop
        key={`marquee:${marqueeGroup.id}`}
        at={marqueeGroup.box}
        liveAnchor={liveAnchor}
        onReturnToAnchor={liveAnchor ? returnToAnchor : null}
        offscreenNote={multi ? t('ask.selectionOffscreen') : undefined}
        backLabel={multi ? t('ask.backToSelection') : undefined}
        selectionCount={marqueeAnchors.length}
        chips={marqueeChips}
        onRemoveChip={(key) => {
          const index = marqueeChips.findIndex((chip) => chip.key === key)
          if (index >= 0) editor?.removeFromPickedGroup(index)
        }}
        onAttachToComposer={
          attachSession ? (draftText) => attachAnchorsToComposer(marqueeAnchors, draftText) : null
        }
        targets={targets}
        target={target}
        onTarget={setPicked}
        project={project}
        message={marqueeMessage()}
        onOpenSession={openSession}
        onClose={() => editor?.clearPick()}
      />
    )
  } else if (activeForcedDraft && shown && latest) {
    popover = (
      <CommentDraft
        key={`new:${activeForcedDraft.id}`}
        anchor={activeForcedDraft.anchor}
        at={activeForcedDraft.at}
        liveAnchor={liveAnchor}
        onReturnToAnchor={liveAnchor ? returnToAnchor : null}
        waiting={waiting}
        onCancel={() => setForcedDraft(null)}
        onSave={async (body) => {
          await saveComment(activeForcedDraft.anchor, body)
          setForcedDraft(null)
        }}
      />
    )
  } else if (openThread) {
    const canStartNewHere =
      latest &&
      input.editable === 'yes' &&
      openThread.resolvedAt === null &&
      !openThread.anchor.missing
    popover = (
      <ThreadPop
        key={openThread.id}
        artifactId={id}
        thread={openThread}
        n={openThreadNumber}
        versions={versions}
        at={openThreadAt}
        liveAnchor={liveAnchor}
        onReturnToAnchor={liveAnchor ? returnToAnchor : null}
        canResolve={canEditComments}
        onClose={() => {
          editor?.clearPin()
          editor?.clearPick()
          closeCardThread()
        }}
        onReopened={() => setTab('open')}
        onDelete={canDeleteComment ? () => requestDelete(openThread) : null}
        onNewThread={
          canStartNewHere && shown
            ? () => {
                const anchor = draftAnchor ?? {
                  ...openThread.anchor,
                  version: shown.version,
                  missing: false,
                }
                const at = editor?.getAnchor()?.box ?? openThreadAt
                const page = openThreadPage
                editor?.clearPin()
                editor?.clearPick()
                closeCardThread()
                setForcedDraft({ id: ++popSeq.current, artifactId: id, anchor, page, at })
              }
            : null
        }
        onRepin={
          canRepin && editor && !summary?.type && openThread.anchor.missing
            ? () => {
                setRepinning(openThread.id)
                closeCardThread()
                editor.clearPin()
                editor.clearPick()
                if (input.mode !== 'comment') {
                  setViewerState(id, { mode: 'comment', right: 'comments' })
                }
                toast(t('comments.repinHint'), undefined, { tone: 'info' })
              }
            : null
        }
      />
    )
  } else if (draftPick && draftAnchor && !repinning && editor && shown && latest) {
    popover = (
      <CommentDraft
        key={`${draftPick.page}:${draftPick.selection.src}:${draftPick.point?.x},${draftPick.point?.y}`}
        anchor={draftAnchor}
        at={draftPick.box ?? (draftPick.point ? pointBox(draftPick.point) : null)}
        liveAnchor={liveAnchor}
        onReturnToAnchor={liveAnchor ? returnToAnchor : null}
        waiting={waiting}
        onCancel={() => editor.clearPick()}
        onSave={async (body) => {
          await saveComment(draftAnchor, body)
          editor.clearPick()
        }}
      />
    )
  }

  const overlay: React.ReactNode =
    popover || activeDeleteTarget ? (
      <>
        {popover}
        <DeleteCommentDialog
          thread={activeDeleteTarget?.thread ?? null}
          busy={deleting}
          error={deleteError}
          onCancel={() => {
            setDeleteTarget(null)
            setDeleteError(null)
          }}
          onConfirm={confirmDelete}
        />
      </>
    ) : null

  /** Esc closes a popover first. */
  const escape = (): boolean => {
    if (activeDeleteTarget) return true
    if (ask) {
      setAsk(null)
      return true
    }
    if (repinning) {
      setRepinning(null)
      return true
    }
    if (activeForcedDraft) {
      setForcedDraft(null)
      return true
    }
    if (activeCardThread) {
      closeCardThread()
      return true
    }
    return false
  }

  return {
    right,
    overlay,
    askFrames,
    askWhole,
    askAnchor,
    docDraft,
    docThread,
    leftComment,
    escape,
  }
}

/** The agent whose running turn wrote what the picked element is in, which it holds until then. */
function useHeldBy(input: ToolsInput, editing: EditorState): HeldBy | null {
  const sessions = input.presence?.sessions ?? []
  const pick = editing.picked
  const type = input.summary?.type ?? null
  let piece: HeldBy['piece'] = 'page'
  const holder = pick
    ? sessions.find((s) =>
        (s.held ?? []).some((held) => {
          if (held.kind === 'whole') return true
          if (held.kind === 'frame' && held.file === pick.selection.path) {
            piece = 'frame'
            return true
          }
          // A section or a slide: the document's or the deck's viewer knows which; the card
          // holds every element of a typed artifact while its turn writes any of it.
          if ((held.kind === 'section' || held.kind === 'slide') && !!type) {
            piece = held.kind
            return true
          }
          return false
        }),
      )
    : undefined
  const session = useSessionsStore((s) => (holder ? (s.byId[holder.sessionId] ?? null) : null))
  if (!holder) return null
  return {
    sessionId: holder.sessionId,
    piece,
    agent: session
      ? {
          name: agentName(session.agentId, hostOfSession(session)),
          id: session.agentId,
          hostId: hostOfSession(session),
        }
      : null,
  }
}

/**
 * How a canvas brings an anchor into view: an element opens its frame at reading size and scrolls
 * to it; a frame's own comment frames the frame on its page.
 */
export function canvasContent(input: {
  id: string
  doc: CanvasDoc | null
  shown: ShownVersion | null
  panel: string
  editor: ArtifactEditor | null
  focusLegacy: (index: number) => void
}): ToolContent {
  return {
    reveal: (thread) => {
      const { anchor } = thread
      const { doc, shown } = input
      if (doc && shown) {
        const page = doc.pages.find((p) => p.file === anchor.path)
        if (!page) return null
        if (anchor.offset !== null && !anchor.missing) {
          const index = shown.canvas?.pages.findIndex((p) => p.id === page.id) ?? -1
          const alreadyOpen = viewerStateOf(input.id).opened === page.id
          openCanvasFrame(input.id, page.canvas, page.id)
          if (index >= 0) {
            if (alreadyOpen && input.editor) return input.editor.revealPin(index, anchor.offset)
            const src = anchor.offset
            setTimeout(() => input.editor?.reveal(index, src), 400)
          }
        } else {
          setViewerState(input.id, { page: page.canvas, opened: null, selection: [page.id] })
          showArtifactPage(input.panel, input.id, page.id)
        }
        return null
      }
      const number = anchor.page?.number
      const index = shown?.canvas?.pages.findIndex((p) => p.number === number) ?? -1
      if (index >= 0) {
        input.focusLegacy(index)
        if (anchor.offset !== null && !anchor.missing && input.editor) {
          return input.editor.revealPin(index, anchor.offset)
        }
        return null
      }
      if (anchor.offset !== null && !anchor.missing && input.editor) {
        return input.editor.revealPin(null, anchor.offset)
      }
      return null
    },
  }
}
