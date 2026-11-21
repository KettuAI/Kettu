# kettu-island

The macOS helper behind the Dynamic Island. Kettu's main process starts it as a child once the first
window shows, while Settings › Notifications › Dynamic Island is on, and talks to it over
its standard input and output. Main builds the whole view, every word included; the helper only keeps
it and sends back what the user did. It reads no files, opens no sockets, uses no network and asks
for no system permission. Reaching the end of stdin, as when Kettu quits or crashes, makes it exit.

It draws the island at the top middle of the screen whose menu bar is in use: in the notch, or on a
screen without one, in the middle of the menu bar, growing down from the top as from a notch. It
shows while it is on:

- **Collapsed**, while something needs a mark: one signal and one fact. On the left the agent marks
  of the most urgent group, waiting, failed, running, done, or held by a plan limit; on the right
  that group's signal (the waiting dot, the error alert, the turn's nine dots acting out its phase
  as the thread's do, a clock once every running call is stuck, the unread dot, the limit ring) and
  a count past one, the running session's plan, the minutes stuck or the reset day. Without a notch,
  the same outline, with the title of the session it is about in the middle. Failed and done rows
  mark it until they are read in Kettu or the island is opened, a used-up limit until the island is
  opened, once per window.
- **At rest**, with nothing to mark, the island shrinks back into the notch and draws nothing. The
  pointer resting on the notch, or a click on it, still opens it; without a notch nothing is left,
  and the menu bar icon shows the sessions.
- **Grown**: main's pops, one at a time, for 6 seconds (2 for a finished turn), unless a Kettu window
  in front shows that session: the marks in the
  left wing and the state in the right, the session and what happened under them. A request is no
  pop: it opens the island at its card, without the keyboard, and the island stays open until the
  last request is answered or a click elsewhere dismisses it.
- **Expanded**, once the pointer rests on it for 120 ms and moves slower than 1.2 pt per ms, or on a
  click, and closed 400 ms after the pointer leaves. While a request waits, the panel is that card
  alone, its permission answers always Deny, Allow once and Always allow, Kettu's own tools named as
  the thread names them; answered, its word shows for 1.2 s, then the next card or the list. The
  list is the sessions as the sidebar draws them, the agent's mark, the title and the project, and
  one status at the end. Up to four sessions, each row has a second line: what it is doing or what
  came of it in its state's color, and the plan's progress or a time on its right; with more, every
  row keeps one line with only that progress or time, six of them with the rest folded into one
  line. A session whose sub-agents are at work, starting, running or waiting for an answer, shows
  the sidebar's badge before the progress: a bot, how many and a spinner. Under them, after a
  hairline, up to three notices: Kettu's update, the agents' updates and the tightest plan limit,
  each one line with a button that acts in place or a link into Kettu.
  Then New session and Open Kettu. The panel is laid out unseen first, so the outline grows to its height in one critically
  damped spring. A click opens a row; the bare top opens Kettu. An island opened by a click takes
  the keyboard: Esc, the arrows, Return and the digits.

AppKit draws the agent marks from SVG, which `generate.mjs` renders at build time from the
renderer's mark components in the dark theme, with the tokens the signals use. Marks with filters or
masks, which CoreSVG does not draw, and the icon's fox, whose filters take CoreSVG about 140 ms, come
as PNG instead, drawn by Chromium through `rasterize.mjs` in the repository's Electron. One mark is
drawn off the main thread at launch, since CoreSVG's first drawing takes about 45 ms. Turned off, the
island shrinks back into the notch before the helper ends. The window is a
non-activating panel above the menu bar that lets clicks through outside the island, and a hidden
island leaves the window list. While it runs, main sends no notifications of the kinds it shows;
they come back only when the island is turned off or stops after repeated crashes.

```sh
node native/island/build.mjs out/helpers   # what a development run of Kettu starts
```

## Messages

Every message is one line of UTF-8 JSON, at most 1 MiB; main drops longer or malformed lines from the
helper and starts it again after several in a row. `src/main/island/protocol.ts` defines both sides.

| Direction      | `type`        | Carries                                                                                                                                                                      |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main to helper | `hello`       | `protocol`, Kettu's `version`, `locale`, `strings`, `colorMode`, `stuckAfterMs`                                                                                              |
| main to helper | `view`        | `seq`, `rows` in the order to show, `requests` oldest first, `notices`, `summary`, `focus`                                                                                   |
| main to helper | `change`      | `seq`, changed `rows` and `requests`, `removedRows`, `removedRequests`, new `order` and `requestOrder` when they changed, `notices` and `summary` when they changed, `focus` |
| main to helper | `pop`         | `row` or null, `kind`, `title`, `body`; without a row, the `mark`, a limit's `percent` and the `action` a click sends back                                                   |
| main to helper | `answered`    | the answer's `id`; `result` `answered`, `elsewhere` or `failed` with `message`                                                                                               |
| main to helper | `strings`     | `locale` and `strings`, followed by a `view`                                                                                                                                 |
| main to helper | `appearance`  | `colorMode`                                                                                                                                                                  |
| main to helper | `quit`        | nothing; main ends the helper a second later if it is still there                                                                                                            |
| helper to main | `ready`       | `protocol`, the helper's `version`                                                                                                                                           |
| helper to main | `answer`      | its own `id`, a `request` key and an `option` id main sent                                                                                                                   |
| helper to main | `open`        | a `row` key, or null for Kettu itself                                                                                                                                        |
| helper to main | `openRequest` | a `request` key main sent: its session or its task opens in Kettu                                                                                                            |
| helper to main | `notice`      | a notice's key or a pop's `action` main sent: main acts on it                                                                                                                |
| helper to main | `newSession`  | nothing; Kettu opens New session                                                                                                                                             |
| helper to main | `expanded`    | nothing; main has the agents read their plan limits, at most once a minute                                                                                                   |
| helper to main | `resync`      | nothing; main sends a whole `view`                                                                                                                                           |

A `change` whose `seq` does not follow the last one means one was lost: the helper sends `resync`.

## Development

A development run of Kettu passes `KETTU_ISLAND_DEBUG` on to the helper, a comma-separated list:
`log` logs every row and request after each message, `answer=allow_once` answers each new request once with its
first option of that style, through the same message a click would send, and `expand` sends one
`expanded` after the first view. `notch` keeps the island on the screen with the notch whichever
display is in use, and `floating` draws the island there as on a screen without a notch. `drive` lets a test script
on the helper's stdin send `{ "type": "debug", "kind": ... }` with `expand`, `click`, `collapse` or
`answer`. A packaged Kettu passes nothing on.

## Building

`build.mjs` compiles `Sources/*.swift`, with the Swift source `generate.mjs` writes, using `swiftc -O`
for this Mac's architecture, for macOS 13 and later, and copies `kettu-island` into the
destination. It needs Xcode or the Command Line Tools and the repository's packages, Electron
included, and does nothing on other platforms. `tools/install/device-helpers.mjs`, which the release run calls,
builds it with the other helpers.
