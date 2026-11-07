// Lucide's Split, https://lucide.dev/icons/split (ISC License, Copyright (c) Lucide Contributors).

/** Fork's icon: Split turned to branch off to the right, at 1.9; Hugeicons has none like it. */
export function ForkIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <g transform="rotate(90 12 12)">
        <path d="M16 3h5v5" />
        <path d="M8 3H3v5" />
        <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
        <path d="m15 9 6-6" />
      </g>
    </svg>
  )
}
