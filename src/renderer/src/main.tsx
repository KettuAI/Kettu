import './styles/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrap } from './app/bootstrap'
import { Root } from './app/root'

bootstrap()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
