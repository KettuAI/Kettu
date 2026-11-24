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

// Views: `view.data` answers with what a view shows, in the shape of the kind the manifest gives it.
kettu.on('view.data', async ({ view, params }) => {
  const byState = await exports.digest()
  if (view === 'states') {
    return {
      rows: Object.entries(byState).map(([state, count]) => ({
        id: state,
        title: state,
        end: String(count),
        actions: [{ id: 'open', label: 'Details', open: { view: 'state', params: { state } } }],
      })),
      empty: { title: 'No sessions yet' },
    }
  }
  if (view === 'state') {
    return {
      title: params.state,
      fields: [{ label: 'Sessions', value: String(byState[params.state ?? ''] ?? 0) }],
      body: `Sessions that are **${params.state}** now.`,
    }
  }
  if (view === 'label') {
    return {
      fields: [{ type: 'text', key: 'label', label: 'Label', value: 'digest', required: true }],
      submit: { id: 'save', label: 'Save', primary: true },
    }
  }
  return {
    text: 'Send the digest to the webhook.',
    actions: [{ id: 'post', label: 'Post now', primary: true }],
  }
})

// An action's answer is a notice to show, or an error that refuses it.
kettu.on('view.action', async ({ action }) => {
  if (action === 'post') return { notice: `Posted, the webhook answered ${await exports.post()}` }
  if (action === 'save') return { notice: 'Saved' }
  return { error: `No action ${action}` }
})

// Search actions: `action.run` answers like an action of a view. `open` names a pane the manifest
// marks, which opens in the side panel.
kettu.on('action.run', async ({ action }) => {
  if (action === 'show-states') return { open: { view: 'states' } }
  if (action === 'post-now')
    return { notice: `Posted, the webhook answered ${await exports.post()}` }
  return { error: `No action ${action}` }
})

// Mentions: `mention.search` lists what an `@` offers, and `mention.content` gives what the item
// the user chose adds to the message.
kettu.on('mention.search', async ({ query }) => {
  const byState = await exports.digest()
  const wanted = query.trim().toLowerCase()
  return {
    items: Object.entries(byState)
      .filter(([state]) => state.includes(wanted))
      .map(([state, count]) => ({
        id: state,
        title: state,
        subtitle: 'sessions',
        end: String(count),
      })),
  }
})

kettu.on('mention.content', async ({ item }) => {
  const byState = await exports.digest()
  return {
    title: `Sessions that are ${item}`,
    text: `${byState[item] ?? 0} sessions are ${item} now.`,
  }
})

// Links: `link.card` gives the card an address of a declared pattern shows in a reply.
kettu.on('link.card', async ({ match }) => {
  const byState = await exports.digest()
  return {
    label: match.state,
    title: `Sessions that are ${match.state}`,
    badges: [{ text: String(byState[match.state ?? ''] ?? 0), tone: 'info' }],
  }
})
