import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { fadeExit } from '@renderer/lib/motion'
import { Glyph } from '@renderer/features/shell/glyph'

/** The note at the top of the composer's box while a program outside Kettu has the session open. */
export function HeldStrip() {
  const { t } = useTranslation('composer')
  return (
    <motion.div
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in items-center gap-x-2.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={ComputerTerminal01Icon} className="size-4 shrink-0 text-tertiary" />
      <p className="min-w-0 flex-1 text-primary">{t('heldOutside.strip')}</p>
    </motion.div>
  )
}
