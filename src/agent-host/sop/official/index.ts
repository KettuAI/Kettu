// The SOPs that ship with Kettu, bundled as their files' text.

import featureDevelopment from './feature-development.yaml?raw'
import fixABug from './fix-a-bug.yaml?raw'
import frontendBackend from './frontend-backend.yaml?raw'
import technicalDesign from './technical-design.yaml?raw'

export const OFFICIAL_SOPS: readonly { id: string; text: string }[] = [
  { id: 'feature-development', text: featureDevelopment },
  { id: 'fix-a-bug', text: fixABug },
  { id: 'frontend-backend', text: frontendBackend },
  { id: 'technical-design', text: technicalDesign },
]
