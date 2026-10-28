// Stakpak mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
const STEP = 'M6.53 4.412h5.883v3.587H9.471v3.588H3.588V7.999H6.53Z'

export const viewBox = '0 0 16 16'

/** The mark in `currentColor`, at every size. */
export function Body() {
  return <path fill="currentColor" d={STEP} />
}
