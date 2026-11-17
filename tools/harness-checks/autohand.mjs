// Autohand Code: its ACP adapter installed from npm as the app installs it, then the adapter
// answers `initialize` and `session/new` either opens a session or asks for a sign-in.

import { acpHandshake } from './acp.mjs'
import { harnessEnv, npmVersions } from './common.mjs'
import { rangeOf } from './kettu.mjs'

export const autohand = {
  id: 'autohand',
  subject: (def) => def.name,

  async versions(def, kettu) {
    const versions = await npmVersions(def.launch.package, rangeOf(def, kettu))
    const known = new Set(versions.map((entry) => entry.version))
    return { versions, inRange: (version) => known.has(version) }
  },

  async check(def, version, ctx) {
    ctx.step = 'install'
    const install = await ctx.installPackage(def.launch.package, version)
    ctx.requireNode(def)
    const env = await harnessEnv(ctx.home, { ...def.env, ...def.launch.env })
    const args = [install.entry, ...(def.launch.args ?? [])]
    await acpHandshake(process.execPath, args, { version, ctx, env })
  },
}
