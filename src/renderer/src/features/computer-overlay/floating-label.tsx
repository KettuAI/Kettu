import { useLayoutEffect, useRef } from 'react'
import { ArrowTurnBackwardIcon, ComputerIcon, StopCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { harnessOf, isAgentId } from '@shared/agents'
import type { ComputerOverlayApi, ComputerOverlayState } from '@shared/computer-overlay'
import { acceleratorKeys } from '@shared/computer-use'
import { AGENT_MARKS } from '@renderer/components/agents/marks'

/** Room around the label for its shadow, which its window includes. */
const MARGIN = { x: 16, top: 4, bottom: 20 }

function Glyph({ icon, size = 13 }: { icon: IconSvgElement; size?: number }) {
  return (
    <HugeiconsIcon icon={icon} size={size} strokeWidth={1.9} aria-hidden className="shrink-0" />
  )
}

function AgentLogo({ agentId }: { agentId: string }) {
  if (!isAgentId(agentId)) return null
  const { viewBox, Body } = AGENT_MARKS[harnessOf(agentId)]
  return (
    <svg width={14} height={14} viewBox={viewBox} aria-hidden className="shrink-0">
      <Body mono={false} />
    </svg>
  )
}

/**
 * At the top centre of the screen while Kettu is in the background: solid fox while the agent uses
 * the app, with Take over and Stop and its shortcut; white with Hand back once the user took it.
 */
export function FloatingLabel({
  state,
  api,
}: {
  state: ComputerOverlayState
  api: ComputerOverlayApi
}) {
  const { t } = useTranslation('session')
  const box = useRef<HTMLDivElement>(null)

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
  const app = <b />
  const keys = acceleratorKeys(state.shortcut, api.platform)
  const shortcut = api.platform === 'darwin' ? keys.join('') : keys.join('+')
  const theirs = state.control === 'you'
  return (
    <div className="kco-float-room" style={{ padding: `${MARGIN.top}px ${MARGIN.x}px 0` }}>
      <div ref={box} role="status" className="kco-float" data-control={state.control}>
        <span key={state.control} className="kco-float__in">
          {theirs ? (
            <>
              <AgentLogo agentId={state.agentId} />
              <span className="kco-float__text">
                {state.app ? (
                  <Trans
                    t={t}
                    i18nKey="computerFloat.tookOver"
                    values={{ app: state.app, agent }}
                    components={{ app }}
                  />
                ) : (
                  <Trans
                    t={t}
                    i18nKey="computerFloat.tookOverComputer"
                    values={{ agent }}
                    components={{ app }}
                  />
                )}
              </span>
              <button
                type="button"
                className="kco-float__btn kco-float__btn--solid"
                onClick={() => api.act('hand-back')}
              >
                <Glyph icon={ArrowTurnBackwardIcon} />
                {t('computerFloat.handBack')}
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
                {state.app ? (
                  <Trans
                    t={t}
                    i18nKey="computerFloat.using"
                    values={{ app: state.app, agent }}
                    components={{ app }}
                  />
                ) : (
                  t('computerFloat.usingComputer', { agent })
                )}
              </span>
              <button type="button" className="kco-float__btn" onClick={() => api.act('take-over')}>
                {t('computerFloat.takeOver')}
              </button>
              <button
                type="button"
                className="kco-float__btn kco-float__btn--quiet"
                title={t('computerFloat.stopLabel')}
                onClick={() => api.act('stop')}
              >
                <Glyph icon={StopCircleIcon} />
                {t('computerFloat.stop')}
                <kbd>{shortcut}</kbd>
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  )
}
