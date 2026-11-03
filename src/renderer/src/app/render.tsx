import { LucideProvider } from 'lucide-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './root'

/** Shows the app in `container`, once the bootstrap has the settings and the themes. */
export function renderApp(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      {/* One line of 1.35 px at every icon size. */}
      <LucideProvider strokeWidth={1.35} nonScalingStroke>
        <Root />
      </LucideProvider>
    </StrictMode>,
  )
}
