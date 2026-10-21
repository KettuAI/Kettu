import { MotionConfig } from 'motion/react'
import { useSettingsStore } from '@renderer/stores/settings'
import { App } from './app'

/** Every Motion animation honors the Reduce motion setting, and the OS setting under System. */
export function Root() {
  const reduceMotion = useSettingsStore((s) => s.settings.appearance.reduceMotion)
  return (
    <MotionConfig reducedMotion={reduceMotion === 'always' ? 'always' : 'user'}>
      <App />
    </MotionConfig>
  )
}
