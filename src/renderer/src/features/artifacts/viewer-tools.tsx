// The viewer's tools over whatever kind it shows: comments with their pins, drafts and threads,
// asking an agent about a selection, the properties of a picked element, and the history. The
// content tells them where things are through `ToolContent`; the cards and popovers are the same
// for every kind.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isPending, type CommentAnchor, type CommentThread } from '@shared/artifact-comments'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import type { ArtifactSummary, VersionSummary } from '@shared/artifacts'
import type { CanvasDoc } from '@shared/canvas-doc'
import { emitAppEvent } from '@renderer/app/events'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { agentName } from '@renderer/stores/agents'
import { openCanvasFrame, setViewerState, type ViewerMode } from '@renderer/stores/artifact-viewer'
import { setPaneSelection } from '@renderer/stores/artifacts'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { openSessionWithArtifact, showArtifactPage } from '@renderer/stores/view'
import { anchorOf } from './anchors'
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
import { CommentDraft, ThreadPop } from './comment-pop'
import { pinsFor, threadNumbers } from './comment-threads'
import { CommentsCard } from './comments-card'
import { sendThreads, type CommentsArtifact } from './comment-send'
import { EditPanel, type HeldBy } from './edit-panel'
import type { ArtifactEditor, EditorState } from './editor'
import { frameHandOff } from './handoff'
import { pointBox } from './pop-place'
import { NEW_SESSION, useSendTargets, useTargetName } from './send-targets'
import type { Presence, ShownVersion } from './use-artifact'
import { HistoryCard } from './version-history'
import type { RightContent } from './viewer-shell'
import './viewer-tools.css'

type Box = { left: number; top: number; right: number; bottom: number }

/**
 * What a kind's content tells the tools: how to bring an anchor into view. The canvas opens or
 * frames the frame it is in; a page scrolls to it; a document or a deck, which draw their own
 * pins, bring their own place forward.
 */
export interface ToolContent {
  /** `thread` names the thread the anchor is for, which a document opens under its block. */
  reveal(anchor: CommentAnchor, thread?: string): void
}

/** What Ask is about: frames of a canvas, one element, or the whole artifact. */
type AskSubject =
  | { kind: 'frames'; ids: string[] }
  | { kind: 'element'; anchor: CommentAnchor; page: number | null }
  | { kind: 'whole'; path: string }

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
  // An older host cannot move a thread's anchor, so it offers no Pin again.
  const canRepin = useArtifactRecord(id, 'repin') && input.editable === 'yes'

  const [tab, setTab] = useState<'open' | 'resolved'>('open')
  const [selected, setSelected] = useState<string | null>(null)
  const [repinning, setRepinning] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ at: Box | null; subject: AskSubject } | null>(null)
  const commentsOpen = input.right === 'comments' || input.mode === 'comment'
  const numbers = useMemo(() => threadNumbers(threads ?? []), [threads])
  const openThread = editing.pin
    ? ((threads ?? []).find((th) => numbers.get(th.id) === editing.pin!.n) ?? null)
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

  // A click in Comment pins a draft there, or the thread being pinned again.
  const draftPick = editing.mode === 'comment' ? editing.picked : null
  useEffect(() => {
    if (!repinning || !shown || !editor) return
    return editor.subscribe(() => {
      const state = editor.get()
      if (state.mode !== 'comment' || !state.picked) return
      setRepinning(null)
      editor.clearPick()
      host('artifacts.repin', {
        id,
        threadId: repinning,
        anchor: anchorOf(state.picked, shown),
      }).catch((reason: unknown) =>
        toast(t('comments.repinFailed', { error: errorMessage(reason) }), undefined, {
          tone: 'warning',
        }),
      )
    })
  }, [repinning, shown, editor, id, t])

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
      const count = (threads ?? []).filter(isPending).length
      if (count === 0) return
      toast(
        t('comments.leftUnsent', { count, session: targetName(targets, target) }),
        { label: t('comments.send'), onClick: sendPending },
        { tone: 'info' },
      )
    },
    [input.mode, threads, t, targetName, targets, target, sendPending],
  )

  const focusThread = (thread: CommentThread) => {
    setSelected(thread.id)
    input.content.reveal(thread.anchor, thread.id)
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
    const at =
      boxes.length > 0
        ? {
            left: Math.min(...boxes.map((b) => b.left)),
            top: Math.min(...boxes.map((b) => b.top)),
            right: Math.max(...boxes.map((b) => b.right)),
            bottom: Math.max(...boxes.map((b) => b.bottom)),
          }
        : null
    setAsk({ at, subject: { kind: 'frames', ids } })
  }

  /** Ask about the element picked in Edit. */
  const askElement = () => {
    if (!editing.picked || !shown) return
    const anchor = anchorOf(editing.picked, shown)
    if (beside) return toComposer(anchor)
    const at = editing.picked.point ? pointBox(editing.picked.point) : null
    setAsk({ at, subject: { kind: 'element', anchor, page: editing.picked.page } })
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
    setAsk({ at: null, subject: { kind: 'whole', path } })
  }

  /** Ask about an anchor a kind found itself, such as words selected in a document, beside `at`. */
  const askAnchor = (anchor: CommentAnchor | null, at: Box | null, wholePath?: string) => {
    if (!anchor) return askWhole(wholePath)
    if (beside) return toComposer(anchor)
    setAsk({ at, subject: { kind: 'element', anchor, page: null } })
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
  const docThread = (thread: CommentThread, n: number, close: () => void) => (
    <ThreadPop
      key={thread.id}
      artifactId={id}
      thread={thread}
      n={n}
      versions={versions}
      at={null}
      inline
      onClose={close}
      onRepin={null}
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
  }

  // Who holds the picked element: an agent whose running turn wrote its frame or the artifact.
  const heldBy = useHeldBy(input, editing)
  const askLabel = t('edit.askAbout', {
    agent: targets.sessions[0] ? agentName(targets.sessions[0].agentId) : t('ask.agent'),
  })

  // The right card for the tools that have one.
  let right: RightContent | null = null
  const close = () =>
    setViewerState(id, (s) => ({ right: null, version: s.right === 'history' ? null : s.version }))
  const propsShown =
    input.mode === 'edit' && editing.mode === 'select' && !!editing.picked && !!editor && !!head
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
          selected={selected}
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
  let overlay: React.ReactNode = null
  if (ask && artifactInfo) {
    overlay = (
      <AskPop
        key={ask.at ? `${ask.at.left},${ask.at.top}` : 'middle'}
        at={ask.at}
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
  } else if (openThread && editor) {
    overlay = (
      <ThreadPop
        key={openThread.id}
        artifactId={id}
        thread={openThread}
        n={editing.pin!.n}
        versions={versions}
        at={editing.pin!.point ? pointBox(editing.pin!.point) : null}
        onClose={() => editor.clearPin()}
        onRepin={
          canRepin && openThread.anchor.missing
            ? () => {
                setRepinning(openThread.id)
                editor.clearPin()
                toast(t('comments.repinHint'), undefined, { tone: 'info' })
              }
            : null
        }
      />
    )
  } else if (draftPick && !repinning && editor && shown && latest) {
    const anchor = anchorOf(draftPick, shown)
    overlay = (
      <CommentDraft
        key={`${draftPick.page}:${draftPick.selection.src}:${draftPick.point?.x},${draftPick.point?.y}`}
        anchor={anchor}
        at={draftPick.point ? pointBox(draftPick.point) : null}
        waiting={waiting}
        onCancel={() => editor.clearPick()}
        onSave={async (body) => {
          await saveComment(anchor, body)
          editor.clearPick()
        }}
      />
    )
  }

  /** Esc closes a popover first. */
  const escape = (): boolean => {
    if (ask) {
      setAsk(null)
      return true
    }
    if (repinning) {
      setRepinning(null)
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
    reveal: (anchor) => {
      const { doc, shown } = input
      if (doc && shown) {
        const page = doc.pages.find((p) => p.file === anchor.path)
        if (!page) return
        if (anchor.offset !== null && !anchor.missing) {
          openCanvasFrame(input.id, page.canvas, page.id)
          const index = shown.canvas?.pages.findIndex((p) => p.id === page.id) ?? -1
          const src = anchor.offset
          if (index >= 0) setTimeout(() => input.editor?.reveal(index, src), 400)
        } else {
          setViewerState(input.id, { page: page.canvas, opened: null, selection: [page.id] })
          showArtifactPage(input.panel, input.id, page.id)
        }
        return
      }
      const number = anchor.page?.number
      const index = shown?.canvas?.pages.findIndex((p) => p.number === number) ?? -1
      if (index >= 0) input.focusLegacy(index)
      else if (anchor.offset !== null && !anchor.missing) input.editor?.reveal(null, anchor.offset)
    },
  }
}
