import { useId } from 'react'
import type { MarkBodyProps } from './index'

// Google Antigravity mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
// Full-color artwork: https://antigravity.google/press.
const SWOOSH =
  'M14.1452 14.6818C14.9937 15.3182 16.2664 14.894 15.0997 13.7273C11.5998 10.3333 12.3421 1 7.99366 1C3.64518 1 4.3876 10.3333 0.887603 13.7273C-0.385123 15 0.993664 15.3182 1.84215 14.6818C5.13002 12.4545 4.9179 8.5303 7.99366 8.5303C11.0694 8.5303 10.8573 12.4545 14.1452 14.6818Z'

const FILTERS = [
  [4.09591, -44.1761, 111.037, 98.4416, 6.25234],
  [46.2974, -53.0009, 217.731, 215.86, 30.2268],
  [-100.018, -36.7558, 229.238, 204.397, 25.6957],
  [-100.018, -36.7558, 229.238, 204.397, 25.6957],
  [-84.3985, -35.003, 205.042, 204.834, 25.6957],
  [27.9915, 71.5493, 187.691, 190.791, 24.4184],
  [-11.8808, -98.7085, 201.38, 197.45, 22.1301],
  [-44.4432, 19.9522, 252.513, 260.404, 19.7631],
  [81.1915, 25.7722, 140.46, 134.637, 17.6843],
  [55.1499, -47.2531, 187.555, 167.957, 14.9365],
  [-24.2633, -27.1515, 124.223, 146.372, 18.4865],
] as const

export const viewBox = '0 0 16 16'

export function Body({ mono }: MarkBodyProps) {
  const id = useId()
  if (mono) return <path fill="currentColor" d={SWOOSH} />
  return (
    <>
      <defs>
        <mask
          id={`${id}-mask`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="16"
          height="16"
          style={{ maskType: 'alpha' }}
        >
          <path fill="currentColor" d={SWOOSH} />
        </mask>
        {FILTERS.map(([x, y, width, height, blur], index) => (
          <filter
            key={index}
            id={`${id}-${index}`}
            x={x}
            y={y}
            width={width}
            height={height}
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation={blur} />
          </filter>
        ))}
      </defs>
      <path fill="var(--brand-antigravity-blue)" d={SWOOSH} />
      <g mask={`url(#${id}-mask)`}>
        <g transform="translate(-2.17333 -2.18182) scale(.113131)">
          <g filter={`url(#${id}-0)`}>
            <ellipse
              cx="36.6225"
              cy="43.0872"
              rx="36.6225"
              ry="43.0872"
              transform="matrix(-0.112784 0.99362 -0.99362 -0.112781 106.557 -26.4847)"
              fill="var(--brand-antigravity-yellow)"
            />
          </g>
          <g filter={`url(#${id}-1)`}>
            <ellipse
              cx="155.163"
              cy="54.9292"
              rx="47.4118"
              ry="48.4541"
              transform="rotate(76.9243 155.163 54.9292)"
              fill="var(--brand-antigravity-red)"
            />
          </g>
          <g filter={`url(#${id}-2)`}>
            <ellipse
              cx="14.6006"
              cy="65.4425"
              rx="49.5515"
              ry="64.192"
              transform="rotate(74.1257 14.6006 65.4425)"
              fill="var(--brand-antigravity-green)"
            />
          </g>
          <g filter={`url(#${id}-3)`}>
            <ellipse
              cx="14.6006"
              cy="65.4425"
              rx="49.5515"
              ry="64.192"
              transform="rotate(74.1257 14.6006 65.4425)"
              fill="var(--brand-antigravity-green)"
            />
          </g>
          <g filter={`url(#${id}-4)`}>
            <ellipse
              cx="18.1226"
              cy="67.414"
              rx="48.5679"
              ry="53.4688"
              transform="rotate(45.6065 18.1226 67.414)"
              fill="var(--brand-antigravity-green)"
            />
          </g>
          <g filter={`url(#${id}-5)`}>
            <ellipse
              cx="121.837"
              cy="166.945"
              rx="46.6356"
              ry="44.9084"
              transform="rotate(76.9243 121.837 166.945)"
              fill="var(--brand-antigravity-blue)"
            />
          </g>
          <g filter={`url(#${id}-6)`}>
            <ellipse
              cx="53.9456"
              cy="56.8997"
              rx="53.9456"
              ry="56.8997"
              transform="matrix(-0.409539 0.912293 -0.912294 -0.409537 162.811 -25.895)"
              fill="var(--brand-antigravity-amber)"
            />
          </g>
          <g filter={`url(#${id}-7)`}>
            <path
              d="M4.21557 239.063C-25.3231 227.467 25.1577 132.061 37.7105 100.085C50.2634 68.1097 84.3853 51.5888 113.924 63.1848C143.463 74.7809 178.474 138.65 165.921 170.626C153.368 202.601 33.7543 250.659 4.21557 239.063Z"
              fill="var(--brand-antigravity-blue)"
            />
          </g>
          <g filter={`url(#${id}-8)`}>
            <path
              d="M183.197 120.315C175.289 129.545 154.652 124.839 137.102 109.803C119.553 94.7668 111.738 75.0955 119.646 65.8656C127.554 56.6357 148.191 61.3423 165.74 76.3782C183.289 91.414 191.105 111.085 183.197 120.315Z"
              fill="var(--brand-antigravity-violet)"
            />
          </g>
          <g filter={`url(#${id}-9)`}>
            <ellipse
              cx="148.928"
              cy="36.7252"
              rx="71.1018"
              ry="44.199"
              transform="rotate(34.0763 148.928 36.7252)"
              fill="var(--brand-antigravity-red)"
            />
          </g>
          <g filter={`url(#${id}-10)`}>
            <ellipse
              cx="37.848"
              cy="46.0346"
              rx="38.1008"
              ry="22.1575"
              transform="rotate(112.516 37.848 46.0346)"
              fill="var(--brand-antigravity-pale-yellow)"
            />
          </g>
        </g>
      </g>
    </>
  )
}
