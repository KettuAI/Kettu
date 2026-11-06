# kettu-ios-usb-capture

A macOS command-line helper that shows the screen of an iPhone or iPad connected over USB, the way
QuickTime does. It sets the CoreMediaIO property `kCMIOHardwarePropertyAllowScreenCaptureDevices`,
after which the device appears as a muxed `AVCaptureDevice` whose `uniqueID` is its UDID (compared
without case or dashes). It captures the video, encodes it to H.264 with VideoToolbox (real time, no
B-frames, a keyframe at least every 2 s, about 6 Mbps, High profile or else Main) and writes it to
stdout. It works on every iOS version, so it serves the versions before 27. It sends no input; that
goes through the XCTest runner.

```sh
kettu-ios-usb-capture list                  # [{"udid":"...","name":"..."}], or []
kettu-ios-usb-capture stream --udid <UDID>  # framed messages until stdin closes
```

`list` prints the screen capture devices seen within 2 s. `stream` waits up to 5 s for the device,
streams until stdin reaches EOF, then exits 0; the host must keep stdin open as a pipe. Logs go to
stderr. Enabling the property can itself block for up to about 5 s while macOS loads its iOS screen
capture plug-in, before either wait starts.

## Framing

Every message in both directions is a 4-byte big-endian length L, then L bytes: a tag byte and the
payload. stdout carries nothing else.

| Tag    | Direction      | Payload                                                                                                   |
| ------ | -------------- | --------------------------------------------------------------------------------------------------------- |
| `0x01` | helper to host | avcC (AVCDecoderConfigurationRecord), before the first keyframe and whenever it changes                   |
| `0x02` | helper to host | A keyframe: one access unit as 4-byte length-prefixed NAL units                                           |
| `0x03` | helper to host | A delta frame, in the same form                                                                           |
| `0x10` | helper to host | `{"type":"screen","width":W,"height":H,"codec":"avc1.PPCCLL","orientation":"portrait"\|"landscape_left"}` |
| `0x11` | helper to host | `{"type":"ready"}`, `{"type":"input","available":false}`, or `{"type":"error","code":...,"message":...}`  |
| `0x08` | host to helper | `{"type":"keyframe"}`: the next frame is a keyframe                                                       |

A screen message comes before the description and keyframe it applies to, whenever the size or codec
changes, as when the device rotates. The error codes are `no-device`, `capture`, `encoder`,
`permission` and `internal`; an error is the last message, and the helper then exits 1. The helper
ignores every other tag from the host.

Latency stays low by dropping frames instead of queueing them. A frame is dropped when two are already
in the encoder. When two frames already wait for stdout, deltas are dropped until the next keyframe,
which is asked for once the reader catches up. A keyframe request on a still screen, which may send no
frames, encodes the last frame again.

## Building

```sh
node native/ios-usb-capture/build.mjs <destination directory>
```

It compiles `Sources/*.swift` with `swiftc -O` for this Mac's architecture, for macOS 13 and later,
and copies `kettu-ios-usb-capture` into the destination. It needs Xcode or the Command Line Tools,
and does nothing on other platforms.

## Permissions

macOS counts the helper's capture against the app that started it: Kettu, or the terminal in
development. That app's Info.plist carries `NSCameraUsageDescription` and
`NSMicrophoneUsageDescription`. Under the hardened runtime, it also needs the
`com.apple.security.device.camera` and `com.apple.security.device.audio-input` entitlements, and the
helper should be signed with them. The helper has no Info.plist or entitlements of its own. It asks
for no permission itself. It logs the camera and microphone authorization, and reports `permission`
when AVFoundation refuses the device.
