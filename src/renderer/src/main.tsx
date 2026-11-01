import './styles/globals.css'

import { bootstrap } from './app/bootstrap'
import { renderApp } from './app/render'

// The first render waits for the settings and the themes, an IPC round trip each and side by
// side, so it already has the user's language, text size and colors instead of switching a frame
// later.
void bootstrap().then(() => renderApp(document.getElementById('root')!))
