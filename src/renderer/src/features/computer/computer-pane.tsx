import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ComputerIcon,
  DashboardSquare01Icon,
  LinkSquare02Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { computerControl, type ComputerAct } from '@shared/computer-use'
import type { ComputerUseView } from '@shared/thread'
import { ControlPointer } from '@renderer/components/control/control-pointer'
import { SurfaceLight } from '@renderer/components/control/surface-light'
import { SurfacePill } from '@renderer/components/control/surface-pill'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import {
  PaneEmpty,
  PaneHead,
  PaneIcon,
  PaneSheet,
  PaneSpinner,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { useAppIcon } from '@renderer/features/session/app-icon'
import { useSessionView } from '@renderer/features/session/use-thread'
import { errorMessage, host } from '@renderer/lib/host'
import { isMac } from '@renderer/lib/platform'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { panelSession } from '@renderer/stores/view'
import './computer-pane.css'

/** The real window's corner in points: macOS draws its windows rounder than the others. */
const WINDOW_RADIUS = isMac ? 14 : 8

type Capture =
  | { state: 'starting' }
  | { state: 'live'; stream: MediaStream }
  | { state: 'failed'; permission: boolean }

/**
 * The live picture of the window `windowId`, which main picks for the page: the window the
 * session holding the computer uses, and only it. It starts again when the agent moves to
 * another window, and stops when the pane closes.
 */
function useWindowCapture(windowId: number | null): { capture: Capture; retry: () => void } {
  const [capture, setCapture] = useState<Capture>({ state: 'starting' })
  const [attempt, setAttempt] = useState(0)
  const [shown, setShown] = useState({ windowId, attempt })
  if (shown.windowId !== windowId || shown.attempt !== attempt) {
    setShown({ windowId, attempt })
    setCapture({ state: 'starting' })
  }
  useEffect(() => {
    if (windowId === null) return
    let live = true
    let stream: MediaStream | null = null
    const fail = async () => {
      const status = await window.kettu.computer.status().catch(() => null)
      if (!live) return
      const recording = status?.screenRecording ?? null
      setCapture({ state: 'failed', permission: recording !== null && recording !== 'granted' })
    }
    navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false })
      .then((got) => {
        stream = got
        if (!live) {
          got.getTracks().forEach((track) => track.stop())
          return
        }
        // The window closed, or the app quit.
        got.getVideoTracks()[0]?.addEventListener('ended', () => void fail())
        setCapture({ state: 'live', stream: got })
      })
      .catch(() => void fail())
    return () => {
      live = false
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [windowId, attempt])
  return { capture, retry: () => setAttempt((n) => n + 1) }
}

/**
 * The video of the window, fitted to the stage and never past its own size, its corners rounded
 * as the real window's are. While the agent has the app, its light runs around the window and its
 * pointer goes where each action lands.
 */
function WindowVideo({
  stream,
  label,
  agent,
  act,
  pointer,
}: {
  stream: MediaStream
  label: string
  /** The agent has the app: its light and pointer show. */
  agent: boolean
  act: ComputerAct | null
  pointer: { id: string; name: string }
}) {
  const stage = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [box, setBox] = useState<{ width: number; height: number; radius: number } | null>(null)

  useLayoutEffect(() => {
    const element = video.current
    const frame = stage.current
    if (!element || !frame) return
    element.srcObject = stream
    // The picture is the window's pixels: its size and its corner scale with it.
    const measure = () => {
      const { videoWidth, videoHeight } = element
      if (!videoWidth || !videoHeight) return
      const natural = videoWidth / devicePixelRatio
      const scale = Math.min(
        frame.clientWidth / natural,
        frame.clientHeight / (videoHeight / devicePixelRatio),
        1,
      )
      const width = Math.floor(natural * scale)
      const height = Math.floor((videoHeight / devicePixelRatio) * scale)
      const radius = Math.max(4, Math.round(WINDOW_RADIUS * scale * 10) / 10)
      setBox((last) =>
        last?.width === width && last.height === height && last.radius === radius
          ? last
          : { width, height, radius },
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    element.addEventListener('loadedmetadata', measure)
    element.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      element.removeEventListener('loadedmetadata', measure)
      element.removeEventListener('resize', measure)
      element.srcObject = null
    }
  }, [stream])

  const at =
    box && act && act.x !== null && act.y !== null
      ? { x: act.x * box.width, y: act.y * box.height }
      : null
  return (
    <div ref={stage} className="kp-cframe">
      <div
        className="kp-cwin-box"
        style={box ? { width: box.width, height: box.height, borderRadius: box.radius } : undefined}
      >
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          aria-label={label}
          className="kp-cwin"
          style={{ borderRadius: box?.radius ?? WINDOW_RADIUS }}
        />
        <AnimatePresence>
          {agent && box && (
            <SurfaceLight
              key="light"
              placement="outside"
              act={act?.seq ?? 0}
              at={at}
              radius={box.radius}
            />
          )}
        </AnimatePresence>
        {agent && at && (
          <ControlPointer
            id={pointer.id}
            name={pointer.name}
            at={at}
            click={act?.kind === 'click' ? act.seq : 0}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The side panel's Computer pane: the one window the session's agent uses, live, and nothing else
 * of the screen. The picture stays in this window; remote devices and the web client never get it.
 */
export default function ComputerPane({ panel, maximized }: { panel: string; maximized: boolean }) {
  const { t } = useTranslation('session')
  const sessionId = panelSession(panel)
  const summary = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  const session = useSessionView(sessionId ?? '')
  const hostId = summary ? hostOfSession(summary) : null
  const agent = summary ? agentName(summary.agentId, hostId) : ''
  const view: ComputerUseView | null = session?.computer ?? null
  const windowId = hostId === null && view?.window ? view.window.id : null
  const { capture, retry } = useWindowCapture(windowId)
  const [showError, setShowError] = useState<string | null>(null)
  const icon = useAppIcon(view?.appPath ?? null)
  const app = view?.app ?? null
  const paused = view?.control === 'you'
  const controlAgent = useControlAgent(summary?.agentId ?? null, hostId)
  const { t: tc } = useTranslation('control')
  const control = (method: 'computer.takeOver' | 'computer.handBack') => {
    if (!sessionId) return
    setShowError(null)
    host(method, { sessionId }).catch((error: unknown) => setShowError(errorMessage(error)))
  }

  const show = () => {
    if (!sessionId) return
    setShowError(null)
    host('computer.show', { sessionId }).catch((error: unknown) =>
      setShowError(errorMessage(error)),
    )
  }

  let body: ReactNode
  if (hostId !== null) {
    body = (
      <PaneEmpty
        icon={<PaneIcon icon={ComputerIcon} size={20} />}
        title={t('computerPane.elsewhere')}
      />
    )
  } else if (!view) {
    body = (
      <PaneEmpty
        icon={<PaneIcon icon={ComputerIcon} size={20} />}
        title={t('computerPane.idle', { agent })}
        text={t('computerPane.idleHint')}
      />
    )
  } else if (!view.window) {
    body = (
      <PaneEmpty
        icon={<PaneIcon icon={ComputerIcon} size={20} />}
        title={t('computerPane.noWindow', { agent })}
        text={t('computerPane.noWindowHint')}
      />
    )
  } else if (capture.state === 'starting') {
    body = <PaneEmpty icon={<PaneSpinner />} title={t('computerPane.starting')} />
  } else if (capture.state === 'failed') {
    body = capture.permission ? (
      <PaneEmpty
        icon={<PaneIcon icon={ComputerIcon} size={20} />}
        title={t('computerPane.noPermission')}
        text={t('computerPane.noPermissionHint')}
      >
        <button
          type="button"
          className="kp-btn"
          onClick={() => void window.kettu.computer.requestPermission('screen-recording')}
        >
          {t('computerPane.allow')}
        </button>
      </PaneEmpty>
    ) : (
      <PaneEmpty
        icon={<PaneIcon icon={ComputerIcon} size={20} />}
        title={t('computerPane.failed')}
        text={t('computerPane.hiddenHint')}
      >
        <span className="flex gap-1.5">
          <button type="button" className="kp-btn" onClick={show}>
            {app ? t('computerPane.show', { app }) : t('computerPane.showApp')}
          </button>
          <button type="button" className="kp-btn" onClick={retry}>
            {t('computerPane.retry')}
          </button>
        </span>
      </PaneEmpty>
    )
  } else {
    body = (
      <WindowVideo
        stream={capture.stream}
        label={view.window.title ?? app ?? ''}
        agent={!paused}
        act={view.act ?? null}
        pointer={{ id: sessionId ?? '', name: agent }}
      />
    )
  }

  return (
    <PaneSheet pane="computer" maximized={maximized} data-computer-panel="">
      <PaneHead
        panel={panel}
        pane="computer"
        maximized={maximized}
        tools={
          view?.window && hostId === null ? (
            <PanelButton
              label={app ? t('computerPane.show', { app }) : t('computerPane.showApp')}
              onClick={show}
            >
              <PaneIcon icon={LinkSquare02Icon} />
            </PanelButton>
          ) : undefined
        }
      >
        {view && app ? (
          <span className="kp-cph">
            {icon ? (
              <img src={icon} alt="" className="kp-cph__icon" draggable={false} />
            ) : (
              <PaneIcon icon={DashboardSquare01Icon} />
            )}
            <b>{app}</b>
            {view.window?.title && view.window.title !== app && <span>{view.window.title}</span>}
            {view.window && capture.state === 'live' && (
              <span className="kp-cph__live" data-paused={paused || undefined}>
                <i />
                {paused ? t('computerPane.paused') : t('computerPane.live')}
              </span>
            )}
          </span>
        ) : (
          <span className="kp-head__title">{t('computerPane.title')}</span>
        )}
      </PaneHead>
      <div className="kp-body">
        {showError && (
          <p role="alert" className="kp-alert">
            {showError}
          </p>
        )}
        <div className="kp-cstage" data-control={view?.control ?? 'idle'}>
          {body}
          <span className="kp-cpill">
            <AnimatePresence>
              {view && hostId === null && (
                <SurfacePill
                  key="pill"
                  control={computerControl(view.control)}
                  agent={controlAgent}
                  agentName={agent}
                  scope={tc('scope.app')}
                  onTakeOver={() => control('computer.takeOver')}
                  onHandBack={() => control('computer.handBack')}
                  onDone={() => {}}
                />
              )}
            </AnimatePresence>
          </span>
        </div>
        {view && hostId === null && (
          <p className="kp-cnote">
            <PaneIcon icon={ViewIcon} size={13} />
            {t('computerPane.note', { agent })}
          </p>
        )}
      </div>
    </PaneSheet>
  )
}
