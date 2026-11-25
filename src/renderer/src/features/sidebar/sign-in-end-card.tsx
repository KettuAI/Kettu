import { useTranslation } from 'react-i18next'
import { signInEndSentence } from '@renderer/features/agents/sign-in-end'
import { signInTerminal, terminalSignInCommand } from '@renderer/features/agents/sign-in-terminal'
import { CardButton } from '@renderer/features/updates/update-parts'
import { NoticeCard } from '@renderer/features/updates/update-notice'
import { dismissSignInEnd } from '@renderer/stores/sign-in-end-notice'
import { openAgentSettings } from '@renderer/stores/view'
import type { SignInEndCard as Card } from './notices'

/**
 * An agent's sign-in ends within days or probably ended, as the card of an agent that needs
 * sign-in looks; dismissed, it stays away for this sign-in until its date passes.
 */
export function SignInEndCard({ card }: { card: Card }) {
  const { t } = useTranslation('sidebar')
  const { status, end, text } = card
  const command = terminalSignInCommand(status)
  return (
    <NoticeCard
      icon={<span aria-hidden className="size-1.5 rounded-full bg-current text-warning" />}
      // Chinese breaks only at its spaces, so a phrase such as the days left stays whole.
      text={<span className="break-keep">{text}</span>}
      label={text}
      detail={signInEndSentence(end)}
      onOpen={() => openAgentSettings(status.id)}
      action={
        command ? (
          <CardButton primary onClick={() => signInTerminal(status, command)}>
            {t('signInEnds.signIn')}
          </CardButton>
        ) : undefined
      }
      onDismiss={() => dismissSignInEnd(status.id, end.latest, end.phase)}
    />
  )
}
