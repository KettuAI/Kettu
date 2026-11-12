import { useId } from 'react'
import type { MarkBodyProps } from './index'

// Gemini CLI mark: https://geminicli.com/brandassets/gemini-cli-icon_full-color.svg (Apache-2.0).
// Copyright 2025 Google LLC.
const TERMINAL =
  'M419.776 0.00781248C470.82 0.654592 512 42.2332 512 93.4296V418.572L511.992 419.776C511.344 470.82 469.768 512 418.572 512H93.4296C41.83 512 0.00052574 470.168 0 418.572V93.4296C0.000523248 42.2332 41.1792 0.654596 92.2228 0.00781248L93.4296 0H418.572L419.776 0.00781248ZM93.4296 29.8984C58.3424 29.899 29.899 58.3424 29.8984 93.4296V418.572C29.899 453.656 58.3424 482.1 93.4296 482.1H418.572C453.656 482.1 482.1 453.656 482.1 418.572V93.4296C482.1 58.3424 453.656 29.899 418.572 29.8984H93.4296ZM357.926 223.129V301.274L154.754 398.949V342.297L321.199 262.199L154.754 182.106V125.453L357.926 223.129Z'

export const viewBox = '0 0 512 512'

export function Body({ mono }: MarkBodyProps) {
  const id = useId()
  return (
    <>
      {!mono && (
        <>
          <defs>
            <linearGradient
              id={id}
              x1="0"
              y1="257.869"
              x2="512"
              y2="257.869"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="var(--brand-gemini-1)" />
              <stop offset=".335283" stopColor="var(--brand-gemini-2)" />
              <stop offset=".7" stopColor="var(--brand-gemini-3)" />
              <stop offset="1" stopColor="var(--brand-gemini-4)" />
            </linearGradient>
          </defs>
          <path
            d="M418.569 0H93.4308C41.8304 0 0 41.8304 0 93.4308V418.569C0 470.17 41.8304 512 93.4308 512H418.569C470.17 512 512 470.17 512 418.569V93.4308C512 41.8304 470.17 0 418.569 0Z"
            fill="var(--brand-gemini-tile)"
          />
        </>
      )}
      <path fill={mono ? 'currentColor' : `url(#${id})`} d={TERMINAL} />
    </>
  )
}
