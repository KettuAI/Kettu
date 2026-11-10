import type { ToolEntry } from '@shared/thread'
import { ElicitationForm } from '../entries/elicitation-card'
import { fieldError, siteOf, startValues, toValues, webUrl } from '../entries/elicitation-model'
import { respondToPermission, respondWithValues } from '../entries/helpers'
import { openLinkIn } from '../open-link'
import type { Ask, AskContext } from './ask'

/**
 * An MCP server's request on the Decision Card. A form holds its fields, then Submit, which waits
 * until they are valid, and Decline; a page to open names the site and address, then Open and
 * Decline. Neither takes words of the user's own.
 */
export function elicitationAsk(entry: ToolEntry, ctx: AskContext): Ask {
  const { t, sessionId, agentName } = ctx
  const { requestId, options, elicitation } = entry.permission!
  const request = elicitation!
  const decline = options.find((o) => o.kind === 'reject_once')
  const task = `${request.server} · ${t('elicitation.inAgent', { agent: agentName })}`
  const declineRow = decline ? [{ id: decline.id, title: t('elicitation.decline') }] : []
  const declineIt = () => {
    if (decline) {
      void ctx.go(requestId, () => respondToPermission(sessionId, requestId, decline.id))
    }
  }
  if (request.kind === 'form') {
    const [draft, setDraft] = ctx.state(`${requestId}:draft`, startValues(request.fields))
    const [touched, setTouched] = ctx.state<Record<string, true>>(`${requestId}:touched`, {})
    const errors = request.fields.map((field) => fieldError(field, draft[field.key], t))
    const first = errors.findIndex((e) => e !== null)
    return {
      key: requestId,
      group: requestId,
      decision: {
        task,
        question: request.message || t('decision.form', { server: request.server }),
        content: (
          <ElicitationForm
            fields={request.fields}
            draft={draft}
            touched={touched}
            onChange={(key, value) => {
              setDraft({ ...draft, [key]: value })
              setTouched({ ...touched, [key]: true })
            }}
          />
        ),
        options: [
          {
            id: 'submit',
            title: t('elicitation.submit'),
            summary:
              first < 0
                ? t('elicitation.sentTo', { server: request.server })
                : `${request.fields[first]!.title}: ${errors[first]}`,
            disabled: first >= 0,
          },
          ...declineRow,
        ],
        own: false,
      },
      answer: (answer) => {
        if (typeof answer !== 'object') return
        if (answer.option === 'submit' && first < 0) {
          void ctx.go(requestId, () =>
            respondWithValues(sessionId, requestId, toValues(request.fields, draft)),
          )
        } else if (answer.option === decline?.id) declineIt()
      },
    }
  }
  const accept = options.find((o) => o.kind === 'allow_once')
  const site = siteOf(request.url)
  const usable = webUrl(request.url) !== null
  return {
    key: requestId,
    group: requestId,
    decision: {
      task,
      question: request.message || t('decision.link', { server: request.server }),
      facts: [
        { label: t('decision.fact.site'), value: site },
        { label: t('decision.fact.address'), value: request.url },
      ],
      options: [
        ...(accept
          ? [
              {
                id: accept.id,
                title: t('elicitation.open', { site }),
                summary: t('elicitation.opensInBrowser'),
                disabled: !usable,
              },
            ]
          : []),
        ...declineRow,
      ],
      own: false,
    },
    answer: (answer) => {
      if (typeof answer !== 'object') return
      if (accept && usable && answer.option === accept.id) {
        void ctx
          .go(requestId, () => respondToPermission(sessionId, requestId, accept.id))
          .then((sent) => {
            if (sent) openLinkIn(request.url, 'browser', null)
          })
      } else if (answer.option === decline?.id) declineIt()
    },
  }
}
