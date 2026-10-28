import type { MarkBodyProps } from './index'

// OpenCode mark: sst/opencode packages/identity, https://github.com/sst/opencode (MIT), Copyright (c) SST.
const OPENCODE_FRAME = 'M384 416H128V96H384V416ZM320 160H192V352H320V160Z'
const OPENCODE_FILL = 'M320 224V352H192V224H320Z'

export const viewBox = '80 80 352 352'

/** The frame and fill in their brand colors, or both in `currentColor` when `mono`. */
export function Body({ mono }: MarkBodyProps) {
  return (
    <>
      {!mono && <path fill="var(--brand-opencode-fill)" d={OPENCODE_FILL} />}
      <path
        fill={mono ? 'currentColor' : 'var(--brand-opencode-frame)'}
        fillRule="evenodd"
        clipRule="evenodd"
        d={OPENCODE_FRAME}
      />
    </>
  )
}
