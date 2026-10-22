import './styles/globals.css'

import { LucideProvider } from 'lucide-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrap } from './app/bootstrap'
import { Root } from './app/root'

// The first render waits for the settings, one IPC round trip, so it already has the user's
// language and text size instead of switching a frame later.
void bootstrap().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* One line weight for every icon (design system: icons). */}
      <LucideProvider strokeWidth={1.5}>
        <Root />
      </LucideProvider>
    </StrictMode>,
  ),
)
