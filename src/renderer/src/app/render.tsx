import { LucideProvider } from 'lucide-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './root'

/** Shows the app in `container`, once the bootstrap has the settings and the themes. */
export function renderApp(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      {/* One 1 px line at every icon size (design system: density and sizing). */}
      <LucideProvider strokeWidth={1.25} nonScalingStroke>
        <Root />
      </LucideProvider>
    </StrictMode>,
  )
}
