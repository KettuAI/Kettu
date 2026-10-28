// Kimchi mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
const KIMCHI = 'M3 1h2.5v5.5L9 1h3L8.5 6.5 12.5 13H9.5L6 8v5H3V1z'

export const viewBox = '0 0 16 16'

/** The mark in `currentColor`, as the ACP Registry ships it. */
export function Body() {
  return <path fill="currentColor" d={KIMCHI} />
}
