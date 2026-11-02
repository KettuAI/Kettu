import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

/** A picture's or a clip's frame in a reply: 8 px corners and a faint drop. */
export const FRAME = 'relative overflow-hidden rounded-code bg-card shadow-media'

/** The widest a picture, a clip or a grid shows in a reply; the viewer shows them whole. */
export const MEDIA_MAX_WIDTH = 600

/**
 * The frame's 1 px ring, drawn over what it holds, since an inset shadow would go under it; it
 * darkens while the frame's `group/media` is pointed at.
 */
export function FrameRing({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] transition-shadow duration-(--duration-fast) group-hover/media:shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
        className,
      )}
    />
  )
}

/** The line under a picture or a clip, 6 px below it, as wide as the frame and no wider. */
export function FrameCaption({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="mt-1.5 block w-0 min-w-full truncate text-hint text-tertiary tabular"
    >
      {children}
    </span>
  )
}
