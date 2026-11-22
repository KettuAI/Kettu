// The document type's viewer: Markdown in a reading layout. In the artifact viewer it is a sheet the
// window drives; anywhere else, as in a copy, it is a page of its own on white.

import './document.css'
import { mount } from '../common/mount'
import { DocumentViewer } from './document-viewer'

mount((config, view) => <DocumentViewer config={config} view={view} />, { light: true })
