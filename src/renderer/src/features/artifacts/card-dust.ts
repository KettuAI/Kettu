import { dissolve, inSight, type Piece } from '@renderer/lib/dust'

/**
 * Deletes an artifact through `remove`, its card in sight on the Artifacts page first turning to
 * dust; the card keeps its place until the sweep has passed it, so the cards after it never move
 * under the sweep. The card comes back when `remove` fails. Without a card in sight, or where
 * there is no dust, it deletes at once.
 */
export async function removeCard(id: string, remove: () => Promise<void>): Promise<void> {
  const dust = await dissolve({
    find: () => cardsOf(id),
    most: 1,
    // A card has many more pixels than a sidebar row: one particle a CSS pixel keeps it smooth.
    step: Math.max(1, Math.round(window.devicePixelRatio || 1)),
    hide: (card) => {
      card.el.dataset.dust = ''
    },
    what: 'the artifact card',
  })
  if (!dust) return remove()
  await new Promise((resolve) => setTimeout(resolve, dust.passed(0)))
  try {
    await remove()
  } catch (error) {
    for (const [i, card] of dust.pieces.entries()) {
      dust.stop(i)
      delete card.el.dataset.dust
    }
    throw error
  }
}

function cardsOf(id: string): Piece[] {
  const card = document
    .querySelector(`[data-artifact-card="${CSS.escape(id)}"]`)
    ?.closest<HTMLElement>('.k-art')
  const box = card && inSight(card)
  return card && box ? [{ el: card, box }] : []
}
