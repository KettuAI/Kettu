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

const TONES: Record<ChangeStatus, 'added' | 'modified' | 'deleted'> = {
  added: 'added',
  untracked: 'added',
  modified: 'modified',
  renamed: 'modified',
  copied: 'modified',
  typechange: 'modified',
  deleted: 'deleted',
  conflicted: 'deleted',
}

/** A file's uncommitted change, as git's letter on a tile of its tone. */
export function ChangeBadge({ status, className }: { status: ChangeStatus; className?: string }) {
  const { t } = useTranslation('files')
  const label = t(`change.${status}`)
  return (
    <span title={label} data-tone={TONES[status]} className={cn('kp-badge', className)}>
      <span aria-hidden>{LETTERS[status]}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
