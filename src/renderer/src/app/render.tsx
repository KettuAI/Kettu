import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './root'

/** Shows the app in `container`, once the bootstrap has the settings and the themes. */
export function renderApp(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  )
}
