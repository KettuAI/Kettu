import { useTranslation } from 'react-i18next'
import type { ChangeStatus } from '@shared/git'
import { cn } from '@renderer/lib/utils'

// A new file reads as added whether or not it is staged yet, as the agents leave most of them.
const LETTERS: Record<ChangeStatus, string> = {
  added: 'A',
  untracked: 'A',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  deleted: 'D',
  conflicted: '!',
}

const TONES: Record<ChangeStatus, string> = {
  added: 'bg-success/12 text-success',
  untracked: 'bg-success/12 text-success',
  modified: 'bg-warning/12 text-warning',
  renamed: 'bg-warning/12 text-warning',
  copied: 'bg-warning/12 text-warning',
  typechange: 'bg-warning/12 text-warning',
  deleted: 'bg-danger/12 text-danger',
  conflicted: 'bg-danger/12 text-danger',
}

/** A file's uncommitted change, as git's letter on a tile of its tone. */
export function ChangeBadge({ status, className }: { status: ChangeStatus; className?: string }) {
  const { t } = useTranslation('files')
  const label = t(`change.${status}`)
  return (
    <span
      title={label}
      className={cn(
        'flex size-3.75 shrink-0 items-center justify-center rounded-md text-badge font-bold',
        TONES[status],
        className,
      )}
    >
      <span aria-hidden>{LETTERS[status]}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
