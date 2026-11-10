import { Cancel01Icon, CheckmarkCircle02Icon, LockIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AnsweredQuestion } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'

/** An ask once answered: how many questions got an answer, and each question over its answer. */
export function AnsweredAsk({
  questions,
  device,
}: {
  questions: AnsweredQuestion[]
  device: string | null
}) {
  const { t } = useTranslation('session')
  const given = questions.filter((q) => q.answered).length
  return (
    <div className="ks-answered" data-kind={given > 0 ? 'done' : 'other'}>
      <div className="ks-answered__head">
        <Icon icon={given > 0 ? CheckmarkCircle02Icon : Cancel01Icon} size={16} />
        <span className="ks-answered__title">
          {given === 0
            ? t('question.skipped')
            : questions.length === 1
              ? t('question.answeredOne')
              : t('question.answered', { answered: given, total: questions.length })}
        </span>
        {device && <span className="ks-answered__device">· {device}</span>}
      </div>
      <ul className="ks-answered__list">
        {questions.map((asked, i) => (
          <li key={i}>
            <span data-selectable="" className="ks-answered__question">
              {asked.question}
            </span>
            {asked.answer !== undefined ? (
              <span data-selectable="" className="ks-answered__answer">
                {asked.answer}
              </span>
            ) : asked.answered ? (
              <span className="ks-answered__answer ks-answered__answer--quiet">
                <Icon icon={LockIcon} size={13} />
                {t('question.secret')}
              </span>
            ) : (
              <span className="ks-answered__answer ks-answered__answer--quiet">
                {t('question.skipped')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
