import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircleIcon,
  Comment01Icon,
  Cursor01Icon,
  Delete02Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  PaneEmpty,
  PaneHead,
  PaneIcon,
  PanelButton,
  PaneSheet,
} from '@renderer/features/shell/panel-button'
import { host } from '@renderer/lib/host'
import { restoreArtifact, setPaneSelection, useArtifactsStore } from '@renderer/stores/artifacts'
import { openArtifact } from '@renderer/stores/view'
import { anchorOf, pinsOf } from './anchors'
import { ArtifactMoreButton } from './artifact-menu'
import { CanvasControls } from './canvas-controls'
import { CommentBox } from './comments'
import { ArtifactEditor, useEditorState } from './editor'
import { Waiting } from './page-frame'
import { canvasPageName, useArtifact, useArtifactStates, useListsRead } from './use-artifact'
import { useComments } from './use-comments'
import { AgentCursorStyles } from '@renderer/components/affect/agent-cursors'
import { CanvasEditor } from './canvas-editor'
import { PresenceFaces } from './presence-faces'
import { noteAuthor, usePresentAgents, useVisitors } from './use-present-agents'
import { useCanvasDoc } from './use-canvas-doc'
import { ArtifactSurface, CanvasBarControls } from './viewer-parts'
import { PreviewOnly } from './preview-only'

/**
 * An artifact beside the thread, opened from a tool call's row, so the page reloads in view while
 * the agent keeps changing it. Esc leaves a focused page and never closes the pane.
 */
export default function ArtifactPane({
  projectPath,
  panel,
  id,
  maximized,
}: {
  projectPath: string
  /** The session's side panel it shows in. */
  panel: string
  id: string
  maximized: boolean
}) {
  const { t } = useTranslation('artifacts')
  const [since] = useState(() => performance.now())
  const artifact = useArtifact(id, null)
  const listsRead = useListsRead()
  const states = useArtifactStates(artifact, listsRead)
  const controls = useMemo(() => new CanvasControls(), [])
  const { summary, shown, url } = artifact
  const title = summary?.title ?? shown?.title ?? ''
  const showing = !!(url && shown) && !states.error && !states.gone && !artifact.stopped
  const editor = useMemo(() => (url ? new ArtifactEditor(url.slice(0, -1)) : null), [url])
  useEffect(() => () => editor?.dispose(), [editor])
  const editing = useEditorState(editor)
  const latest = !!shown && !!summary && shown.version === summary.version && !states.inTrash
  const { threads } = useComments(editing.mode === 'comment' ? id : null)
  const liveCanvas = useCanvasDoc(id, latest && !!shown?.doc)
  const agents = usePresentAgents(artifact.presence, summary?.deletedAt != null)
  const visitors = useVisitors(id)

  useEffect(() => {
    if (states.inTrash) editor?.setMode(null)
  }, [states.inTrash, editor])

  useEffect(() => {
    if (!editor || !shown) return
    editor.setPins(editing.mode === 'comment' ? pinsOf(threads, shown) : () => [])
  }, [editor, shown, threads, editing.mode])

  // What is picked here is the context the composer beside it offers, until something else is.
  useEffect(() => {
    if (editing.mode !== 'select' || !editing.picked || !shown) return
    setPaneSelection({
      projectPath,
      artifactId: id,
      title,
      anchor: anchorOf(editing.picked, shown),
    })
  }, [editing.mode, editing.picked, shown, projectPath, id, title])
  const choosePage = useCallback(
    (index: number) => {
      const page = shown?.canvas?.pages[index]
      if (!page || !shown) return
      setPaneSelection({
        projectPath,
        artifactId: id,
        title,
        anchor: {
          version: shown.version,
          path: ARTIFACT_ENTRY,
          page: { number: page.number, name: page.name },
          offset: null,
          tag: null,
          text: '',
          missing: false,
        },
      })
    },
    [shown, projectPath, id, title],
  )
  useEffect(
    () => () => {
      if (useArtifactsStore.getState().paneSelection?.artifactId === id) setPaneSelection(null)
    },
    [id],
  )

  let body: React.ReactNode
  if (states.error === 'previewOnly') {
    body = <PreviewOnly summary={summary ?? null} />
  } else if (states.error) {
    body = (
      <PaneEmpty
        icon={<Icon icon={AlertCircleIcon} size={20} />}
        title={t('viewer.errorTitle')}
        text={t(`viewer.error.${states.error}`)}
      >
        <button type="button" className="kp-btn" onClick={artifact.retry}>
          {t('viewer.retry')}
        </button>
      </PaneEmpty>
    )
  } else if (states.gone || states.inTrash) {
    body = (
      <PaneEmpty
        icon={<Icon icon={Delete02Icon} size={20} />}
        title={t('viewer.goneTitle')}
        text={t('viewer.goneDescription')}
      >
        <button
          type="button"
          className="kp-btn"
          onClick={() => void restoreArtifact(id).catch((e: unknown) => console.error(e))}
        >
          {t('menu.restore')}
        </button>
      </PaneEmpty>
    )
  } else if (artifact.stopped) {
    body = (
      <PaneEmpty title={t('viewer.stoppedTitle')} text={t('viewer.stoppedDescription')}>
        <button type="button" className="kp-btn" onClick={artifact.restart}>
          {t('viewer.reload')}
        </button>
      </PaneEmpty>
    )
  } else if (url && shown && shown.doc) {
    body = (
      <CanvasEditor
        artifactId={id}
        url={url}
        version={shown.version}
        title={title}
        canvas={liveCanvas}
        files={shown.paths}
        readOnly
        controls={controls}
        editor={latest ? (editor ?? undefined) : undefined}
        actions={null}
        agents={latest ? agents : []}
        following={null}
        onFollowDone={() => {}}
        sessionName={(session) => noteAuthor(agents, session, t('board.note.agent'))}
        reloads={artifact.reloads}
      />
    )
  } else if (url && shown) {
    body = (
      <ArtifactSurface
        url={url}
        shown={shown}
        title={title}
        reloads={artifact.reloads}
        since={since}
        controls={controls}
        top={0}
        editor={latest ? (editor ?? undefined) : undefined}
        onPageChosen={choosePage}
      />
    )
  } else {
    body = <Waiting since={since} />
  }

  return (
    <PaneSheet pane="artifact" maximized={maximized} aria-label={title || undefined}>
      <PaneHead
        panel={panel}
        pane="artifact"
        maximized={maximized}
        tools={
          showing && (
            <>
              <AgentCursorStyles />
              <PresenceFaces
                agents={agents.slice(0, 3)}
                presence={artifact.presence}
                pageName={(page) =>
                  page ? (liveCanvas.doc?.pages.find((p) => p.id === page)?.name ?? null) : null
                }
                following={null}
                onFollow={() => {}}
                visitors={visitors}
              />
              {shown?.canvas && (
                <CanvasBarControls
                  controls={controls}
                  pageName={canvasPageName(shown, (number) => t('canvas.page', { number }))}
                  size="pane"
                />
              )}
              {latest && editor && (
                <>
                  <PanelButton
                    label={t('tools.select')}
                    shortcut="V"
                    pressed={editing.mode === 'select'}
                    onClick={() => editor.toggle('select')}
                  >
                    <PaneIcon icon={Cursor01Icon} />
                  </PanelButton>
                  <PanelButton
                    label={t('tools.comment')}
                    shortcut="C"
                    pressed={editing.mode === 'comment'}
                    onClick={() => editor.toggle('comment')}
                  >
                    <PaneIcon icon={Comment01Icon} />
                  </PanelButton>
                </>
              )}
              <PanelButton label={t('viewer.reload')} onClick={artifact.reload}>
                <PaneIcon icon={RefreshIcon} />
              </PanelButton>
              {summary && (
                <ArtifactMoreButton
                  pane
                  target={{
                    id,
                    title,
                    version: shown?.version ?? summary.version,
                    versions: summary.version,
                    files: shown?.files ?? summary.files,
                    sessionId: summary.sessionId,
                    deletedAt: summary.deletedAt,
                    type: summary.type,
                  }}
                  onVersionHistory={() => openArtifact(id, { history: true })}
                />
              )}
            </>
          )
        }
      >
        <span className="kp-head__title k-av-pane__title" title={title}>
          {title}
        </span>
        {shown && (
          <span className="k-av-pane__version">
            {t('viewer.version', { version: shown.version })}
          </span>
        )}
      </PaneHead>
      <div className="kp-body">
        <div className="k-av-frame">
          {body}
          {editor && shown && editing.mode === 'comment' && editing.picked?.point && (
            <CommentBox
              key={`${editing.picked.point.x},${editing.picked.point.y}`}
              anchor={anchorOf(editing.picked, shown)}
              point={editing.picked.point}
              onCancel={() => editor.clearPick()}
              onSubmit={async (text) => {
                await host('artifacts.comment', {
                  id,
                  anchor: anchorOf(editing.picked!, shown),
                  body: text,
                })
                editor.clearPick()
              }}
            />
          )}
        </div>
      </div>
    </PaneSheet>
  )
}
