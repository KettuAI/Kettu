import { useEffect, useState } from 'react'
import { MotionConfig } from 'motion/react'
import type { ComputerOverlayApi, ComputerOverlayState } from '@shared/computer-overlay'
import { useSettingsStore } from '@renderer/stores/settings'
import { FloatingLabel } from './floating-label'
import { WindowLight } from './window-light'

const api = window.kettu as unknown as ComputerOverlayApi

export function OverlayRoot() {
  const [state, setState] = useState<ComputerOverlayState | null>(null)
  const reduceMotion = useSettingsStore((s) => s.settings.appearance.reduceMotion)
  useEffect(() => api.onState(setState), [])
  if (!state) return null
  return (
    <MotionConfig reducedMotion={reduceMotion === 'always' ? 'always' : 'user'}>
      {api.part === 'light' ? (
        <WindowLight state={state} />
      ) : (
        <FloatingLabel state={state} api={api} />
      )}
    </MotionConfig>
  )
}
