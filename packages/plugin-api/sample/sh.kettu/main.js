// @ts-check
/// <reference path="../../index.d.ts" />

/** The sessions that work or wait, by state. */
exports.digest = async () => {
  const { sessions } = await kettu.call('sessions.list', { limit: 100 })
  /** @type {Record<string, number>} */
  const byState = {}
  for (const session of sessions) byState[session.state] = (byState[session.state] ?? 0) + 1
  return byState
}

/** Posts the digest to a webhook on the one domain the manifest names. */
exports.post = async () => {
  const body = JSON.stringify(await exports.digest())
  const { status } = await kettu.call('network.fetch', 'https://hooks.example.com/digest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return status
}

kettu.on('app.locale', ({ locale }) => console.log(`The interface is now in ${locale}`))

// Hooks: each returns what it adds to a message or why it denies a request, within 500 ms.
kettu.on('session.beforeSend', async () => ({
  attach: [{ title: 'Working sessions', text: JSON.stringify(await exports.digest()) }],
}))

kettu.on('session.permissionRequested', ({ request }) => {
  if (request.command?.includes('rm -rf'))
    return { deny: 'A recursive delete is not allowed here.' }
})
