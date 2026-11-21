import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CommandLine } from '@renderer/components/command-line'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { useCommandQuestion, type CommandQuestion } from './command-confirm-model'
import { UpdateMark } from './update-parts'

/**
 * The commands `confirmCommands` asks to run, mounted once for the window: each program's update
 * command, which can be copied, with Run and Cancel.
 */
export function CommandConfirmDialog() {
  const { t } = useTranslation(['updates', 'common'])
  const cancel = useRef<HTMLButtonElement>(null)
  const question = useCommandQuestion((s) => s.question)
  // The last question stays drawn while the dialog closes.
  const [shown, setShown] = useState<CommandQuestion | null>(null)
  if (question && question !== shown) setShown(question)
  const answer = (run: boolean) => {
    question?.answer(run)
    useCommandQuestion.setState({ question: null })
  }
  const commands = shown?.commands ?? []
  const one = commands.length === 1 ? commands[0] : undefined
  return (
    <AlertDialog open={!!question} onOpenChange={(open) => !open && answer(false)}>
      <AlertDialogContent
        initialFocus={cancel}
        className="gap-0 px-5.5 pt-5 pb-4.5 data-[size=default]:sm:max-w-[460px]"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {one ? t('command.titleOne', { name: one.name }) : t('command.title')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {one ? t('command.bodyOne', { name: one.name }) : t('command.body')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="mt-3.5 flex flex-col gap-2.5">
          {commands.map((entry) => (
            <li key={entry.command} className="flex min-w-0 flex-col gap-1">
              {!one && (
                <span className="flex items-center gap-1.5 text-small text-secondary">
                  <UpdateMark agentId={entry.agentId} size={14} />
                  {entry.name}
                </span>
              )}
              <CommandLine command={entry.command} wrap />
            </li>
          ))}
        </ul>
        <AlertDialogFooter className="mt-4.5">
          <AlertDialogCancel ref={cancel}>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)}>{t('command.run')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
