import { useTranslation } from 'react-i18next'
import type { ChangeStatus } from '@shared/git'
import { cn } from '@renderer/lib/utils'

const LETTERS: Record<ChangeStatus, string> = {
  added: 'A',
  untracked: 'U',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  deleted: 'D',
  conflicted: '!',
}

const TONES: Record<ChangeStatus, string> = {
  added: 'text-success',
  untracked: 'text-success',
  modified: 'text-warning',
  renamed: 'text-warning',
  copied: 'text-warning',
  typechange: 'text-warning',
  deleted: 'text-danger',
  conflicted: 'text-danger',
}

/** A file's uncommitted change, as git's letter after its name. */
export function ChangeBadge({ status }: { status: ChangeStatus }) {
  const { t } = useTranslation('files')
  const label = t(`change.${status}`)
  return (
    <span title={label} className={cn('shrink-0 font-mono text-meta font-semibold', TONES[status])}>
      <span aria-hidden>{LETTERS[status]}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
