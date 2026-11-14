import { useLayoutEffect, useRef } from 'react'
import { ComputerIcon, StopCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { isAgentId } from '@shared/agents'
import type { ComputerOverlayApi, ComputerOverlayState } from '@shared/computer-overlay'
import { stopShortcutText } from '@shared/computer-use'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { useSettingsStore } from '@renderer/stores/settings'

/** Room around the label for its shadow, which its window includes. */
const MARGIN = { x: 16, top: 4, bottom: 20 }

function Glyph({ icon, size = 13 }: { icon: IconSvgElement; size?: number }) {
  return (
    <HugeiconsIcon icon={icon} size={size} strokeWidth={1.9} aria-hidden className="shrink-0" />
  )
}

/**
 * At the top centre of the screen while Kettu is in the background: solid fox while the agent uses
 * the app, with Take over and Stop and its shortcut; white with Hand back once the user took it.
 * Its words are the composer label's.
 */
export function FloatingLabel({
  state,
  api,
}: {
  state: ComputerOverlayState
  api: ComputerOverlayApi
}) {
  const { t } = useTranslation(['control', 'session'])
  const box = useRef<HTMLDivElement>(null)
  const shortcut = useSettingsStore((s) => s.settings.computerUse.stopShortcut)

  // The window takes the label's size, with room for its shadow.
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const report = () => {
      const { width, height } = element.getBoundingClientRect()
      api.resize(width + 2 * MARGIN.x, height + MARGIN.top + MARGIN.bottom)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [api])

  const agent = state.agentName
  const b = <b dir="auto" />
  const theirs = state.control === 'you'
  return (
    <div className="kco-float-room" style={{ padding: `${MARGIN.top}px ${MARGIN.x}px 0` }}>
      <div ref={box} role="status" className="kco-float" data-control={state.control}>
        <span key={state.control} className="kco-float__in">
          {theirs ? (
            <>
              {isAgentId(state.agentId) && (
                <AgentMark agent={state.agentId} size={14} hostId={null} dot={null} />
              )}
              <span className="kco-float__text">
                <Trans
                  t={t}
                  i18nKey="label.computer.you"
                  values={{ agent, held: state.app ?? t('held.computer') }}
                  components={{ b, i: <i aria-hidden /> }}
                />
              </span>
              <button
                type="button"
                className="kco-float__btn kco-float__btn--solid"
                onClick={() => api.act('hand-back')}
              >
                {t('actions.handBack')}
              </button>
            </>
          ) : (
            <>
              {state.appIcon ? (
                <img src={state.appIcon} alt="" className="kco-float__icon" draggable={false} />
              ) : (
                <Glyph icon={ComputerIcon} size={15} />
              )}
              <span className="kco-float__text">
                <Trans
                  t={t}
                  i18nKey="label.computer.agent"
                  values={{ agent, target: state.app ?? t('target.computer') }}
                  components={{ b }}
                />
              </span>
              <button type="button" className="kco-float__btn" onClick={() => api.act('take-over')}>
                {t('actions.takeOver')}
              </button>
              <button
                type="button"
                className="kco-float__btn kco-float__btn--quiet"
                title={t('session:computerBar.stopLabel')}
                onClick={() => api.act('stop')}
              >
                <Glyph icon={StopCircleIcon} />
                {t('actions.stop')}
                <kbd>{stopShortcutText(shortcut, api.platform)}</kbd>
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  )
}
