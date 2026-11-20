import { useEffect, useState } from 'react'
import { useDark } from '@renderer/hooks/use-dark'
import { cn } from '@renderer/lib/utils'

// A site's icon is one image for both themes. A flat mark with no ground of its own, such as
// GitHub's black one, vanishes on the other theme, so it is drawn lightness-inverted there. An
// icon that fills its own tile reads on either theme and is left as it is, and an SVG that adapts
// itself is judged as drawn, so it is left alone too.

const SAMPLE = 32
/** The share of pixels that must be see-through, which an icon with a tile of its own lacks. */
const MIN_CLEAR = 0.1
/** The share of the solid pixels that must read poorly on the theme's ground. */
const MIN_POOR = 0.85
/** CIE lightness (0 to 100) under which a pixel is dark, and over which it is light. */
const DARK_BELOW = 35
const LIGHT_ABOVE = 85
// Lightness is judged on linear light, so a saturated red or blue is not taken for a dark pixel.
const LINEAR = Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
})

const verdicts = { dark: new Map<string, boolean>(), light: new Map<string, boolean>() }
const reading = {
  dark: new Map<string, Promise<boolean>>(),
  light: new Map<string, Promise<boolean>>(),
}

let canvas: CanvasRenderingContext2D | null = null

function context(): CanvasRenderingContext2D | null {
  if (canvas) return canvas
  const element = document.createElement('canvas')
  element.width = SAMPLE
  element.height = SAMPLE
  canvas = element.getContext('2d', { willReadFrequently: true })
  return canvas
}

/** Whether an icon's pixels (RGBA) are a flat mark that reads poorly on the dark or light theme. */
function poorOnTheme(pixels: Uint8ClampedArray, dark: boolean): boolean {
  let clear = 0
  let solid = 0
  let poor = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3]! < 128) {
      clear++
      continue
    }
    solid++
    const y =
      0.2126 * LINEAR[pixels[i]!]! +
      0.7152 * LINEAR[pixels[i + 1]!]! +
      0.0722 * LINEAR[pixels[i + 2]!]!
    const lightness = y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y
    if (dark ? lightness < DARK_BELOW : lightness > LIGHT_ABOVE) poor++
  }
  return solid > 0 && clear / (pixels.length / 4) >= MIN_CLEAR && poor / solid >= MIN_POOR
}

async function judge(src: string, dark: boolean): Promise<boolean> {
  const ctx = context()
  if (!ctx) return false
  try {
    const image = new Image()
    image.src = src
    await image.decode()
    ctx.clearRect(0, 0, SAMPLE, SAMPLE)
    ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE)
    return poorOnTheme(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data, dark)
  } catch {
    return false
  }
}

function verdict(src: string, dark: boolean): Promise<boolean> {
  const mode = dark ? 'dark' : 'light'
  let pending = reading[mode].get(src)
  if (!pending) {
    pending = judge(src, dark).then((flip) => {
      verdicts[mode].set(src, flip)
      reading[mode].delete(src)
      return flip
    })
    reading[mode].set(src, pending)
  }
  return pending
}

function useFlip(src: string, dark: boolean): boolean {
  const cache = verdicts[dark ? 'dark' : 'light']
  const [read, setRead] = useState<{ src: string; dark: boolean; flip: boolean } | null>(null)
  useEffect(() => {
    if (cache.has(src)) return
    let live = true
    void verdict(src, dark).then((flip) => {
      if (live) setRead({ src, dark, flip })
    })
    return () => {
      live = false
    }
  }, [cache, src, dark])
  if (read && read.src === src && read.dark === dark) return read.flip
  return cache.get(src) ?? false
}

/** A site's icon, drawn so it stays legible on the theme shown. `src` is a recorded icon. */
export function SiteIconImage({ src, className }: { src: string; className?: string }) {
  const flip = useFlip(src, useDark())
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cn(className, flip && 'invert hue-rotate-180')}
    />
  )
}
