import '@renderer/styles/globals.css'
import './computer-overlay.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ComputerOverlayApi } from '@shared/computer-overlay'
import { OverlayRoot } from './overlay-root'

document.documentElement.dataset.overlay = (window.kettu as unknown as ComputerOverlayApi).part
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OverlayRoot />
  </StrictMode>,
)
