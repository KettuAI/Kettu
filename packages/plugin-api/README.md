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

| Permission                          | Risk    | Calls                                                             |
| ----------------------------------- | ------- | ----------------------------------------------------------------- |
| none                                |         | `api.version`, `app.locale`, `app.colorMode`                      |
| `network:<domain>`, `network:*.<d>` | normal  | `network.fetch` for that host, or any host under `<d>`            |
| `sessions.summary`                  | normal  | `sessions.list`                                                   |
| `sessions.content`                  | high    | `sessions.read`                                                   |
| `sessions.start`                    | high    | `sessions.start`, `sessions.send`                                 |
| `tools`, `requests.answer`          | various | declared now, calls follow                                        |
| `prompt.attach`, `requests.check`   | caution | the events `session.beforeSend` and `session.permissionRequested` |

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
shows as an error in that view and nothing else.

| Kind      | Data                                                                |
| --------- | ------------------------------------------------------------------- |
| `list`    | `rows` with a title, subtitle, icon, badges, end figure and actions |
| `detail`  | a title, fields and a Markdown `body`                               |
| `form`    | switch, choice and text `fields` and a `submit` action              |
| `actions` | a line of text and the buttons that run the script's actions        |

Every kind may also carry a `scope` for its context bar and `actions` as buttons at its foot. An
action runs the script, or with `open` goes to another view of the plugin; a `destructive` one is
confirmed first. Texts are cut at their limits, rows past 200 are dropped, and any other list past
its limit is refused; `index.d.ts` states the limits. An unknown icon is left out, and a field a later
version adds is ignored.

## Versions

A plugin names the API version it was written for in `api`. Kettu adds calls inside one version and
never changes or removes one; a change that would is a new version, and an older one keeps working
for as long as Kettu lists it.

## Sample

`sample/` is a complete plugin: a manifest and a script that counts the sessions that work and
posts the count to a webhook. `pnpm typecheck` checks its script against `index.d.ts`.
