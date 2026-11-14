import '@renderer/styles/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initSettings } from '@renderer/stores/settings'
import { initThemes } from '@renderer/stores/themes'
import { OverlayRoot } from './overlay-page'

// As the window does, the first render waits for the language, the text size and the colors.
Promise.all([initSettings(), initThemes()])
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <OverlayRoot />
      </StrictMode>,
    ),
  )
  .catch((error: unknown) => console.error('The page overlay could not start', error))
