# Updates

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.5](../milestones/m0.md#work-packages) · Observed on 2026-10-20: `electron-updater` 6.8, electron-builder 26

An app that cannot update itself leaves its users on the version they first installed. OverBench checks for new releases in the background, downloads them, and installs one when the app restarts, so staying current takes one click and never interrupts work. The interface is in [ui.md](./ui.md#updates).

What this design takes from where:

- **VS Code**: the first check 30 s after launch and then every hour, so checking never competes with startup; one state machine that every surface reads; release notes offered once after an update.
- **Zed**: one quiet control that appears only when there is something to do, can be dismissed, and says "Up to date" for a few seconds only after a check you started yourself.
- **electron-updater**: the updater that belongs to electron-builder, which already packages OverBench; it downloads, verifies and installs on all three platforms.
- **Claude Desktop**, as what to avoid: its users report that **Relaunch to update** restarts at once, with no release notes, no way to defer, and the active session lost, and that each background update fires an OS notification. OverBench asks before a restart would stop work, brings everything back after it, links the release notes, and sends no notification.

## Where it runs

The updater lives in main (`src/main/updater.ts`), because installing means quitting the app, which only main can do.

- `electron-updater` is loaded with dynamic `import()` after the window is shown, so startup does not pay for it. Its work is asynchronous network and file I/O and never blocks main.
- The feed is the GitHub Releases of `overbench/overbench`. electron-builder writes it into `app-update.yml` inside the app at build time, and nothing at runtime can change it. It does so only for the `dmg` and `zip`, NSIS and AppImage targets: an unpacked `pnpm package` build has no `app-update.yml`, so its checks fail and are only logged.
- Requests go through electron-updater's own session (`autoUpdater.netSession`). When Settings › Advanced › Proxy is Custom, that session uses the same proxy as the agents, so an update downloads wherever the agents can reach the network; otherwise it follows the system proxy. Chromium takes the proxy as `scheme://host:port`, so a path or credentials in the URL are dropped for updates, and the no-proxy list becomes its bypass rules. The proxy changes as soon as the setting does.
- The updater is off in development (`app.isPackaged` is false) and in builds that cannot update themselves (below).

## Platforms

| Platform | Package                              | Mode    | How the update installs                                                                               |
| -------- | ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------- |
| macOS    | `dmg` and `zip`, Developer ID signed | Install | Squirrel.Mac checks the new bundle's signature and swaps it in on restart                             |
| macOS    | Ad-hoc signed, as M0 builds are      | Link    | Squirrel.Mac refuses apps without a Developer ID, so the update opens the release page to download it |
| Windows  | NSIS, per user                       | Install | The new installer runs silently on restart and starts the app again                                   |
| Linux    | AppImage                             | Install | The AppImage file is replaced and started again                                                       |
| Linux    | Not started from an AppImage         | Off     | Settings › About says that updates come from the package manager                                      |

- **Link** mode checks and tells you like Install mode, but the action opens the release page in the browser, because the app cannot replace itself. Code signing and notarization are planned after M0 ([scope](../milestones/m0.md#out-planned-for-later-milestones)); a signed build switches to Install with no other change.
- The release workflow decides the mode at build time and electron-vite inlines it as a constant, so the app never has to inspect its own signature: `MAIN_VITE_UPDATE_MODE` is `install` or `link`. Without it, macOS builds link and the others install, so a local `pnpm package` behaves like a release; a signed macOS build sets `install`.
- The `zip` target that Squirrel.Mac needs is already in `electron-builder.yml` next to `dmg`.

## Releases

- CI builds every platform on a version tag and uploads the installers with `latest.yml`, `latest-mac.yml` and `latest-linux.yml` to a **draft** release. No client sees it until the maintainer publishes the draft.
- `.github/workflows/release.yml` runs on `v*` tags on macOS, Windows and Linux. It fails unless the tag equals `v` plus the version in `package.json`, runs the tests, builds with `MAIN_VITE_UPDATE_MODE` set per platform (`link` on macOS), and runs `electron-builder --publish always` with the workflow's `GITHUB_TOKEN`. electron-builder's `publish` section (`provider: github`, `owner: overbench`, `repo: overbench`, `releaseType: draft`) names the release and writes `app-update.yml` into the app. Signing identities are not looked up yet (`CSC_IDENTITY_AUTO_DISCOVERY=false`). Linux builds on `ubuntu-24.04`, never `ubuntu-latest`: node-pty 1.1.0 ships no Linux prebuild, so `pnpm install` compiles it on the runner, and a newer Ubuntu would silently raise the glibc the AppImage needs. Moving to a newer one is a decision about which distributions OverBench supports.
- Until a Developer ID signs them, macOS builds are ad-hoc signed without the hardened runtime (`identity: '-'` and `hardenedRuntime: false` in `electron-builder.yml`). A build left unsigned has an invalid bundle signature, which macOS reports as damaged with no way to open it; an ad-hoc signed one is valid, so Gatekeeper offers **Open Anyway** in System Settings › Privacy & Security. The hardened runtime refuses to load the ad-hoc signed Electron framework, whose signature has no Team ID, so it comes back together with the Developer ID.
- Versions are semver. Releases marked as pre-release on GitHub are never offered (`allowPrerelease: false`) and an older version never replaces a newer one (`allowDowngrade: false`). A beta channel comes later.

## Checking and downloading

- The first check runs 30 s after launch, then every hour, as in VS Code; Zed also checks hourly. **Check for updates** in Settings › About, and **Check for Updates…** in the macOS app menu, check at once.
- A check asks github.com for the latest release and reads its small `latest*.yml`; it does not use the rate-limited GitHub API.
- What happens next follows **Automatic updates** in Settings › About:

  | Setting              | Checks          | Downloads                    | Default |
  | -------------------- | --------------- | ---------------------------- | ------- |
  | Download and install | Every hour      | At once, in the background   | ✓       |
  | Notify only          | Every hour      | When you choose **Download** |         |
  | Off                  | Only when asked | When you choose **Download** |         |

- electron-updater downloads only the changed blocks when a blockmap of the installed version is available, and verifies the file's SHA-512 against `latest*.yml` before it counts as ready.
- A failed automatic check or download is logged and retried at the next hourly check; nothing is shown: the state goes back to what it was, `idle` or, after a failed download, `available`. A check or download you started shows its error in Settings › About, reduced to its first line. Starting a check while an automatic one runs joins it and makes its error yours.
- No check runs while an update downloads or is ready, and **Check for updates** then returns the current status.

## States

```ts
type UpdateState =
  | { kind: 'off'; reason: 'development' | 'unsupported' }
  | { kind: 'idle'; checkedAt: number | null } // up to date, or not checked yet
  | { kind: 'checking'; manual: boolean }
  | { kind: 'available'; version: string; mode: 'install' | 'link' } // found, not downloading
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string } // downloaded and verified
  | { kind: 'error'; message: string; manual: boolean }

interface UpdateStatus {
  state: UpdateState
  current: string // the running version
  updatedFrom: string | null // set for the first launch after an update
  dismissed: string | null // the version whose notice was dismissed
}
```

- `available` in Install mode moves to `downloading` by itself when downloads are automatic. In Link mode it is the last state.
- Release notes are the release page, `https://github.com/overbench/overbench/releases/tag/v<version>`, built from the version; nothing from the feed is rendered or followed.
- Only `ready` and Link mode's `available` show a notice outside Settings, and `updatedFrom` shows the one after an update. Checking and downloading stay inside Settings › About, so a background update is invisible until it is ready.

## Restarting

- **Restart** goes through the normal quit path. When agents are working or terminal commands are running, and **Ask before quitting while agents or terminal commands are running** is on, it first asks in an `AlertDialog` that names them, as quitting does. Otherwise it restarts at once.
- Main then stops the agents and flushes pending writes as on every quit ([agent host](./agent-host.md#shutdown)), and calls `quitAndInstall(true, true)`: silently, and starting the new version afterwards. If the app is still running 10 s later, because the installer could not start, it quits anyway, since the hosts have already stopped; the update then installs at the next quit.
- After the restart, the window, the sidebar, the open session and composer drafts come back ([persistence](./persistence.md)), and sessions reload their history with `session/load`. A restart costs a few seconds, not work.
- OverBench never restarts by itself. A ready update that you do not restart for installs when you next quit (`autoInstallOnAppQuit`, Install mode only), unless the system is shutting down: on `powerMonitor`'s `shutdown`, or the window's `session-end` on Windows, the install is skipped, because the system could kill the installer halfway, and it runs at the next quit instead. electron-updater 7 will do this by itself. A signed macOS build hands the download to Squirrel.Mac as soon as it is ready, so there the skip cannot apply. During a system shutdown the quit itself also skips the confirmation, which no one could answer.

## After an update

- Main remembers the last version that ran. On the first launch of a newer one, by semver precedence, `updatedFrom` is set and the update notice reads "Updated to 0.3.0" with **What's new**, for that launch only.
- There is no dialog, no release notes tab and no OS notification.

## Storage

| Key                                 | Where            | Value                                                             |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `updates.automatic`                 | `settings.json`  | `'download' \| 'notify' \| 'off'`, `'download'` by default        |
| `lastRunVersion`, `dismissedUpdate` | `app-state.json` | The last version that ran; the version whose notice you dismissed |

Downloaded updates stay in electron-updater's cache folder, which it cleans after installing.

## Interface contract

Calls from the renderer to main, added as described in [AGENTS.md](../../AGENTS.md#adding-an-ipc-call):

| Channel             | Args | Result         | Notes                                                                                                                                                                          |
| ------------------- | ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `update:get-status` | none | `UpdateStatus` |                                                                                                                                                                                |
| `update:check`      | none | `UpdateStatus` | A manual check                                                                                                                                                                 |
| `update:download`   | none | none           | Only in `available` with Install mode; rejects otherwise, and always in Link mode, where the renderer opens the release page                                                   |
| `update:restart`    | none | none           | Only in `ready`; the renderer has already asked, if it needed to                                                                                                               |
| `update:dismiss`    | none | none           | Hides the current notice until a newer version is found: `dismissed` becomes the version of the `ready` or `available` notice, or the running version for the "Updated to" one |
| `update:changed`    |      |                | Event from main to every window, with `UpdateStatus`                                                                                                                           |

## Security

- The feed is fixed at build time and served over HTTPS. The renderer can only ask to check, download, restart or dismiss; it never passes a URL or a file.
- electron-updater verifies the SHA-512 of the download against `latest*.yml`. Squirrel.Mac additionally requires the new bundle to carry the same signature as the running app. On Windows, a signed build also checks that the installer is signed by the same publisher (`publisherName`); unsigned Windows builds in M0 rely on HTTPS and the checksum alone, until signing lands.
- Release notes are never rendered in the app.
- No downgrades and no pre-releases, as above.

## Alternatives considered

- **Electron's built-in `autoUpdater`**, alone or with update.electronjs.org: it needs Squirrel.Windows instead of NSIS, has no Linux support and reports no download progress. Rejected.
- **Checking the GitHub API and only linking to the download**: no dependency, and it works unsigned everywhere, but every update becomes a manual reinstall. It remains the Link mode for macOS builds without a Developer ID only.
- **A modal dialog or an OS notification when an update is ready**: interrupts work for something that can wait until the next pause. Rejected; the notice stays inside the window.
- **Other places for the notice**: a control at the right end of the top bar, as in Zed; a badge on **Settings**, as in VS Code; a card that rises above the sidebar footer. The footer row won: it uses the place the sign-in notice already has, leaves the top bar to the project, and restarts in one click.
- **Restarting by itself when idle**: an update should never change the app under the user without a choice. Rejected.
