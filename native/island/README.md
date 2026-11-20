# kettu-island

The macOS helper behind the Dynamic Island. Kettu's main process starts it as a child once the first
window shows, while Settings › Notifications › Dynamic Island is on, and talks to it over
its standard input and output. Main builds the whole view, every word included; the helper only keeps
it and sends back what the user did. It reads no files, opens no sockets, uses no network and asks
for no system permission. Reaching the end of stdin, as when Kettu quits or crashes, makes it exit.

It draws the island in the notch of the screen whose menu bar is in use, or, on a screen without a
notch, a floating island just under the menu bar:

- **Collapsed**: nothing while nothing needs a mark. Otherwise up to three stacked agent marks of the
  most urgent group, waiting, failed and not yet seen, running, or held by a plan limit, and that
  group's signal: the waiting dot, the error alert, the turn's nine dots (a clock once every
  running call is stuck) or the limit ring, with a count or the reset day.
- **Grown**: main's pops, one at a time, for 6 seconds (4 for a finished turn).
- **Expanded**, after 250 ms of hover or a click: the oldest request with its options as buttons,
  then the rows under the menu bar panel's groups. A click opens a row; the bare top opens Kettu.
  An island opened by a click takes the keyboard: Esc, the arrows, Return and the digits.

AppKit draws the agent marks from SVG, which `generate.mjs` renders at build time from the
renderer's mark components in the dark theme, with the tokens the signals use. The window is a
non-activating panel above the menu bar that lets clicks through outside the island, and a hidden
island leaves the window list. While it runs, main sends no notifications of the kinds it shows;
they come back only when the island is turned off or stops after repeated crashes.

```sh
node native/island/build.mjs out/helpers   # what a development run of Kettu starts
```

## Messages

Every message is one line of UTF-8 JSON, at most 1 MiB; main drops longer or malformed lines from the
helper and starts it again after several in a row. `src/main/island/protocol.ts` defines both sides.

| Direction      | `type`       | Carries                                                                                                                                             |
| -------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| main to helper | `hello`      | `protocol`, Kettu's `version`, `locale`, `strings`, `colorMode`, `stuckAfterMs`                                                                     |
| main to helper | `view`       | `seq`, `rows` in the order to show, `requests` oldest first, `summary`                                                                              |
| main to helper | `change`     | `seq`, changed `rows` and `requests`, `removedRows`, `removedRequests`, new `order` and `requestOrder` when they changed, `summary` when it changed |
| main to helper | `pop`        | `row` or null, `kind`, `title`, `body`: something needs the user                                                                                    |
| main to helper | `answered`   | the answer's `id`; `result` `answered`, `elsewhere` or `failed` with `message`                                                                      |
| main to helper | `strings`    | `locale` and `strings`, followed by a `view`                                                                                                        |
| main to helper | `appearance` | `colorMode`                                                                                                                                         |
| main to helper | `quit`       | nothing; main ends the helper a second later if it is still there                                                                                   |
| helper to main | `ready`      | `protocol`, the helper's `version`                                                                                                                  |
| helper to main | `answer`     | its own `id`, a `request` key and an `option` id main sent                                                                                          |
| helper to main | `open`       | a `row` key, or null for Kettu itself                                                                                                               |
| helper to main | `expanded`   | nothing; main has the agents read their plan limits, at most once a minute                                                                          |
| helper to main | `resync`     | nothing; main sends a whole `view`                                                                                                                  |

A `change` whose `seq` does not follow the last one means one was lost: the helper sends `resync`.

## Development

A development run of Kettu passes `KETTU_ISLAND_DEBUG` on to the helper, a comma-separated list:
`log` logs every row and request after each message, `answer=allow_once` answers each new request once with its
first option of that style, through the same message a click would send, and `expand` sends one
`expanded` after the first view. `notch` keeps the island on the screen with the notch whichever
display is in use, and `floating` draws the floating island even there. `drive` lets a test script
on the helper's stdin send `{ "type": "debug", "kind": ... }` with `expand`, `click`, `collapse` or
`answer`. A packaged Kettu passes nothing on.

## Building

`build.mjs` compiles `Sources/*.swift`, with the Swift source `generate.mjs` writes, using `swiftc -O`
for this Mac's architecture, for macOS 13 and later, and copies `kettu-island` into the
destination. It needs Xcode or the Command Line Tools and the repository's packages, and does nothing
on other platforms. `tools/install/device-helpers.mjs`, which the release run calls,
builds it with the other helpers.
