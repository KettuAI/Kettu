# Kettu plugin API

Types for the scripts of Kettu plugins, API version 1. The package is not published; it lives here
so the API and its types change together.

A plugin script runs in its own sandbox on the host with one global, `kettu`: `kettu.call(name,
...args)` resolves with a call's result and `kettu.on(name, listener)` listens to an event. Nothing
else of Kettu is reachable. `index.d.ts` lists every call and event.

## Permissions

A manifest asks for permissions under `extensions["sh.kettu"].permissions`, and a script may use
only the calls of the permissions the user agreed to for the installed version. A call without its
permission fails with an error that names it.

| Permission                          | Risk    | Calls                                                                                                        |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| none                                |         | `api.version`, `app.locale`, `app.colorMode`, `settings.get`, `settings.secret`, `storage.*`, `random.bytes` |
| `network:<domain>`, `network:*.<d>` | normal  | `network.fetch` for that host, or any host under `<d>`                                                       |
| `sessions.summary`                  | normal  | `sessions.list`                                                                                              |
| `sessions.content`                  | high    | `sessions.read`                                                                                              |
| `sessions.start`                    | high    | `sessions.start`, `sessions.send`                                                                            |
| `tools`                             | normal  | the functions the manifest's `tools` name, which agents call                                                 |
| `requests.answer`                   | high    | `requests.answer`; the commands and paths of the requests a channel tells it of                              |
| `prompt.attach`, `requests.check`   | caution | `session.beforeSend` and `session.permissionRequested`; with `prompt.attach`, `@` sources                    |

## Tools, settings and storage

A plugin with the `tools` permission lists its tools in its manifest under `tools`: a name, a
description and the arguments each takes (strings, numbers, integers and booleans). The script
exports a function of the same name; Kettu lists the tool on its MCP service as `<plugin>__<tool>`
for every agent, asks about a call as it does for any tool, and answers the agent with an error
when the script throws, crashes or runs past its time limit. Tools go when the plugin is turned
off or removed.

The settings a manifest declares under `settings` (switches, choices, short texts and secrets) get
a page in Settings › Plugins and are listed for agents, who may change all but the secrets. A
script reads them with `settings.get` and `settings.secret`, and hears of a change as
`settings.changed`. A secret is kept in the system's key store and shown only as set or not set.

Each plugin also has a small storage of its own, read and written with `storage.get`,
`storage.set`, `storage.delete` and `storage.keys`: at most 256 KB of JSON and 1,000 keys. It is
removed with the plugin.

The sandbox has no source of randomness but `Math.random`, which is no good for a secret.
`random.bytes(length)` gives 1 to 256 bytes from the system's cryptographic source as lowercase
hex, so `2 * length` characters, and needs no permission.

## When a script runs

The first thing that wakes a plugin loads its script into a sandbox: an event, view, Search action,
mention source, kind of link, tool or notification channel that its manifest declares. A load runs
the script from the top, so whatever is outside a listener runs again each time. Once loaded, the
sandbox stays loaded between calls, with its variables and its pending timers, until one of these:

- the plugin is turned off, removed, updated, rolled back or reloaded from its folder;
- the script passes a limit, which stops it: a call, listener or timer callback that runs too long
  without yielding (2 seconds, 500 ms for the two hooks that answer in 500 ms) or memory past
  64 MB. Three such stops in a minute turn the plugin off until the user turns it on again;
- Kettu's plugin host or agent host restarts, as when the app quits or is updated, or crashes.

Nothing unloads a script for being idle, and a timer neither keeps a script loaded nor drops it:
Kettu stops its plugin host only when no script is loaded. So a script that polls with
`setTimeout` can rely on staying loaded for as long as none of the above happens, and on nothing
more. Its timers and everything in memory go with the sandbox, which no listener can see coming,
and a script that was dropped runs again only when something it declares wakes it. A script that
must keep going therefore starts its timers from code a declared trigger runs, keeps what it needs
to resume in `storage`, and reads that when it loads. A script holds at most 256 pending timers
and 256 calls that have not been answered.

## Events

Besides `app.locale` and `app.colorMode`, Kettu sends its own events to the plugins that name them in
`extensions["sh.kettu"].events` and hold the permission each needs, and loads a plugin's script only
when one of them happens. Every event is listed in `index.d.ts` with its permission and payload.
Events come only from sessions the user works in, and a plugin never gets what was said in a
session without `sessions.content`.

Two events are hooks, whose listeners answer within 500 ms or are skipped: `session.beforeSend`
lets a plugin attach content to a message, never change it, and `session.permissionRequested` lets
it deny a request for a tool, never allow it. The second is not sent in Full access, where the
agent does not ask.

Whatever is granted, a script cannot run commands, read project files, ask for system permissions,
read an agent's or GitHub's credentials, reach another plugin's data or touch Kettu's window.

## Views

A manifest declares views under `extensions["sh.kettu"].views`, each with an `id`, a `kind` (`list`,
`detail`, `form` or `actions`), a `title` by language and optionally a `description` and an `icon`.
A plugin that declares views needs a script. Opening a view wakes the script, which answers the
`view.data` hook with the data of the declared kind, and an action the user runs reaches its
`view.action` hook. Neither needs a permission. Kettu checks the answer and draws it with its own
components, in the desktop app and in the web client, so a script only gives data and never
draws; an answer that does not fit, a script that throws or one that is not done in 30 seconds
shows as an error in that view and nothing else. A script that throws is shown its own message,
as plain text cut at 300 characters, so a thrown `Error` should say what the user can do. A request
that fails before it reaches the script says so, and not that plugins are not running.

| Kind      | Data                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| `list`    | `rows` with a title, subtitle, icon, badges, end figure and actions                       |
| `detail`  | a title, fields and a Markdown `body`                                                     |
| `form`    | switch, choice and text `fields` and a `submit` action                                    |
| `actions` | a line of text, whose line breaks are kept, and the buttons that run the script's actions |

Line breaks are kept in the text of an `actions` view, a row's `subtitle` (up to three lines), a
`detail` view's `subtitle` and the `value` of its fields; a `detail` view's `body` is Markdown and
follows Markdown's own rules.

Every kind may also carry a `scope` for its context bar and `actions` as buttons at its foot. An
action runs the script, or with `open` goes to another view of the plugin; a `destructive` one is
confirmed first. Texts are cut at their limits, rows past 200 are dropped, and any other list past
its limit is refused; `index.d.ts` states the limits. An unknown icon is left out, and a field a later
version adds is ignored.

## Panes and Search actions

A view with `"pane": true` is also a pane: the side panel lists it under its title, with the plugin's
icon, and opens it as a tab of the session's panel, drawn like any view. Opening one wakes the script
as `view.data` does, and a pane of a plugin that is turned off or removed shows that view's error.

A manifest may declare `actions` for Search, each with an `id`, a `title` by language of at most 60
characters and optionally a `description` and an `icon`. Search lists them in a group of their own,
named for the plugin. Running one wakes the script and calls its `action.run` listener, which needs
no permission and answers like `view.action`: nothing means it went well, `notice` is shown, `error`
refuses it, and `open` names a pane of the plugin, which opens in the side panel of the session in
view. A plugin that declares actions needs a script.

```json
"views": [{ "id": "issues", "kind": "list", "title": "Issues", "icon": "list", "pane": true }],
"actions": [{ "id": "show-issues", "title": "Show my issues", "icon": "list" }]
```

## Mentions and links

A manifest may declare sources for the composer's `@` menu under `extensions["sh.kettu"].mentions`,
each with an `id`, a `title` by language and optionally an `icon`, and needs `prompt.attach` and a
script. Typing an `@` wakes the script, which answers `mention.search` with up to 20 items; the
menu shows them in a group of the plugin's own beside the project's files, and never waits for
them. A chosen item is written as `@word` and drawn as a chip. When the message is sent the script
answers `mention.content` with the text the agent reads, which the thread shows under the message
as the plugin's attachment; one that does not answer in time is said to the agent as left out, and
a message holds up to 10 items and 48,000 characters of them.

Under `links` a manifest declares kinds of link, each with an `id`, `patterns` and optionally an
`icon`. A pattern is `https://host/path` where a segment is a literal, `*` for any one segment,
`{name}` for one the script is told, and a last `**` for the rest; a host is a name or `*.name`. It
may name only hosts the plugin holds a `network:` permission for, so a plugin hears of addresses
only on hosts it may connect to. A link of a reply that a pattern names is drawn as a reference
once the script has answered `link.card` with a title, a label, badges and fields; until then and
when it does not, the link stays as it was. Neither answer needs a permission beyond those above.
A script that throws is shown its own message as plain text cut at 300 characters, under `@` for a
source and on hover for a link that stays plain.

## Notification channels

A plugin with a script may declare channels under `extensions["sh.kettu"].channels`: an `id`, a
`title` and an optional `description`. On the plugin's page in Settings the user picks which kinds
of Kettu's notices go to each channel, none by default. A notice reaches the script as the
`channel.notice` event, with its channel, kind and title. What a notice says, and the session it
names, come only with `sessions.content`; without it the title is a plain one for the kind.
Delivery waits in the plugin's queue and is held to the time limit of a call, so a slow channel
never delays Kettu's own notice.

```json
"channels": [{ "id": "chat", "title": { "en": "Team chat", "zh-CN": "团队聊天" } }]
```

A plugin with `requests.answer` is also told what a permission request that waits asks for: its
`request` has the `id`, and the `tool`, `kind`, `command` and `paths` that `session.permissionRequested`
gives, and the notice's title is the session's. This permission therefore receives the commands an
agent asks to run, which Kettu says when the plugin is installed. The plugin may answer once with
`kettu.call('requests.answer', { request, decision, from })`. The decision is `allow_once` or `deny`,
never always allow, and the call fails for a request that no longer waits or that no notice told
the plugin of in this way. Questions and plans are never answered this way. The thread shows the
answer as given from `from` and relayed by the plugin.

## Versions

A plugin names the API version it was written for in `api`. Kettu adds calls inside one version and
never changes or removes one; a change that would is a new version, and an older one keeps working
for as long as Kettu lists it.

## Sample

`sample/` is a complete plugin: a manifest and a script that counts the sessions that work and
posts the count to a webhook. `pnpm typecheck` checks its script against `index.d.ts`.

## License

This folder, the types, this README and the sample, is under the [MIT license](./LICENSE), so a plugin may copy `index.d.ts` into its own repository. The rest of Kettu is under AGPL-3.0.
