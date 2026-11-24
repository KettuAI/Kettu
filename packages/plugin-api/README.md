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

| Permission                          | Risk    | Calls                                                  |
| ----------------------------------- | ------- | ------------------------------------------------------ |
| none                                |         | `api.version`, `app.locale`, `app.colorMode`           |
| `network:<domain>`, `network:*.<d>` | normal  | `network.fetch` for that host, or any host under `<d>` |
| `sessions.summary`                  | normal  | `sessions.list`                                        |
| `sessions.content`                  | high    | `sessions.read`                                        |
| `sessions.start`                    | high    | `sessions.start`, `sessions.send`                      |
| `tools`, `prompt.attach`            | various | declared now, calls follow                             |
| `requests.check`, `requests.answer` | various | declared now, calls follow                             |

Whatever is granted, a script cannot run commands, read project files, ask for system permissions,
read an agent's or GitHub's credentials, reach another plugin's data or touch Kettu's window.

## Versions

A plugin names the API version it was written for in `api`. Kettu adds calls inside one version and
never changes or removes one; a change that would is a new version, and an older one keeps working
for as long as Kettu lists it.

## Sample

`sample/` is a complete plugin: a manifest and a script that counts the sessions that work and
posts the count to a webhook. `pnpm typecheck` checks its script against `index.d.ts`.
