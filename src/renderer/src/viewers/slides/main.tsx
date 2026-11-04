// The slides type's viewer: one slide at a time, presented full frame, its text editable in place.

import './slides.css'
import { mount } from '../common/mount'
import { SlidesViewer } from './slides-viewer'

mount((config, view) => <SlidesViewer config={config} view={view} />)
