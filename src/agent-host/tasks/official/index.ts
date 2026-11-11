// The SOPs that ship with Kettu, bundled as their files' text.

import bugFix from './bug-fix.yaml?raw'
import development from './development.yaml?raw'
import parallelBuild from './parallel-build.yaml?raw'

export const OFFICIAL_SOPS: readonly { file: string; text: string }[] = [
  { file: 'development.yaml', text: development },
  { file: 'bug-fix.yaml', text: bugFix },
  { file: 'parallel-build.yaml', text: parallelBuild },
]
