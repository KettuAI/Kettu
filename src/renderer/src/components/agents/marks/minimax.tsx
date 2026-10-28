// MiniMax Code mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
const MINIMAX = 'M2 3h3l3 5 3-5h3v10h-2V6.5l-4 6-4-6V13H2V3Z'

export const viewBox = '0 0 16 16'

/** The mark in `currentColor`, as the ACP Registry ships it. */
export function Body() {
  return <path fill="currentColor" d={MINIMAX} />
}
