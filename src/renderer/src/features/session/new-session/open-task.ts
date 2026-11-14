import { openMarketplace } from '@renderer/stores/view'

export { openTask } from '@renderer/stores/view'

/** Shows a workflow's own Marketplace page, where it is approved and its steps pinned. */
export function openSopMarketplace(sopId: string): void {
  openMarketplace({ item: `sop:${sopId}` })
}
