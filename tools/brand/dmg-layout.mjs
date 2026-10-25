// The disk image's Finder window, in points. build.mjs draws the backgrounds for it, and the dmg
// section of electron-builder.yml places the icons the same way, which dmg.test.ts checks.
export const DMG_LAYOUT = {
  width: 640,
  height: 420,
  iconSize: 128,
  iconTextSize: 13,
  // The centres of the two icons.
  app: { x: 192, y: 140 },
  applications: { x: 448, y: 140 },
}
