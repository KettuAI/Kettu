import { describe, expect, it } from 'vitest'
import { orphanedServeSims } from './serve-sim-orphans'

const SCRIPT = '/Users/me/My Apps/Kettu/node_modules/@expo/serve-sim/dist/serve-sim.js'
const UDID = '0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF'
const OTHER = '5A1F3C70-2B7E-4C8D-9E0A-1B2C3D4E5F60'
const NODE =
  '/Applications/Kettu.app/Contents/Frameworks/Kettu Helper.app/Contents/MacOS/Kettu Helper'
const ARGS = '--require-token -q --port 51234 --disable clipboard'

describe('serve-sims left behind by a device host', () => {
  it("finds only this Kettu copy's serve-sim for the simulator that launchd took over", () => {
    const ps = [
      `  101     1 ${NODE} ${SCRIPT} ${UDID} ${ARGS}`,
      // A live device host's own child.
      `  102   900 ${NODE} ${SCRIPT} ${UDID} ${ARGS}`,
      // Another simulator.
      `  103     1 ${NODE} ${SCRIPT} ${OTHER} ${ARGS}`,
      // Another Kettu's copy, and the user's own detached serve-sim.
      `  104     1 ${NODE} /tmp/other/node_modules/@expo/serve-sim/dist/serve-sim.js ${UDID} ${ARGS}`,
      `  105     1 /opt/homebrew/bin/node /usr/local/bin/serve-sim ${UDID} --detach`,
      `  106     1 ${NODE} ${SCRIPT} ${UDID}`,
      `    1     0 /sbin/launchd`,
      '',
    ].join('\n')
    expect(orphanedServeSims(ps, SCRIPT, UDID)).toEqual([101])
  })

  it('finds nothing in output it cannot read', () => {
    expect(orphanedServeSims('', SCRIPT, UDID)).toEqual([])
    expect(orphanedServeSims(`x 1 ${NODE} ${SCRIPT} ${UDID} ${ARGS}`, SCRIPT, UDID)).toEqual([])
  })
})
