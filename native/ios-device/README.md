# kettu-ios-device

A macOS command-line helper that streams the screen of a physical iPhone or iPad running iOS 27 or later and injects touch, keyboard and hardware-button input. It uses the device's CoreDevice display service (`com.apple.coredevice.displayservice`) and its HID services, reached through a userspace tunnel over usbmuxd, so it needs no root. It is built on [idevice](https://github.com/jkcoxson/idevice) (MIT). Kettu's device host spawns it and talks to it over stdio.

The device must be paired with the Mac, have Developer Mode on and the developer disk image mounted (`xcrun devicectl device info ddiServices --device <UDID>` mounts it).

## Commands

- `kettu-ios-device list` prints a JSON array of the devices usbmuxd sees: `[{"udid", "name", "productVersion", "connection": "usb" | "network"}]`. `name` and `productVersion` are `null` when the device does not tell; the array is empty when there are none.
- `kettu-ios-device stream --udid <UDID>` starts the stream and speaks the framing below until stdin closes, then stops the stream and exits 0. Logs go to stderr.

## Framing

Each message in either direction is a 4-byte big-endian length `L`, then `L` bytes: a tag byte and its payload.

From the helper, on stdout:

| Tag    | Payload                                                                                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x01` | The decoder configuration record, `avcC` for H.264 or `hvcC` for HEVC, before the first keyframe and whenever it changes                                                                                                                      |
| `0x02` | A keyframe: one access unit, each NAL unit prefixed with its 4-byte big-endian length, parameter sets left out                                                                                                                                |
| `0x03` | A delta frame, laid out the same way                                                                                                                                                                                                          |
| `0x10` | `{"type":"screen","width","height","codec","orientation"}`, whenever the size, codec or orientation changes; `codec` is the WebCodecs string and `orientation` one of `portrait`, `portrait_upside_down`, `landscape_left`, `landscape_right` |
| `0x11` | `{"type":"ready"}`, `{"type":"input","available"}`, or `{"type":"error","code","message"}`, after which the helper exits non-zero                                                                                                             |

Error codes: `no-device`, `unsupported-ios`, `developer-mode-off`, `ddi-not-mounted`, `not-paired`, `camera-in-use`, `tunnel`, `stream`, `internal`.

From the host, on stdin:

| Tag    | Payload                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `0x03` | `{"type":"begin"\|"move"\|"end","x","y","id"}`: a touch, `x` and `y` from 0 to 1 across the frame, up to five fingers by `id` 0 to 4 |
| `0x04` | `{"button":"home"\|"lock"\|"volumeUp"\|"volumeDown"\|"siri"}`: a press and release                                                   |
| `0x06` | `{"type":"down"\|"up","usage"}`: a key by its HID keyboard usage (page 7)                                                            |
| `0x08` | `{"type":"keyframe"}`: asks for a new keyframe; delta frames are held back until it arrives                                          |

Access units are never buffered beyond one waiting to be written: when the reader falls behind, frames are dropped and the stream resumes at the next keyframe.

## Building

Rust (stable, edition 2024) is needed. `node native/ios-device/build.mjs <directory>` runs `cargo build --release --locked` for the Mac's architecture and copies the binary into the directory; on other platforms it does nothing. `cargo test` runs the unit tests.
