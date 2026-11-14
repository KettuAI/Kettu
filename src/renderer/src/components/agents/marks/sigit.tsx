import { useId } from 'react'
import type { MarkBodyProps } from './index'

// siGit Code mark: https://github.com/getsigit/sigit/blob/main/docs/assets/logo.png (Apache-2.0),
// redrawn as vectors from the raster: the letters traced, the tile and speed lines measured.
const LETTERS =
  'M1675 1246 c-112 -28 -181 -79 -225 -169 -30 -62 -161 -557 -175 -663 -6 -40 -3 -61 13 -97 29 -64 68 -87 153 -87 59 0 71 3 109 32 24 18 51 39 61 46 25 19 56 6 68 -28 9 -27 14 -30 55 -30 33 0 48 5 54 18 18 34 114 442 108 457 -4 12 -26 15 -110 15 -94 0 -106 -2 -116 -19 -14 -28 -12 -57 5 -71 22 -18 19 -53 -14 -169 -19 -67 -37 -112 -52 -127 -61 -60 -139 -30 -139 54 0 50 127 577 161 668 25 67 65 91 118 73 47 -17 55 -68 26 -181 -9 -33 21 -49 88 -47 73 2 90 11 104 54 15 52 16 164 0 192 -41 73 -171 109 -292 79z M1130 1231 c-16 -4 -25 -14 -25 -26 0 -18 8 -20 65 -23 81 -4 110 3 110 27 0 26 -89 39 -150 22z M2250 1231 c-16 -4 -25 -14 -25 -26 0 -18 8 -20 65 -23 81 -4 110 3 110 27 0 26 -89 39 -150 22z M2593 1148 c-6 -7 -16 -32 -22 -55 -12 -45 -34 -73 -56 -73 -22 0 -28 -37 -11 -62 24 -34 21 -50 -49 -333 -93 -375 -93 -378 76 -373 107 3 120 15 75 69 -14 17 -26 41 -26 54 0 29 127 540 140 565 5 10 24 21 41 25 41 9 48 33 18 56 -20 15 -24 26 -24 76 l0 58 -76 3 c-53 2 -79 -1 -86 -10z M550 1047 c-124 -29 -181 -92 -210 -230 -21 -102 -6 -125 145 -227 83 -56 95 -72 95 -127 0 -112 -66 -184 -140 -153 -34 14 -43 36 -44 105 l-1 50 -62 3 c-72 3 -82 -6 -89 -91 -7 -71 9 -97 76 -125 111 -46 291 -14 359 63 38 44 72 135 78 211 5 57 4 62 -27 92 -17 18 -62 50 -100 72 -70 41 -119 89 -121 118 -6 105 35 172 107 172 43 0 64 -27 64 -83 l0 -47 70 0 c66 0 71 1 80 26 13 34 13 90 -1 116 -27 50 -174 79 -279 55z M1050 1018 c-18 -42 -190 -750 -184 -759 3 -5 43 -9 88 -9 82 0 84 1 94 28 17 42 182 715 182 740 0 21 -4 22 -85 22 -79 0 -86 -2 -95 -22z M2170 1018 c-18 -41 -190 -750 -184 -759 3 -5 43 -9 89 -9 l84 0 20 68 c33 112 171 680 171 702 0 19 -6 20 -85 20 -79 0 -86 -2 -95 -22z'
// y, x1, x2 of each speed line, in the 512 px tile.
const LINES = [
  [198, 46, 223],
  [211, 46, 176],
  [227, 38, 178],
  [242, 35, 175],
  [256, 36, 164],
  [278, 31, 161],
  [302, 31, 161],
  [325, 35, 159],
] as const

export const viewBox = '0 0 512 512'

export function Body({ mono }: MarkBodyProps) {
  const id = useId()
  const letters = (dx: number, dy: number, fill: string, stroke?: string) => (
    <g transform={`translate(${150 + dx} ${330 + dy}) scale(0.1 -0.1)`}>
      <path
        d={LETTERS}
        fill={fill}
        stroke={stroke}
        strokeWidth={stroke ? 90 : undefined}
        strokeLinejoin="round"
        paintOrder="stroke"
      />
    </g>
  )
  if (mono) {
    return (
      <g fill="currentColor">
        {LINES.map(([y, x1, x2]) => (
          <rect key={y} x={x1} y={y - 2} width={x2 - x1} height="5" />
        ))}
        {letters(0, 0, 'currentColor')}
      </g>
    )
  }
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="var(--brand-sigit-tile-1)" />
          <stop offset=".5" stopColor="var(--brand-sigit-tile-2)" />
          <stop offset="1" stopColor="var(--brand-sigit-tile-3)" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" fill={`url(#${id})`} />
      {LINES.map(([y, x1, x2]) => (
        <g key={y}>
          <rect x={x1} y={y - 1} width={x2 - x1} height="2.5" fill="var(--brand-sigit-line)" />
          <rect x={x1} y={y + 1.5} width={x2 - x1} height="2.5" fill="var(--brand-sigit-shadow)" />
        </g>
      ))}
      {letters(7, 9, 'var(--brand-sigit-shadow)', 'var(--brand-sigit-shadow)')}
      {letters(0, 0, 'var(--brand-sigit-ink)', 'var(--brand-sigit-glow)')}
    </>
  )
}
