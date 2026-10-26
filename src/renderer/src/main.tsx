import './styles/globals.css'

import { LucideProvider } from 'lucide-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrap } from './app/bootstrap'
import { Root } from './app/root'

// The first render waits for the settings and the themes, an IPC round trip each and side by
// side, so it already has the user's language, text size and colors instead of switching a frame
// later.
void bootstrap().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* One 1 px line at every icon size (design system: density and sizing). */}
      <LucideProvider strokeWidth={1.25} nonScalingStroke>
        <Root />
      </LucideProvider>
    </StrictMode>,
  ),
)
