// The document type's viewer: Markdown in a reading layout, its text editable block by block.

import './document.css'
import { mount } from '../common/mount'
import { DocumentViewer } from './document-viewer'

mount((config, view) => <DocumentViewer config={config} view={view} />)
