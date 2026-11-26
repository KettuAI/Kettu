import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { fadeExit } from '@renderer/lib/motion'
import { Glyph } from '@renderer/features/shell/glyph'
import { WORKFLOW_ICON } from '../new-session/workflow-picks'

/**
 * The note at the top of the composer's box after Edit is clicked on a workflow suggestion card:
 * names the workflow being revised so the user can tell the agent what to change.
 */
export function WorkflowEditStrip({
  workflowName,
  agentName,
  save = false,
  onCancel,
}: {
  workflowName: string
  agentName: string
  save?: boolean
  onCancel: () => void
}) {
  const { t } = useTranslation('composer')
  return (
    <motion.div
      exit={fadeExit}
      role="status"
      aria-live="polite"
      className="kettu-switch flex w-full animate-in flex-wrap items-center gap-x-2.5 gap-y-1.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={WORKFLOW_ICON} className="size-4 shrink-0 text-tertiary" />
      <div className="min-w-0 flex-[1_1_14rem] text-primary">
        <p className="truncate font-medium">{t('workflowEdit.title', { name: workflowName })}</p>
        <p className="text-xs text-tertiary">
          {t(save ? 'workflowEdit.saveHint' : 'workflowEdit.hint', { agent: agentName })}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center">
        <Button size="xs" variant="outline" onClick={onCancel}>
          {t('workflowEdit.cancel')}
        </Button>
      </div>
    </motion.div>
  )
}
