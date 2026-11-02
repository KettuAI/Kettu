import '@renderer/styles/globals.css'

import { LucideProvider } from 'lucide-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initSettings } from '@renderer/stores/settings'
import { initThemes } from '@renderer/stores/themes'
import { initTrayPanel } from '@renderer/stores/tray-panel'
import { TrayRoot } from './tray-panel'

// As the window does, the first render waits for the language, the text size and the colors.
Promise.all([initSettings(), initThemes(), initTrayPanel()])
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <LucideProvider strokeWidth={1.35} nonScalingStroke>
          <TrayRoot />
        </LucideProvider>
      </StrictMode>,
    ),
  )
  .catch((error: unknown) => console.error('The menu bar panel could not start', error))
