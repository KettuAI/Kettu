/** The face the user picked, then the theme's code font for the glyphs it lacks. */
export function terminalFontStack(family: string | undefined, fallback: string): string {
  return family ? `"${family}", ${fallback}` : fallback
}
