# kettu-island

The macOS helper behind the Dynamic Island. Kettu's main process starts it as a child once the first
window shows, while Settings › Notifications › Dynamic Island is on, and talks to it over
its standard input and output. Main builds the whole view, every word included; the helper only keeps
it and sends back what the user did. It reads no files, opens no sockets, uses no network and asks
for no system permission. Reaching the end of stdin, as when Kettu quits or crashes, makes it exit.

This first version draws nothing yet: it keeps the view in step, answers and opens through main,
and logs to stderr, which main writes into Kettu's log. While it runs, main sends no notifications
of the kinds the island shows, so until the island draws them, they show nowhere; they come back
only when the island is turned off or stops after repeated crashes.

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
`expanded` after the first view. A packaged Kettu passes nothing on.

## Building

`build.mjs` compiles `Sources/*.swift` with `swiftc -O` for this Mac's architecture, for macOS 13 and
later, and copies `kettu-island` into the destination. It needs Xcode or the Command Line Tools and
does nothing on other platforms. `tools/install/device-helpers.mjs`, which the release run calls,
builds it with the other helpers.
