import Foundation

/// Logs go to stderr, which main writes into Kettu's log.
func log(_ text: String) {
  FileHandle.standardError.write(Data("\(text)\n".utf8))
}

/// JSON Lines on stdin and stdout: one message per line, at most `maxLineBytes` each. A longer
/// line is dropped up to its newline. Reaching the end of stdin means main has gone.
final class Channel {
  private let queue: DispatchQueue
  private var buffer = Data()
  private var dropping = false

  init(queue: DispatchQueue) {
    self.queue = queue
  }

  /// Reads stdin on its own thread and hands each line to `onLine` on the queue.
  func start(onLine: @escaping (Data) -> Void, onEnd: @escaping () -> Void) {
    let input = FileHandle.standardInput
    Thread.detachNewThread { [self] in
      while true {
        let chunk = input.availableData
        if chunk.isEmpty {
          queue.async(execute: onEnd)
          return
        }
        for line in split(chunk) { queue.async { onLine(line) } }
      }
    }
  }

  private func split(_ chunk: Data) -> [Data] {
    var lines: [Data] = []
    var rest = chunk[...]
    while let newline = rest.firstIndex(of: 0x0A) {
      let part = rest[rest.startIndex..<newline]
      rest = rest[rest.index(after: newline)...]
      if dropping {
        dropping = false
        continue
      }
      if buffer.count + part.count > maxLineBytes {
        log("Dropped a line longer than \(maxLineBytes) bytes")
        buffer.removeAll()
        continue
      }
      buffer.append(part)
      if !buffer.isEmpty { lines.append(buffer) }
      buffer = Data()
    }
    if dropping { return lines }
    if buffer.count + rest.count > maxLineBytes {
      log("Dropped a line longer than \(maxLineBytes) bytes")
      buffer.removeAll()
      dropping = true
    } else {
      buffer.append(rest)
    }
    return lines
  }

  /// Writes a message as one line; call on the queue.
  func send(_ message: HelperMessage) {
    guard
      let data = try? JSONSerialization.data(withJSONObject: message.json, options: [])
    else {
      log("Could not encode a message")
      return
    }
    FileHandle.standardOutput.write(data + Data([0x0A]))
  }
}
