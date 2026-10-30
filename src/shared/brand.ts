// The Kettu wordmark and how it pairs with the icon, whose drawing is tools/brand/fox.mjs. The
// renderer draws the lockup through components/brand.tsx; tools/brand builds the images from both.

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
  /** The icon's square canvas, transparent margin included, placed in the lockup. */
  icon: { x: number; y: number; size: number }
  /** Where the wordmark's origin, its baseline at the left edge, sits. */
  text: { x: number; y: number }
}

// The wordmark sits in a line box one font size tall, as text with a line height of 1 does.
function baselineInLineBox(top: number): number {
  const content = WORDMARK.ascent + WORDMARK.descent
  return top + (FONT_SIZE - content) / 2 + WORDMARK.ascent
}

/**
 * The fixed lockups at a font size of 100. Horizontal: the icon is 1.6 font sizes square, 0.4 from
 * the wordmark, both centred vertically. Vertical: 3 square, 0.5 above the wordmark.
 */
export function lockupGeometry(layout: LockupLayout): LockupGeometry {
  if (layout === 'horizontal') {
    const size = 1.6 * FONT_SIZE
    const height = Math.max(size, FONT_SIZE)
    const textX = size + 0.4 * FONT_SIZE
    return {
      width: textX + WORDMARK.advance,
      height,
      icon: { x: 0, y: (height - size) / 2, size },
      text: { x: textX, y: baselineInLineBox((height - FONT_SIZE) / 2) },
    }
  }
  const size = 3 * FONT_SIZE
  const width = Math.max(size, WORDMARK.advance)
  const textTop = size + 0.5 * FONT_SIZE
  return {
    width,
    height: textTop + FONT_SIZE,
    icon: { x: (width - size) / 2, y: 0, size },
    text: { x: (width - WORDMARK.advance) / 2, y: baselineInLineBox(textTop) },
  }
}
