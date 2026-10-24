// The OverBench mark and wordmark, as docs/design/brand.md specifies them. The renderer draws
// them through components/brand.tsx and tools/brand builds the icons and images from them.

/** The mark's artboard: every size rule measures this box, not the shape inside it. */
export const MARK_BOX = { x: 10, y: 24, width: 80, height: 52 }

export type MarkVersion = 'standard' | 'small'

/** The small version has wider cuts and a thicker bench, for widths of 16 to 47 px. */
export const MARK_PATHS: Record<MarkVersion, string> = {
  standard:
    'M14.33 68.48L36.59 29.92C38.64 26.38 41.36 26.38 43.41 29.92L46.35 35.02C46.63 35.51 46.69 36.18 46.5 36.71L41.3 50.91C37.98 59.95 38.98 60.42 43.8 52.08L56.59 29.92C58.64 26.38 61.36 26.38 63.41 29.92L66.35 35.02C66.63 35.51 66.69 36.18 66.5 36.71L60.67 52.62C57.73 60.64 58.62 61.05 62.89 53.66L66.54 47.34C68.61 43.74 71.39 43.74 73.46 47.34L85.67 68.48C88.27 72.98 86.54 75.98 81.34 75.98L18.66 75.98C13.46 75.98 11.73 72.98 14.33 68.48Z',
  small:
    'M14.33 68.48L37.88 27.69C39.15 25.49 40.85 25.49 42.12 27.69L43.75 30.51C44.04 31.02 44.15 31.74 44.02 32.31L40.58 47.67C38.39 57.46 40.27 58.19 45.29 49.5L57.88 27.69C59.15 25.49 60.85 25.49 62.12 27.69L63.75 30.51C64.04 31.02 64.15 31.74 64.02 32.31L59.79 51.23C58.07 58.88 59.54 59.45 63.46 52.66L66.54 47.34C68.61 43.74 71.39 43.74 73.46 47.34L85.67 68.48C88.27 72.98 86.54 75.98 81.34 75.98L18.66 75.98C13.46 75.98 11.73 72.98 14.33 68.48Z',
}

/** The vertical centre of each shape's outer box, which icon tiles centre on. */
export const MARK_CENTER_Y: Record<MarkVersion, number> = { standard: 51.62, small: 51.01 }

/** Widths from this up take the standard version. */
export const STANDARD_MARK_MIN_WIDTH = 48

export function markVersionFor(width: number): MarkVersion {
  return width >= STANDARD_MARK_MIN_WIDTH ? 'standard' : 'small'
}

/**
 * "OverBench" in Manrope SemiBold at a font size of 100, tracked -1%, as outlines so it needs no
 * font. The baseline is y = 0.
 */
export const WORDMARK = {
  path: 'M37.05 1.5Q26.25 1.5 18.65 -3.23Q11.05 -7.95 7.03 -16.4Q3 -24.85 3 -36Q3 -47.15 7.03 -55.6Q11.05 -64.05 18.65 -68.78Q26.25 -73.5 37.05 -73.5Q47.8 -73.5 55.43 -68.78Q63.05 -64.05 67.05 -55.6Q71.05 -47.15 71.05 -36Q71.05 -24.85 67.05 -16.4Q63.05 -7.95 55.43 -3.23Q47.8 1.5 37.05 1.5ZM37.05 -8.45Q44.7 -8.35 49.78 -11.83Q54.85 -15.3 57.4 -21.53Q59.95 -27.75 59.95 -36Q59.95 -44.25 57.4 -50.43Q54.85 -56.6 49.78 -60.05Q44.7 -63.5 37.05 -63.55Q29.4 -63.65 24.33 -60.2Q19.25 -56.75 16.7 -50.5Q14.15 -44.25 14.1 -36Q14.05 -27.75 16.6 -21.58Q19.15 -15.4 24.28 -11.95Q29.4 -8.5 37.05 -8.45ZM94.65 0 75.05 -54H85.6L99.95 -13.1L114.3 -54H124.85L105.25 0ZM154.8 1.5Q146.75 1.5 140.68 -2.02Q134.6 -5.55 131.22 -11.88Q127.85 -18.2 127.85 -26.55Q127.85 -35.4 131.18 -41.9Q134.5 -48.4 140.45 -51.95Q146.4 -55.5 154.3 -55.5Q162.55 -55.5 168.35 -51.68Q174.15 -47.85 177.03 -40.8Q179.9 -33.75 179.3 -24.05H168.85V-27.85Q168.75 -37.25 165.28 -41.75Q161.8 -46.25 154.7 -46.25Q146.85 -46.25 142.9 -41.3Q138.95 -36.35 138.95 -27Q138.95 -18.1 142.9 -13.23Q146.85 -8.35 154.3 -8.35Q159.2 -8.35 162.78 -10.58Q166.35 -12.8 168.35 -16.95L178.6 -13.7Q175.45 -6.45 169.05 -2.48Q162.65 1.5 154.8 1.5ZM135.55 -24.05V-32.2H174.1V-24.05ZM189.5 0V-54H198.8V-40.9L197.5 -42.6Q198.5 -45.2 200.1 -47.38Q201.7 -49.55 203.8 -50.95Q205.85 -52.45 208.38 -53.28Q210.9 -54.1 213.55 -54.28Q216.2 -54.45 218.65 -54V-44.2Q216 -44.9 212.78 -44.6Q209.55 -44.3 206.85 -42.55Q204.3 -40.9 202.83 -38.55Q201.35 -36.2 200.7 -33.33Q200.05 -30.45 200.05 -27.25V0ZM227.15 0V-72H255.45Q262.3 -72 266.95 -69.2Q271.6 -66.4 273.95 -61.98Q276.3 -57.55 276.3 -52.65Q276.3 -46.7 273.38 -42.45Q270.45 -38.2 265.5 -36.65L265.4 -39.1Q272.3 -37.4 276 -32.48Q279.7 -27.55 279.7 -21Q279.7 -14.65 277.18 -9.95Q274.65 -5.25 269.82 -2.62Q265 0 258.15 0ZM237.75 -9.95H256.55Q260.1 -9.95 262.93 -11.3Q265.75 -12.65 267.38 -15.18Q269 -17.7 269 -21.2Q269 -24.45 267.57 -27.08Q266.15 -29.7 263.48 -31.23Q260.8 -32.75 257.2 -32.75H237.75ZM237.75 -42.6H255.3Q258.2 -42.6 260.53 -43.78Q262.85 -44.95 264.23 -47.18Q265.6 -49.4 265.6 -52.55Q265.6 -56.75 262.8 -59.45Q260 -62.15 255.3 -62.15H237.75ZM312.6 1.5Q304.55 1.5 298.48 -2.02Q292.4 -5.55 289.03 -11.88Q285.65 -18.2 285.65 -26.55Q285.65 -35.4 288.98 -41.9Q292.3 -48.4 298.25 -51.95Q304.2 -55.5 312.1 -55.5Q320.35 -55.5 326.15 -51.68Q331.95 -47.85 334.83 -40.8Q337.7 -33.75 337.1 -24.05H326.65V-27.85Q326.55 -37.25 323.08 -41.75Q319.6 -46.25 312.5 -46.25Q304.65 -46.25 300.7 -41.3Q296.75 -36.35 296.75 -27Q296.75 -18.1 300.7 -13.23Q304.65 -8.35 312.1 -8.35Q317 -8.35 320.58 -10.58Q324.15 -12.8 326.15 -16.95L336.4 -13.7Q333.25 -6.45 326.85 -2.48Q320.45 1.5 312.6 1.5ZM293.35 -24.05V-32.2H331.9V-24.05ZM383.7 0V-26.55Q383.7 -29.7 383.18 -33.02Q382.65 -36.35 381.18 -39.2Q379.7 -42.05 377.03 -43.8Q374.35 -45.55 370.05 -45.55Q367.25 -45.55 364.75 -44.62Q362.25 -43.7 360.38 -41.65Q358.5 -39.6 357.43 -36.25Q356.35 -32.9 356.35 -28.1L349.85 -30.55Q349.85 -37.9 352.6 -43.53Q355.35 -49.15 360.5 -52.3Q365.65 -55.45 372.95 -55.45Q378.55 -55.45 382.35 -53.65Q386.15 -51.85 388.53 -48.93Q390.9 -46 392.15 -42.55Q393.4 -39.1 393.85 -35.8Q394.3 -32.5 394.3 -30V0ZM345.75 0V-54H355.1V-38.4H356.35V0ZM428.75 1.5Q420.45 1.5 414.65 -2.2Q408.85 -5.9 405.78 -12.35Q402.7 -18.8 402.65 -27Q402.7 -35.35 405.85 -41.78Q409 -48.2 414.85 -51.85Q420.7 -55.5 428.9 -55.5Q437.75 -55.5 444.03 -51.1Q450.3 -46.7 452.3 -39.05L441.9 -36.05Q440.35 -40.6 436.83 -43.12Q433.3 -45.65 428.75 -45.65Q423.6 -45.65 420.3 -43.23Q417 -40.8 415.4 -36.6Q413.8 -32.4 413.75 -27Q413.8 -18.65 417.58 -13.5Q421.35 -8.35 428.75 -8.35Q433.8 -8.35 436.93 -10.68Q440.05 -13 441.7 -17.35L452.3 -14.85Q449.65 -6.95 443.55 -2.73Q437.45 1.5 428.75 1.5ZM499.4 0V-26.55Q499.4 -29.7 498.88 -33.02Q498.35 -36.35 496.88 -39.2Q495.4 -42.05 492.73 -43.8Q490.05 -45.55 485.75 -45.55Q482.95 -45.55 480.45 -44.62Q477.95 -43.7 476.08 -41.65Q474.2 -39.6 473.12 -36.25Q472.05 -32.9 472.05 -28.1L465.55 -30.55Q465.55 -37.9 468.3 -43.53Q471.05 -49.15 476.2 -52.3Q481.35 -55.45 488.65 -55.45Q494.25 -55.45 498.05 -53.65Q501.85 -51.85 504.23 -48.93Q506.6 -46 507.85 -42.55Q509.1 -39.1 509.55 -35.8Q510 -32.5 510 -30V0ZM461.45 0V-72H470.8V-33.15H472.05V0Z',
  advance: 516,
  // The font's typographic ascent and descent, which place the baseline in a line box.
  ascent: 106.6,
  descent: 30,
}

const FONT_SIZE = 100

export type LockupLayout = 'horizontal' | 'vertical'

export interface LockupGeometry {
  width: number
  height: number
  /** The mark's artboard, placed in the lockup. */
  mark: { x: number; y: number; width: number; height: number }
  /** Where the wordmark's origin, its baseline at the left edge, sits. */
  text: { x: number; y: number }
}

// The wordmark sits in a line box one font size tall, as text with a line height of 1 does.
function baselineInLineBox(top: number): number {
  const content = WORDMARK.ascent + WORDMARK.descent
  return top + (FONT_SIZE - content) / 2 + WORDMARK.ascent
}

/**
 * The fixed lockups at a font size of 100. Horizontal: the mark is 1.95 font sizes wide, 0.45
 * from the wordmark, both centred vertically. Vertical: 3.3 wide, 0.6 above the wordmark.
 */
export function lockupGeometry(layout: LockupLayout): LockupGeometry {
  const ratio = MARK_BOX.height / MARK_BOX.width
  if (layout === 'horizontal') {
    const markWidth = 1.95 * FONT_SIZE
    const markHeight = markWidth * ratio
    const height = Math.max(markHeight, FONT_SIZE)
    const textX = markWidth + 0.45 * FONT_SIZE
    return {
      width: textX + WORDMARK.advance,
      height,
      mark: { x: 0, y: (height - markHeight) / 2, width: markWidth, height: markHeight },
      text: { x: textX, y: baselineInLineBox((height - FONT_SIZE) / 2) },
    }
  }
  const markWidth = 3.3 * FONT_SIZE
  const markHeight = markWidth * ratio
  const width = Math.max(markWidth, WORDMARK.advance)
  const textTop = markHeight + 0.6 * FONT_SIZE
  return {
    width,
    height: textTop + FONT_SIZE,
    mark: { x: (width - markWidth) / 2, y: 0, width: markWidth, height: markHeight },
    text: { x: (width - WORDMARK.advance) / 2, y: baselineInLineBox(textTop) },
  }
}
