import Foundation

/// The tags of the stdio framing: every message is a 4-byte big-endian length, then that many bytes,
/// of which the first is the tag and the rest the payload.
enum Tag {
  static let description: UInt8 = 0x01
  static let keyframe: UInt8 = 0x02
  static let delta: UInt8 = 0x03
  static let keyframeRequest: UInt8 = 0x08
  static let screen: UInt8 = 0x10
  static let status: UInt8 = 0x11
}

/// stdout carries only framed messages, so everything else goes to stderr.
func log(_ message: String) {
  fputs("kettu-ios-usb-capture: \(message)\n", stderr)
}

/// Callers pass only strings, numbers, booleans, arrays and dictionaries, which always serialize.
func json(_ object: Any) -> Data {
  try! JSONSerialization.data(withJSONObject: object)
}

func framed(tag: UInt8, payload: Data) -> Data {
  let length = UInt32(1 + payload.count)
  var bytes = Data(capacity: 5 + payload.count)
  bytes.append(contentsOf: [
    UInt8(truncatingIfNeeded: length >> 24), UInt8(truncatingIfNeeded: length >> 16),
    UInt8(truncatingIfNeeded: length >> 8), UInt8(truncatingIfNeeded: length), tag,
  ])
  bytes.append(payload)
  return bytes
}

extension NSLock {
  func locked<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}

/// Writes framed messages to stdout on a thread of its own, so a slow reader never blocks capture or
/// encoding. Once the reader falls behind, video is dropped instead of queued.
final class FrameWriter {
  private struct Message {
    let bytes: Data
    let isVideo: Bool
  }

  /// About 33 ms at 60 frames per second.
  private static let maxQueuedVideo = 2

  private let condition = NSCondition()
  private var queue: [Message] = []
  private var writing = false
  private var closed = false
  private var awaitingKeyframe = false
  private var keyframeRequested = false

  /// Called once the reader has caught up after dropped video, which leaves it without a decodable
  /// picture until the next keyframe.
  var onKeyframeNeeded: (() -> Void)?
  /// Called once when stdout can no longer be written, which means the host is gone.
  var onStdoutClosed: (() -> Void)?

  func start() {
    let thread = Thread { [self] in run() }
    thread.name = "stdout"
    thread.start()
  }

  func send(tag: UInt8, payload: Data) {
    condition.lock()
    defer { condition.unlock() }
    guard !closed else { return }
    queue.append(Message(bytes: framed(tag: tag, payload: payload), isVideo: false))
    condition.broadcast()
  }

  func sendStatus(_ status: [String: Any]) {
    send(tag: Tag.status, payload: json(status))
  }

  /// Queues one access unit, or drops it when the reader is behind.
  func sendVideo(_ accessUnit: Data, keyframe: Bool) {
    condition.lock()
    defer { condition.unlock() }
    guard !closed else { return }
    let queuedVideo = queue.reduce(0) { $0 + ($1.isVideo ? 1 : 0) }
    if keyframe {
      // A keyframe needs nothing before it, so it replaces the video still waiting.
      if queuedVideo >= Self.maxQueuedVideo { queue.removeAll { $0.isVideo } }
      awaitingKeyframe = false
      keyframeRequested = false
      queue.append(Message(bytes: framed(tag: Tag.keyframe, payload: accessUnit), isVideo: true))
      condition.broadcast()
    } else if awaitingKeyframe || queuedVideo >= Self.maxQueuedVideo {
      // Each delta refers to the frames before it, so after one is dropped nothing decodes until the
      // next keyframe. That is asked for only once the reader catches up, since a keyframe is many
      // times larger than a delta.
      if !awaitingKeyframe {
        awaitingKeyframe = true
        log("stdout is behind; dropping video until the next keyframe")
      }
    } else {
      queue.append(Message(bytes: framed(tag: Tag.delta, payload: accessUnit), isVideo: true))
      condition.broadcast()
    }
  }

  /// Queues a last status message, if any, and refuses every message after it.
  func close(with status: [String: Any]?) {
    condition.lock()
    defer { condition.unlock() }
    guard !closed else { return }
    if let status {
      queue.append(Message(bytes: framed(tag: Tag.status, payload: json(status)), isVideo: false))
    }
    closed = true
    condition.broadcast()
  }

  /// Waits until everything queued is written, or the timeout passes.
  func drain(timeout: TimeInterval) {
    let deadline = Date(timeIntervalSinceNow: timeout)
    condition.lock()
    defer { condition.unlock() }
    while !queue.isEmpty || writing {
      if !condition.wait(until: deadline) { return }
    }
  }

  private func run() {
    while true {
      condition.lock()
      while queue.isEmpty { condition.wait() }
      let message = queue.removeFirst()
      writing = true
      condition.unlock()

      let written = Self.writeAll(message.bytes)

      condition.lock()
      writing = false
      if !written {
        closed = true
        queue.removeAll()
      }
      let caughtUp = awaitingKeyframe && !keyframeRequested && !queue.contains { $0.isVideo }
      if caughtUp { keyframeRequested = true }
      condition.broadcast()
      condition.unlock()
      if !written {
        onStdoutClosed?()
        return
      }
      if caughtUp { onKeyframeNeeded?() }
    }
  }

  private static func writeAll(_ bytes: Data) -> Bool {
    bytes.withUnsafeBytes { raw in
      guard var pointer = raw.baseAddress else { return true }
      var remaining = raw.count
      while remaining > 0 {
        let count = write(STDOUT_FILENO, pointer, remaining)
        if count < 0 {
          if errno == EINTR { continue }
          log("writing stdout failed: \(String(cString: strerror(errno)))")
          return false
        }
        pointer += count
        remaining -= count
      }
      return true
    }
  }
}

/// Reads the host's framed messages from stdin on a thread of its own until stdin closes.
func readHostMessages(onKeyframeRequest: @escaping () -> Void, onEnd: @escaping () -> Void) {
  // Larger messages are skipped unread; the host sends only small JSON.
  let maxMessage = 1 << 16
  let thread = Thread {
    while let header = readStdin(count: 4) {
      let length = header.reduce(0) { $0 << 8 | Int($1) }
      if length == 0 { continue }
      if length > maxMessage {
        guard skipStdin(count: length) else { break }
        continue
      }
      guard let message = readStdin(count: length) else { break }
      if message.first == Tag.keyframeRequest,
        let body = try? JSONSerialization.jsonObject(with: message.dropFirst()) as? [String: Any],
        body["type"] as? String == "keyframe"
      {
        onKeyframeRequest()
      }
    }
    onEnd()
  }
  thread.name = "stdin"
  thread.start()
}

/// Returns nil once stdin ends, including in the middle of the requested bytes.
private func readStdin(count: Int) -> Data? {
  var data = Data(count: count)
  var offset = 0
  while offset < count {
    let read = data.withUnsafeMutableBytes { raw in
      Darwin.read(STDIN_FILENO, raw.baseAddress! + offset, count - offset)
    }
    if read < 0 && errno == EINTR { continue }
    if read <= 0 { return nil }
    offset += read
  }
  return data
}

private func skipStdin(count: Int) -> Bool {
  var remaining = count
  while remaining > 0 {
    guard let chunk = readStdin(count: min(remaining, 1 << 16)) else { return false }
    remaining -= chunk.count
  }
  return true
}
