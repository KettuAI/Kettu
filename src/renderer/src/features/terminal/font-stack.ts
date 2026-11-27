import { fontStack } from '@shared/font-stack'

/** The face the user picked, then the theme's code font for the glyphs it lacks. */
export function terminalFontStack(family: string | undefined, fallback: string): string {
  return fontStack(family, fallback)
}
