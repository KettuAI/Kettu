// The workflows that ship with Kettu, bundled as their files' text.

import development from './development.yaml?raw'
import research from './research.yaml?raw'
import review from './review.yaml?raw'

export const OFFICIAL_WORKFLOWS: readonly { file: string; text: string }[] = [
  { file: 'development.yaml', text: development },
  { file: 'research.yaml', text: research },
  { file: 'review.yaml', text: review },
]
