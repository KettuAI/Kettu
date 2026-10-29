// The Kettu mark and wordmark. The renderer draws
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
 * "Kettu" in Manrope SemiBold at a font size of 100, tracked -1%, as outlines so it needs no
 * font. The baseline is y = 0.
 */
export const WORDMARK = {
  path: 'M7 0V-72H17.45V-38.4L47.6 -72H60.6L28.75 -36.85L62.95 0H49.55L17.45 -34.4V0ZM88.9 1.5Q80.85 1.5 74.78 -2.03Q68.7 -5.55 65.33 -11.87Q61.95 -18.2 61.95 -26.55Q61.95 -35.4 65.28 -41.9Q68.6 -48.4 74.55 -51.95Q80.5 -55.5 88.4 -55.5Q96.65 -55.5 102.45 -51.67Q108.25 -47.85 111.13 -40.8Q114 -33.75 113.4 -24.05H102.95V-27.85Q102.85 -37.25 99.38 -41.75Q95.9 -46.25 88.8 -46.25Q80.95 -46.25 77 -41.3Q73.05 -36.35 73.05 -27Q73.05 -18.1 77 -13.23Q80.95 -8.35 88.4 -8.35Q93.3 -8.35 96.88 -10.57Q100.45 -12.8 102.45 -16.95L112.7 -13.7Q109.55 -6.45 103.15 -2.47Q96.75 1.5 88.9 1.5ZM69.65 -24.05V-32.2H108.2V-24.05ZM154.5 0Q149.4 1 144.5 0.85Q139.6 0.7 135.75 -1.05Q131.9 -2.8 129.95 -6.55Q128.2 -9.9 128.08 -13.37Q127.95 -16.85 127.95 -21.25V-69H138.45V-21.75Q138.45 -18.5 138.53 -16.1Q138.6 -13.7 139.55 -12.05Q141.35 -8.95 145.28 -8.52Q149.2 -8.1 154.5 -8.85ZM117.6 -45.6V-54H154.5V-45.6ZM195.75 0Q190.65 1 185.75 0.85Q180.85 0.7 177 -1.05Q173.15 -2.8 171.2 -6.55Q169.45 -9.9 169.33 -13.37Q169.2 -16.85 169.2 -21.25V-69H179.7V-21.75Q179.7 -18.5 179.78 -16.1Q179.85 -13.7 180.8 -12.05Q182.6 -8.95 186.53 -8.52Q190.45 -8.1 195.75 -8.85ZM158.85 -45.6V-54H195.75V-45.6ZM226.45 1.45Q220.85 1.45 217.05 -0.35Q213.25 -2.15 210.88 -5.07Q208.5 -8 207.25 -11.45Q206 -14.9 205.55 -18.2Q205.1 -21.5 205.1 -24V-54H215.7V-27.45Q215.7 -24.3 216.23 -20.97Q216.75 -17.65 218.23 -14.8Q219.7 -11.95 222.38 -10.2Q225.05 -8.45 229.35 -8.45Q232.15 -8.45 234.65 -9.37Q237.15 -10.3 239.03 -12.35Q240.9 -14.4 241.98 -17.75Q243.05 -21.1 243.05 -25.9L249.55 -23.45Q249.55 -16.1 246.8 -10.48Q244.05 -4.85 238.9 -1.7Q233.75 1.45 226.45 1.45ZM244.3 0V-15.6H243.05V-54H253.6V0Z',
  advance: 260.6,
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
