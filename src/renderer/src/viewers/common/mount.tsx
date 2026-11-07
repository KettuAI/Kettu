// Starts a type viewer: reads its config, then renders it, or a line saying it cannot show.

import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ViewerConfig, ViewerView } from '@shared/artifact-types'
import { followColorMode, readConfig, readView, startI18n } from './boot'

export function mount(render: (config: ViewerConfig, view: ViewerView) => ReactNode): void {
  const root = document.getElementById('root')
  const config = readConfig()
  if (!root || !config) return
  startI18n(config)
  followColorMode()
  createRoot(root).render(<StrictMode>{render(config, readView())}</StrictMode>)
}
