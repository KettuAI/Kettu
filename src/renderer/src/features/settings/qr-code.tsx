import { useMemo } from 'react'
import { cn } from '@renderer/lib/utils'
import { qrPath } from './qr-path'

/** `text` as a QR code, dark on the canvas in both themes, so a camera can read it. */
export function QrCode({
  text,
  label,
  className,
}: {
  text: string
  label: string
  className?: string
}) {
  const { size, path } = useMemo(() => qrPath(text), [text])
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn('fill-canvas-ink', className)}
    >
      <path d={path} />
    </svg>
  )
}
